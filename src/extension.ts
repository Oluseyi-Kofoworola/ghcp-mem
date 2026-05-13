import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fsSync from 'fs';
import { SessionCapture } from './sessionCapture';
import { ContextCompressor } from './contextCompressor';
import { ContextStore } from './contextStore';
import { ContextProvider } from './contextProvider';
import { SessionsTreeProvider, TreeNode } from './sessionsView';
import { MemorySearchTool, MemoryStoreTool } from './memoryTool';
import { getEmbedder } from './embeddings';
import { captureAzureContext } from './azureContext';
import { getConfig, CompressedSession, AzureContextMeta, SessionEvent } from './types';
import { computeHealth, formatHealthMarkdown, fillGlyph } from './health';
import { buildPack, parsePack, importPack, uninstallPack, listInstalledPacks, PACK_TAG_PREFIX } from './packs';
import { AutosaveTrigger } from './autosave';

let capture: SessionCapture;
let compressor: ContextCompressor;
let store: ContextStore;
let provider: ContextProvider;
let tree: SessionsTreeProvider;
let compressionTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem;
let autosave: AutosaveTrigger | undefined;
/** File where we stash drained events on shutdown so the next activation can recover. */
let recoveryFile: vscode.Uri | undefined;
/** Promise that the (best-effort) shutdown compress is tracked through, so deactivate() can await it. */
let shutdownCompress: Promise<void> | undefined;

export function activate(context: vscode.ExtensionContext) {
  const config = getConfig();
  if (!config.enabled) {
    console.log('[GHCP-MEM] Disabled via settings.');
    return;
  }

  const backupDir = vscode.Uri.joinPath(context.globalStorageUri, 'backups');
  recoveryFile = vscode.Uri.joinPath(context.globalStorageUri, 'pending-events.json');
  store = new ContextStore(context.globalState, backupDir);
  compressor = new ContextCompressor();
  capture = new SessionCapture();
  provider = new ContextProvider(store);
  tree = new SessionsTreeProvider(store);

  capture.start();
  provider.register();

  // Recover any events left behind by an unclean shutdown of a previous
  // session. We deliberately re-inject before user activity starts so the
  // next compression pass naturally includes them, and we delete the
  // recovery file even on parse error to avoid an infinite-restore loop.
  void restorePendingEvents();

  vscode.window.registerTreeDataProvider('ghcpMem.sessionsView', tree);

  // Register the Language Model Tools so Copilot agent mode can auto-invoke memory search + store.
  context.subscriptions.push(
    vscode.lm.registerTool('ghcpMem_search', new MemorySearchTool(store)),
    vscode.lm.registerTool('ghcpMem_store', new MemoryStoreTool(store)),
  );

  // Feature-detect the embeddings API (proposed). Safe no-op when unavailable.
  getEmbedder().then(fn => {
    if (fn) {
      store.setEmbedder(fn);
      console.log('[GHCP-MEM] Embedding-based hybrid search enabled.');
    }
  }).catch(() => {});

  startCompressionTimer(config.compressionIntervalMinutes);

  // Context-pressure autosave — flushes when either event count or wall-clock
  // threshold is exceeded, so we never lose an unfinished session to an IDE
  // crash or reload.
  const cfg = vscode.workspace.getConfiguration('ghcpMem');
  const autoEnabled = cfg.get<boolean>('autosave.enabled', true);
  if (autoEnabled) {
    autosave = new AutosaveTrigger({
      eventThreshold: cfg.get<number>('autosave.eventThreshold', 40),
      minutesThreshold: cfg.get<number>('autosave.minutesThreshold', 20),
      getEventCount: () => capture.eventCount,
      onTrigger: async () => { await compressAndStore(); },
    });
    autosave.start();
  }

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBarItem.text = '$(history) MEM';
  statusBarItem.tooltip = 'GHCP-MEM — Click to capture snapshot';
  statusBarItem.command = 'ghcpMem.captureSnapshot';
  statusBarItem.show();
  updateStatusBar();

  context.subscriptions.push(
    vscode.commands.registerCommand('ghcpMem.captureSnapshot', async () => {
      await compressAndStore();
      vscode.window.showInformationMessage('GHCP-MEM: Snapshot captured.');
    }),

    vscode.commands.registerCommand('ghcpMem.showContext', async () => {
      const stats = store.getStats();
      const recent = store.getRecentSessions(5);
      const doc = await vscode.workspace.openTextDocument({
        content: formatReport(stats, recent),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('ghcpMem.clearMemory', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Clear ALL stored session context? This cannot be undone.',
        { modal: true },
        'Clear All'
      );
      if (answer === 'Clear All') {
        await store.clear();
        vscode.window.showInformationMessage('GHCP-MEM: Cleared.');
        updateStatusBar();
      }
    }),

    vscode.commands.registerCommand('ghcpMem.compressNow', async () => {
      const eventCount = capture.eventCount;
      if (eventCount === 0) {
        vscode.window.showInformationMessage('GHCP-MEM: No events to compress.');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `GHCP-MEM: Compressing ${eventCount} events...`, cancellable: false },
        async () => { await compressAndStore(); }
      );
      vscode.window.showInformationMessage('GHCP-MEM: Compression complete.');
    }),

    vscode.commands.registerCommand('ghcpMem.exportMemory', async () => {
      const target = await vscode.window.showSaveDialog({
        filters: { JSON: ['json'] },
        defaultUri: vscode.Uri.file('ghcp-mem-export.json'),
      });
      if (!target) return;
      const json = await store.exportToJson();
      await vscode.workspace.fs.writeFile(target, Buffer.from(json, 'utf-8'));
      vscode.window.showInformationMessage(`GHCP-MEM: Exported to ${target.fsPath}`);
    }),

    vscode.commands.registerCommand('ghcpMem.importMemory', async () => {
      const picks = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ['json'] },
      });
      if (!picks?.length) return;
      const bytes = await vscode.workspace.fs.readFile(picks[0]);
      try {
        const result = await store.importFromJson(Buffer.from(bytes).toString('utf-8'), true);
        vscode.window.showInformationMessage(`GHCP-MEM: Imported ${result.imported} session(s).`);
        updateStatusBar();
      } catch (err) {
        vscode.window.showErrorMessage(`GHCP-MEM: Import failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('ghcpMem.deleteSession', async (node?: TreeNode) => {
      const id = await pickSessionId(node);
      if (!id) return;
      const answer = await vscode.window.showWarningMessage(
        `Delete session ${id.substring(0, 8)}?`,
        { modal: true },
        'Delete'
      );
      if (answer !== 'Delete') return;
      await store.deleteSession(id);
      updateStatusBar();
    }),

    vscode.commands.registerCommand('ghcpMem.tagSession', async (node?: TreeNode) => {
      const id = await pickSessionId(node);
      if (!id) return;
      const tag = await vscode.window.showInputBox({
        prompt: 'Tag to add to this session',
        placeHolder: 'e.g. wip, migration, important',
      });
      if (!tag) return;
      await store.addTag(id, tag.trim());
    }),

    vscode.commands.registerCommand('ghcpMem.openSession', async (id?: string) => {
      if (!id) return;
      const s = store.getById(id);
      if (!s) return;
      const doc = await vscode.workspace.openTextDocument({
        content: formatSessionDetail(s),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('ghcpMem.refreshView', () => tree.refresh()),

    vscode.commands.registerCommand('ghcpMem.restoreBackup', async () => {
      const backups = await store.listBackups();
      if (backups.length === 0) {
        vscode.window.showInformationMessage('GHCP-MEM: No backups available yet.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        backups.map(b => ({ label: b.name, description: b.uri.fsPath, uri: b.uri })),
        { placeHolder: 'Select a backup to restore (will replace current memory)' }
      );
      if (!pick) return;
      const answer = await vscode.window.showWarningMessage(
        `Restore from ${pick.label}? This will replace all current memory.`,
        { modal: true },
        'Restore'
      );
      if (answer !== 'Restore') return;
      try {
        const n = await store.restoreFromBackup(pick.uri);
        vscode.window.showInformationMessage(`GHCP-MEM: Restored ${n} session(s).`);
        updateStatusBar();
      } catch (err) {
        vscode.window.showErrorMessage(`GHCP-MEM: Restore failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('ghcpMem.injectContextIntoChat', async () => {
      const query = await vscode.window.showInputBox({
        prompt: 'What are you about to work on? (Fetches matching memory and opens Copilot Chat.)',
        placeHolder: 'e.g., "rate limiter" or leave empty for recent workspace sessions',
      });
      if (query === undefined) return;

      const results = query.trim()
        ? await store.searchWithEmbedding(query, { workspaceOnly: true }, 5)
        : store.getRecentSessions(5);

      if (results.length === 0) {
        vscode.window.showInformationMessage('GHCP-MEM: No matching memory found.');
        return;
      }

      const lines: string[] = [
        '# Relevant GHCP-MEM context',
        '',
        `Query: ${query || '(recent sessions)'}`,
        '',
      ];
      for (const s of results) {
        const date = new Date(s.endTime).toISOString().slice(0, 10);
        lines.push(`## ${date} — ${s.observationType} (${s.id.substring(0, 8)})`);
        lines.push(s.summary);
        if (s.keyFiles.length) lines.push(`**Files:** ${s.keyFiles.slice(0, 5).join(', ')}`);
        if (s.decisions.length) lines.push(`**Decisions:** ${s.decisions.slice(0, 3).join('; ')}`);
        if (s.problemsSolved.length) lines.push(`**Solved:** ${s.problemsSolved.slice(0, 3).join('; ')}`);
        lines.push('');
      }
      const blob = lines.join('\n');
      await vscode.env.clipboard.writeText(blob);
      vscode.window.showInformationMessage(`GHCP-MEM: Copied ${results.length} memory entries to clipboard. Paste into Copilot Chat.`);
      try { await vscode.commands.executeCommand('workbench.action.chat.open'); } catch { /* ignore */ }
    }),

    vscode.commands.registerCommand('ghcpMem.captureAzureContext', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GHCP-MEM: Snapshotting Azure context…' },
        async () => {
          const rgPick = await vscode.window.showInputBox({
            prompt: 'Resource group to inventory (optional, leave empty to use az default)',
            placeHolder: 'my-rg',
          });
          const ctx = await captureAzureContext({ includeResources: true, resourceGroup: rgPick?.trim() || undefined });
          if (!ctx.subscriptionId && ctx.notes) {
            vscode.window.showWarningMessage(`GHCP-MEM: ${ctx.notes}. Install az CLI and run "az login" first.`);
            return;
          }
          const meta: AzureContextMeta = { ...ctx, subsystems: ['cli'] };
          const summaryParts = [
            `Manual Azure context snapshot.`,
            `Subscription: ${ctx.subscriptionName ?? ctx.subscriptionId ?? 'unknown'}.`,
          ];
          if (ctx.resourceGroup) summaryParts.push(`Resource group: ${ctx.resourceGroup}.`);
          if (ctx.resourceIds?.length) summaryParts.push(`${ctx.resourceIds.length} resource(s) inventoried.`);
          const wsF = vscode.workspace.workspaceFolders?.[0];
          const session: CompressedSession = {
            id: crypto.randomUUID(),
            workspaceId: wsF?.uri.toString() ?? 'unknown',
            workspaceName: wsF?.name ?? 'unknown',
            startTime: Date.now(),
            endTime: Date.now(),
            summary: summaryParts.join(' '),
            observationType: 'deployment',
            keyFiles: [],
            keyTopics: ['azure', 'context-snapshot'],
            decisions: [],
            problemsSolved: [],
            rawEventCount: 0,
            userTags: ['azure', 'context-snapshot'],
            redactionCount: 0,
            azureContext: meta,
          };
          await store.addSession(session);
          updateStatusBar();
          vscode.window.showInformationMessage(
            `GHCP-MEM: Azure snapshot saved (${ctx.subscriptionName ?? 'sub'}${ctx.resourceGroup ? ' / ' + ctx.resourceGroup : ''}).`
          );
        }
      );
    }),

    vscode.commands.registerCommand('ghcpMem.showHealth', async () => {
      const health = computeHealth(store.getAllSessions());
      const doc = await vscode.workspace.openTextDocument({
        content: formatHealthMarkdown(health),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('ghcpMem.exportPack', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Pack name (short, no spaces)',
        placeHolder: 'e.g. payments-onboarding',
        validateInput: v => (/^[a-z0-9._-]+$/i.test(v.trim()) ? null : 'Use letters, digits, . _ -'),
      });
      if (!name) return;
      const description = await vscode.window.showInputBox({ prompt: 'Pack description (optional)' });
      const filterMode = await vscode.window.showQuickPick(
        [
          { label: 'Everything', detail: 'Export all sessions', value: 'all' },
          { label: 'By tag', detail: 'Only sessions matching a tag', value: 'tag' },
          { label: 'By type', detail: 'Only sessions of an observation type', value: 'type' },
        ],
        { placeHolder: 'What to export?' },
      );
      if (!filterMode) return;
      const opts: Parameters<typeof buildPack>[1] = { name: name.trim(), description, redactAgain: true };
      if (filterMode.value === 'tag') {
        const tag = await vscode.window.showInputBox({ prompt: 'Tag filter (comma-separated for OR)' });
        if (tag) opts.filterTags = tag.split(',').map(s => s.trim()).filter(Boolean);
      } else if (filterMode.value === 'type') {
        const type = await vscode.window.showInputBox({ prompt: 'Type filter (e.g. feature,bugfix)' });
        if (type) opts.filterTypes = type.split(',').map(s => s.trim()).filter(Boolean);
      }
      const target = await vscode.window.showSaveDialog({
        filters: { 'GHCP-MEM Pack': ['json'] },
        defaultUri: vscode.Uri.file(`${name.trim()}.ghcpmem-pack.json`),
      });
      if (!target) return;
      const pack = buildPack(store, opts);
      await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(pack, null, 2), 'utf-8'));
      vscode.window.showInformationMessage(`GHCP-MEM: Exported ${pack.sessions.length} session(s) to ${target.fsPath}`);
    }),

    vscode.commands.registerCommand('ghcpMem.importPack', async () => {
      const picks = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'GHCP-MEM Pack': ['json'] },
      });
      if (!picks?.length) return;
      const bytes = await vscode.workspace.fs.readFile(picks[0]);
      try {
        const pack = parsePack(Buffer.from(bytes).toString('utf-8'));
        const confirm = await vscode.window.showInformationMessage(
          `Import pack "${pack.name}" with ${pack.sessions.length} session(s)?${pack.description ? `\n\n${pack.description}` : ''}`,
          { modal: true },
          'Import'
        );
        if (confirm !== 'Import') return;
        const res = await importPack(store, pack);
        updateStatusBar();
        vscode.window.showInformationMessage(
          `GHCP-MEM: Imported ${res.imported} session(s) from pack "${pack.name}"${res.skipped ? ` (${res.skipped} already present)` : ''}.`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`GHCP-MEM: Pack import failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('ghcpMem.uninstallPack', async () => {
      const installed = listInstalledPacks(store);
      if (installed.length === 0) {
        vscode.window.showInformationMessage('GHCP-MEM: No packs installed.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        installed.map(p => ({ label: p.name, description: `${p.count} session(s)` })),
        { placeHolder: 'Pack to uninstall' }
      );
      if (!pick) return;
      const confirm = await vscode.window.showWarningMessage(
        `Uninstall pack "${pick.label}" and delete its ${pick.description}?`,
        { modal: true },
        'Uninstall'
      );
      if (confirm !== 'Uninstall') return;
      const n = await uninstallPack(store, pick.label);
      updateStatusBar();
      vscode.window.showInformationMessage(`GHCP-MEM: Removed ${n} session(s) from pack "${pick.label}".`);
    }),

    vscode.commands.registerCommand('ghcpMem.showMcpInfo', async () => {
      const storePath = path.join(os.homedir(), '.ghcp-mem', 'sessions.json');
      // Locate the installed mcpServer.js (relative to this extension's out/).
      const extUri = vscode.extensions.getExtension('ghcp-plugin.ghcp-mem')?.extensionUri;
      const mcpJs = extUri ? vscode.Uri.joinPath(extUri, 'out', 'mcpServer.js').fsPath : '<extension-install>/out/mcpServer.js';
      const snippet = [
        '# Connect External MCP Clients to GHCP-MEM',
        '',
        'GHCP-MEM mirrors its memory to `~/.ghcp-mem/sessions.json` so that any',
        'MCP-compatible client (Cursor, Cline, Windsurf, Claude Desktop, ...) can',
        'read the same store via the bundled stdio server.',
        '',
        `- Store file: \`${storePath}\``,
        `- Server script: \`${mcpJs}\``,
        '',
        '## Cursor / Cline / Windsurf (mcp.json)',
        '',
        '```json',
        '{',
        '  "mcpServers": {',
        '    "ghcp-mem": {',
        '      "command": "node",',
        `      "args": ["${mcpJs.replace(/\\/g, '\\\\')}"]`,
        '    }',
        '  }',
        '}',
        '```',
        '',
        '## Claude Desktop (claude_desktop_config.json)',
        '',
        '```json',
        '{',
        '  "mcpServers": {',
        '    "ghcp-mem": {',
        '      "command": "node",',
        `      "args": ["${mcpJs.replace(/\\/g, '\\\\')}"]`,
        '    }',
        '  }',
        '}',
        '```',
        '',
        '## Tools exposed',
        '',
        '- `ghcpMem_search(query, type?, sinceDays?, tag?, limit?)` — RRF-fused keyword + recency search.',
        '- `ghcpMem_recent(limit?)` — most recent sessions.',
        '- `ghcpMem_timeline(days?, limit?)` — chronological within a window.',
        '- `ghcpMem_get(id)` — full detail by ID or prefix.',
      ].join('\n');
      const doc = await vscode.workspace.openTextDocument({ content: snippet, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('ghcpMem.seedAzureDemo', async () => {
      const answer = await vscode.window.showInformationMessage(
        'Seed GHCP-MEM with 5 realistic Azure demo sessions? (Safe: tagged "demo", you can delete them anytime.)',
        { modal: true },
        'Seed'
      );
      if (answer !== 'Seed') return;
      const seeds = buildAzureDemoSessions();
      for (const s of seeds) await store.addSession(s);
      tree.refresh();
      updateStatusBar();
      vscode.window.showInformationMessage(`GHCP-MEM: Seeded ${seeds.length} Azure demo session(s). Filter by tag:demo to find them.`);
    }),
  );

  if (config.autoInjectStartupContext) writeStartupContext();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ghcpMem')) {
        const c = getConfig();
        if (compressionTimer) clearInterval(compressionTimer);
        startCompressionTimer(c.compressionIntervalMinutes);
      }
    })
  );

  context.subscriptions.push(capture, store, provider, tree, statusBarItem);

  context.subscriptions.push({
    dispose: () => {
      if (compressionTimer) clearInterval(compressionTimer);
      // 1. Synchronously write any drained events to disk FIRST so even if the
      //    LM compress below hangs or the host is killed, the next activation
      //    can pick the events back up. This is the only safe step here.
      try {
        const snapshot = capture.drain();
        if (snapshot.events.length > 0) {
          writeRecoveryFileSync(snapshot.events, snapshot.azureSubsystems, snapshot.azureTags, snapshot.redactionCount);
        }
        // Re-inject so the async compress below still has something to work on.
        for (const e of snapshot.events) capture.pushExistingEvent?.(e);
      } catch { /* swallow — recovery file is best-effort */ }
      // 2. Kick off a best-effort compress. deactivate() awaits this promise.
      shutdownCompress = compressAndStore()
        .then(() => { try { deleteRecoveryFileSync(); } catch { /* ignore */ } })
        .catch(() => { /* leave recovery file in place for next activate */ });
    },
  });

  const stats = store.getStats();
  console.log(`[GHCP-MEM] Active. ${stats.workspaceSessions} workspace session(s) available.`);

  // Health threshold notification — warn when score falls below 30.
  const health = computeHealth(store.getAllSessions());
  const healthThreshold = vscode.workspace.getConfiguration('ghcpMem').get<number>('healthAlertThreshold', 30);
  if (health.score < healthThreshold && stats.totalSessions > 0) {
    vscode.window.showWarningMessage(
      `GHCP-MEM: Memory health is low (${health.score}/100). Run "GHCP-MEM: Show Memory Health Score" for details.`,
      'Show Health'
    ).then(action => {
      if (action === 'Show Health') {
        vscode.commands.executeCommand('ghcpMem.showHealth');
      }
    });
  }
}

export async function deactivate(): Promise<void> {
  // VS Code waits a bounded amount of time for this to settle. If the
  // in-flight compress hasn't finished by then the host is killed — but
  // the synchronous recovery-file write in the subscription dispose above
  // means the events are already safe on disk for next activation.
  if (shutdownCompress) {
    try { await shutdownCompress; } catch { /* ignore */ }
  }
}

// ── Recovery helpers ────────────────────────────────────────

interface RecoveryPayload {
  version: 1;
  capturedAt: number;
  events: SessionEvent[];
  azureSubsystems: string[];
  azureTags: string[];
  redactionCount: number;
}

function writeRecoveryFileSync(
  events: SessionEvent[],
  azureSubsystems: string[],
  azureTags: string[],
  redactionCount: number,
): void {
  if (!recoveryFile) return;
  const payload: RecoveryPayload = {
    version: 1,
    capturedAt: Date.now(),
    events,
    azureSubsystems,
    azureTags,
    redactionCount,
  };
  try {
    const p = recoveryFile.fsPath;
    fsSync.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    fsSync.renameSync(tmp, p);
  } catch {
    // Best-effort — don't block shutdown on disk errors.
  }
}

function deleteRecoveryFileSync(): void {
  if (!recoveryFile) return;
  try { fsSync.unlinkSync(recoveryFile.fsPath); } catch { /* ignore */ }
}

async function restorePendingEvents(): Promise<void> {
  if (!recoveryFile) return;
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(recoveryFile);
  } catch {
    return; // No recovery file — normal case.
  }
  let payload: RecoveryPayload | undefined;
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf-8')) as RecoveryPayload;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.events)) {
      payload = parsed;
    }
  } catch { /* malformed — drop it */ }
  // Always delete the file, even on parse error, to prevent infinite recovery loops.
  try { await vscode.workspace.fs.delete(recoveryFile); } catch { /* ignore */ }
  if (!payload || payload.events.length === 0) return;
  for (const e of payload.events) capture.pushExistingEvent?.(e);
  console.log(`[GHCP-MEM] Restored ${payload.events.length} event(s) from prior session.`);
}

// ── Internals ───────────────────────────────────────────────

async function pickSessionId(node?: TreeNode): Promise<string | undefined> {
  if (node?.session) return node.session.id;
  const sessions = store.getAllSessions().slice().reverse();
  if (sessions.length === 0) {
    vscode.window.showInformationMessage('No sessions stored.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    sessions.map(s => ({
      label: `[${s.observationType}] ${new Date(s.startTime).toLocaleString()}`,
      description: s.id.substring(0, 8),
      detail: s.summary.substring(0, 120),
      id: s.id,
    })),
    { placeHolder: 'Select a session' }
  );
  return pick?.id;
}

async function compressAndStore(): Promise<void> {
  const { events, redactionCount, azureSubsystems, azureTags } = capture.drain();
  if (events.length === 0) return;
  const session = await compressor.compress({
    events,
    sessionStartTime: capture.startTime,
    captureRedactionCount: redactionCount,
    azureSubsystems,
    azureTags,
  });
  if (session) {
    await store.addSession(session);
    capture.resetStartTime();
    updateStatusBar();
    autosave?.notifyFlushed();
    const config = getConfig();
    if (config.autoInjectStartupContext) writeStartupContext();
  }
}

function startCompressionTimer(intervalMinutes: number): void {
  compressionTimer = setInterval(async () => {
    if (capture.eventCount > 0) await compressAndStore();
  }, intervalMinutes * 60 * 1000);
}

function updateStatusBar(): void {
  if (!statusBarItem) return;
  const stats = store.getStats();
  const cfg = getConfig();
  const glyph = fillGlyph(stats.totalSessions, cfg.maxStoredSessions);
  const health = computeHealth(store.getAllSessions());
  statusBarItem.text = `$(history) MEM ${glyph} ${health.score}`;
  statusBarItem.tooltip = [
    'GHCP-MEM',
    `${stats.workspaceSessions} session(s) in this workspace, ${stats.totalSessions} total`,
    `Memory health: ${health.score}/100`,
    `Pending events: ${capture.eventCount}`,
    `Total redactions: ${stats.totalRedactions}`,
    'Click to capture a snapshot',
  ].join('\n');
}

async function writeStartupContext(): Promise<void> {
  const contextText = provider.buildStartupContext();
  if (!contextText) return;
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return;
  const dir = vscode.Uri.joinPath(ws.uri, '.github', 'instructions');
  const file = vscode.Uri.joinPath(dir, 'session-memory.instructions.md');
  const content = `---
applyTo: "**"
description: "Auto-generated session context from GHCP-MEM. Summaries of recent coding sessions for continuity."
---

${contextText}
`;
  try {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(file, Buffer.from(content, 'utf-8'));
    // Ensure the auto-generated file is git-ignored so it is never committed.
    await ensureGitIgnored(ws.uri, '.github/instructions/session-memory.instructions.md');
  } catch (err) {
    console.warn('[GHCP-MEM] Could not write startup context:', err);
  }
}

/** Append `entry` to the workspace .gitignore if it isn't already listed. */
async function ensureGitIgnored(wsRoot: vscode.Uri, entry: string): Promise<void> {
  try {
    const gitignoreUri = vscode.Uri.joinPath(wsRoot, '.gitignore');
    let existing = '';
    try {
      existing = Buffer.from(await vscode.workspace.fs.readFile(gitignoreUri)).toString('utf-8');
    } catch {
      // File doesn't exist yet — we'll create it.
    }
    const lines = existing.split('\n').map(l => l.trim());
    if (lines.includes(entry)) return;
    const updated = existing.endsWith('\n') || existing === ''
      ? existing + entry + '\n'
      : existing + '\n' + entry + '\n';
    await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(updated, 'utf-8'));
  } catch {
    // Non-fatal — ignore FS errors in restricted sandboxes.
  }
}

function formatReport(stats: ReturnType<ContextStore['getStats']>, recent: CompressedSession[]): string {
  const lines: string[] = [
    '# GHCP-MEM — Context Report',
    '',
    '## Statistics',
    `- Total sessions: **${stats.totalSessions}**`,
    `- This workspace: **${stats.workspaceSessions}**`,
    `- Total redactions applied: **${stats.totalRedactions}**`,
  ];
  if (stats.oldestSession) lines.push(`- Oldest session: ${new Date(stats.oldestSession).toLocaleString()}`);
  if (stats.newestSession) lines.push(`- Newest session: ${new Date(stats.newestSession).toLocaleString()}`);
  lines.push('', '## Recent Sessions', '');
  if (recent.length === 0) {
    lines.push('_No sessions yet._');
  } else {
    for (const s of [...recent].reverse()) lines.push(formatSessionDetail(s));
  }
  return lines.join('\n');
}

function formatSessionDetail(s: CompressedSession): string {
  const start = new Date(s.startTime).toLocaleString();
  const dur = Math.round((s.endTime - s.startTime) / 60000);
  const lines = [
    `### [${s.observationType}] ${start} (${dur} min) — \`${s.id.substring(0, 8)}\``,
    '',
    s.summary,
    '',
  ];
  if (s.keyFiles.length) lines.push(`**Files:** ${s.keyFiles.join(', ')}`);
  if (s.keyTopics.length) lines.push(`**Topics:** ${s.keyTopics.join(', ')}`);
  if (s.decisions.length) lines.push(`**Decisions:** ${s.decisions.join('; ')}`);
  if (s.problemsSolved.length) lines.push(`**Solved:** ${s.problemsSolved.join('; ')}`);
  if (s.userTags.length) lines.push(`**Tags:** ${s.userTags.join(', ')}`);
  if (s.azureContext) {
    const ac = s.azureContext;
    lines.push('**Azure:** ' + [
      ac.subscriptionName && `sub=${ac.subscriptionName}`,
      ac.resourceGroup && `rg=${ac.resourceGroup}`,
      ac.subsystems?.length && `subsystems=${ac.subsystems.join(',')}`,
      ac.resourceIds?.length && `resources=${ac.resourceIds.length}`,
    ].filter(Boolean).join(' · '));
  }
  if (s.redactionCount) lines.push(`_${s.redactionCount} redaction(s) applied._`);
  lines.push('');
  return lines.join('\n');
}

function buildAzureDemoSessions(): CompressedSession[] {
  const ws = vscode.workspace.workspaceFolders?.[0];
  const workspaceId = ws?.uri.toString() ?? 'demo-workspace';
  const workspaceName = ws?.name ?? 'demo';
  const now = Date.now();
  const hour = 3600000;
  const mk = (
    offset: number,
    observationType: CompressedSession['observationType'],
    summary: string,
    keyFiles: string[],
    keyTopics: string[],
    decisions: string[],
    problemsSolved: string[],
    subsystems: string[],
    extraTags: string[] = []
  ): CompressedSession => ({
    id: crypto.randomUUID(),
    workspaceId,
    workspaceName,
    startTime: now - offset - 15 * 60000,
    endTime: now - offset,
    summary,
    observationType,
    keyFiles,
    keyTopics,
    decisions,
    problemsSolved,
    rawEventCount: keyFiles.length * 4 + 3,
    userTags: ['demo', 'azure', ...extraTags],
    redactionCount: 0,
    azureContext: {
      subscriptionName: 'contoso-dev',
      subscriptionId: '00000000-0000-0000-0000-000000000000',
      tenantId: '11111111-1111-1111-1111-111111111111',
      resourceGroup: 'rg-contoso-dev',
      defaultLocation: 'eastus2',
      subsystems,
      capturedAt: new Date(now - offset).toISOString(),
    },
  });

  return [
    mk(
      4 * hour,
      'infra',
      'Authored Bicep modules for a Static Web App fronted by Azure Front Door, output SWA hostname as a stackOutput. Added managedIdentity block and scoped the SWA to the app resource group.',
      ['infra/main.bicep', 'infra/modules/swa.bicep', 'infra/modules/afd.bicep', 'azure.yaml'],
      ['bicep', 'static-web-apps', 'front-door', 'managed-identity'],
      ['Front Door in front of SWA for global cache + WAF', 'System-assigned identity on SWA, no keys in code'],
      [],
      ['iac-bicep', 'azd'],
      ['bicep', 'swa']
    ),
    mk(
      2 * hour,
      'deployment',
      'Ran `azd up` against contoso-dev. Deployment failed on Key Vault RBAC role assignment (principal not yet propagated); added a 30s delay + retry in infra/main.bicep module ordering and redeployed successfully.',
      ['infra/main.bicep', 'infra/modules/kv.bicep'],
      ['azd', 'key-vault', 'rbac', 'deployment'],
      ['Chain KV role assignment after managed identity creation with dependsOn'],
      ['Intermittent KV RBAC propagation failure on first deploy'],
      ['azd', 'cli'],
      ['azd', 'deployment']
    ),
    mk(
      hour,
      'bugfix',
      'Azure Function cold-start returning 500 because DefaultAzureCredential could not find a managed identity in local dev. Added AZURE_CLIENT_ID fallback in host.json and documented the dev/prod credential chain in README.',
      ['src/functions/api/host.json', 'src/functions/api/local.settings.json', 'README.md'],
      ['azure-functions', 'defaultazurecredential', 'managed-identity'],
      ['Use VisualStudioCodeCredential in dev, ManagedIdentityCredential in prod'],
      ['500 from function on cold start due to missing credential'],
      ['functions'],
      ['functions']
    ),
    mk(
      30 * 60000,
      'refactor',
      'Migrated AKS workload from kubectl-apply YAML to a Helm chart. Replaced raw Deployment/Service/Ingress manifests with templated values.yaml. Verified with `helm template` diff against the previous cluster state.',
      ['charts/api/Chart.yaml', 'charts/api/values.yaml', 'charts/api/templates/deployment.yaml'],
      ['aks', 'helm', 'kubectl', 'ingress'],
      ['Helm for templating + rollback history', 'Pin image tag via values.yaml, not latest'],
      [],
      ['aks'],
      ['aks', 'helm']
    ),
    mk(
      15 * 60000,
      'security',
      'Hardened Azure Storage account: disabled shared-key access, enabled OAuth-only data plane, rotated the one remaining SAS token and replaced it with a user-delegation SAS minted from managed identity.',
      ['infra/modules/storage.bicep', 'src/api/blobClient.ts'],
      ['azure-storage', 'sas', 'rbac', 'managed-identity'],
      ['Shared-key disabled everywhere', 'All SAS tokens must be user-delegation, never account-key'],
      ['Inventoried and replaced 1 hardcoded SAS token'],
      ['iac-bicep', 'storage' as AzureSubsystemLiteral],
      ['storage', 'security']
    ),
  ];
}

// Avoid a circular import by typing the string-literal values locally.
type AzureSubsystemLiteral = 'iac-bicep' | 'iac-terraform' | 'iac-arm' | 'azd' | 'functions' | 'appservice' | 'aks' | 'containerapps' | 'storage' | 'keyvault' | 'openai' | 'cli';
