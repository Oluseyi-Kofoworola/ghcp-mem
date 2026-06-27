import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fsSync from 'fs';
import { SessionCapture } from './sessionCapture';
import { ContextCompressor } from './contextCompressor';
import { ContextStore } from './contextStore';
import { ContextProvider, renderClaimList } from './contextProvider';
import { matchFilePath } from './pathMatch';
import { serializeRulesFile } from './projectRules';
import { effectiveConfidence } from './decay';
import { SessionsTreeProvider, TreeNode } from './sessionsView';
import {
  MemorySearchTool,
  MemoryStoreTool,
  MemoryAuditTool,
  MemoryLessonsTool,
} from './memoryTool';
import { getEmbedder, makeLocalEmbedder } from './embeddings';
import { captureAzureContext } from './azureContext';
import { AzureSubsystem } from './azureDetect';
import { getConfig, CompressedSession, AzureContextMeta, SessionEvent } from './types';
import { scoreSessionQuality } from './quality';
import { runJanitor } from './janitor';
import { computeHealth, formatHealthMarkdown, fillGlyph } from './health';
import { buildPack, parsePack, importPack, uninstallPack, listInstalledPacks } from './packs';
import { AutosaveTrigger } from './autosave';
import { MemoryTimelinePanel } from './timelinePanel';
import { SessionCodeLensProvider } from './sessionCodeLens';
import { refreshPolicyRedactionRules } from './policySource';

let capture: SessionCapture;
let compressor: ContextCompressor;
let store: ContextStore;
let provider: ContextProvider;
let tree: SessionsTreeProvider;
let compressionTimer: NodeJS.Timeout | undefined;
let janitorTimer: NodeJS.Timeout | undefined;
let idleCheckTimer: NodeJS.Timeout | undefined;
let lastActivityMs = Date.now();
/**
 * In-memory, session-scoped suppression for the persist-preview modal. Once the
 * user confirms a snapshot in the current VS Code session, we stop prompting for
 * the remainder of this session. This is independent of the persisted
 * `previewBeforePersist` setting, so it works even when a Workspace-level
 * override or enterprise mode would otherwise force the modal back on every
 * compression cycle.
 */
let persistPromptSuppressedThisSession = false;
let statusBarItem: vscode.StatusBarItem;
let autosave: AutosaveTrigger | undefined;
let reviewStateStore: vscode.Memento | undefined;
/** Last content hash written to session-memory.instructions.md — skip write if unchanged. */
let lastStartupContextHash: string | undefined;
/** Last content hash written to CLAUDE.md — skip write if unchanged. */
let lastClaudeMdHash: string | undefined;
/** File where we stash drained events on shutdown so the next activation can recover. */
let recoveryFile: vscode.Uri | undefined;
/** Promise that the (best-effort) shutdown compress is tracked through, so deactivate() can await it. */
let shutdownCompress: Promise<void> | undefined;
let reviewPromptInFlight = false;
/** Structured log output channel — visible via View > Output > GHCP-MEM. */
let memLog: vscode.OutputChannel;

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  memLog?.appendLine(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

const REVIEW_PROMPT_KEY = 'ghcpMem.reviewPromptState';
const REVIEW_PROMPT_MIN_SUCCESSES = 3;
const REVIEW_PROMPT_MIN_SESSIONS = 3;
const REVIEW_PROMPT_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const MARKETPLACE_REVIEW_URL =
  'https://marketplace.visualstudio.com/items?itemName=itcredibl.ghcp-mem&ssr=false#review-details';

interface ReviewPromptState {
  successes: number;
  rated: boolean;
  doNotAskAgain: boolean;
  lastPromptAt?: number;
}

export async function activate(context: vscode.ExtensionContext) {
  memLog = vscode.window.createOutputChannel('GHCP-MEM');
  context.subscriptions.push(memLog);

  const config = getConfig();
  if (!config.enabled) {
    log('INFO', 'Disabled via settings.');
    return;
  }

  reviewStateStore = context.globalState;

  const backupDir = vscode.Uri.joinPath(context.globalStorageUri, 'backups');
  recoveryFile = vscode.Uri.joinPath(context.globalStorageUri, 'pending-events.json');
  store = new ContextStore(context.globalState, backupDir);
  compressor = new ContextCompressor();
  capture = new SessionCapture();
  provider = new ContextProvider(store);
  tree = new SessionsTreeProvider(store);

  await syncPolicySource();
  await maybeShowPrivacyWizard(context);

  capture.start();
  provider.register();

  // Recover any events left behind by an unclean shutdown of a previous
  // session. We deliberately re-inject before user activity starts so the
  // next compression pass naturally includes them, and we delete the
  // recovery file even on parse error to avoid an infinite-restore loop.
  void restorePendingEvents();

  vscode.window.registerTreeDataProvider('ghcpMem.sessionsView', tree);

  // Register the Language Model Tools so Copilot agent mode can auto-invoke memory search + store + audit.
  const toolDisposables: vscode.Disposable[] = [
    vscode.lm.registerTool('ghcpMem_search', new MemorySearchTool(store)),
    // Audit is always available — read-only workspace inspection, no write surface.
    vscode.lm.registerTool('ghcpMem_audit', new MemoryAuditTool()),
    // Lessons are read-only — consolidated semantic + procedural memory.
    vscode.lm.registerTool('ghcpMem_lessons', new MemoryLessonsTool(store)),
  ];
  if (!config.enterpriseMode && config.allowMcpWriteAccess) {
    toolDisposables.push(vscode.lm.registerTool('ghcpMem_store', new MemoryStoreTool(store)));
  }
  context.subscriptions.push(...toolDisposables);

  // Auto-register the MCP server so other tools can access GHCP-MEM sessions over the MCP protocol.
  const lmAny = vscode.lm as any;
  if (typeof lmAny.registerMcpServerDefinitionProvider === 'function') {
    const mcpBin = context.asAbsolutePath('out/mcpServer.js');
    context.subscriptions.push(
      lmAny.registerMcpServerDefinitionProvider('ghcp-mem.mcp', {
        resolve() {
          return { label: 'GHCP-MEM', command: { command: process.execPath, args: [mcpBin] } };
        },
      }),
    );
    log('INFO', 'MCP server provider registered.');
  }

  // Hybrid retrieval embedder. Prefer the proposed neural `vscode.lm`
  // embeddings API when present; otherwise fall back to the dependency-free
  // local lexical embedding so dense hybrid search works by default. The
  // fallback is opt-out via `ghcpMem.localEmbeddings`.
  getEmbedder()
    .then((fn) => {
      if (fn) {
        store.setEmbedder(fn);
        log('INFO', 'Embedding-based hybrid search enabled (neural vscode.lm).');
      } else if (config.localEmbeddings) {
        store.setEmbedder(makeLocalEmbedder());
        log('INFO', 'Embedding-based hybrid search enabled (local lexical fallback).');
      }
    })
    .catch(() => {
      if (config.localEmbeddings) {
        store.setEmbedder(makeLocalEmbedder());
        log('INFO', 'Embedding-based hybrid search enabled (local lexical fallback).');
      }
    });

  startCompressionTimer(config.compressionIntervalMinutes, config.idleTimeoutSeconds);
  startJanitorTimer();

  // Track editor activity so the idle-timeout compression knows when to fire.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(() => {
      lastActivityMs = Date.now();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      lastActivityMs = Date.now();
    }),
  );

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
      onTrigger: async () => {
        await compressAndStore();
      },
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
      vscode.window.setStatusBarMessage('$(check) GHCP-MEM: Snapshot captured.', 3000);
      void recordSuccessAndMaybePromptForRating();
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

    vscode.commands.registerCommand('ghcpMem.runPrivacyWizard', async () => {
      await runPrivacyWizard(context);
      updateStatusBar();
    }),

    vscode.commands.registerCommand('ghcpMem.editProjectRules', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        vscode.window.showWarningMessage(
          'GHCP-MEM: open a workspace folder to edit project rules.',
        );
        return;
      }
      const dir = vscode.Uri.joinPath(ws.uri, '.github', 'memory');
      const file = vscode.Uri.joinPath(dir, 'rules.md');
      let created = false;
      try {
        await vscode.workspace.fs.stat(file);
      } catch {
        await vscode.workspace.fs.createDirectory(dir);
        await vscode.workspace.fs.writeFile(file, Buffer.from(serializeRulesFile([]), 'utf-8'));
        created = true;
      }
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc);
      if (created) {
        vscode.window.showInformationMessage(
          'GHCP-MEM: created .github/memory/rules.md — add rules under a category, then commit it to share with your team.',
        );
      }
    }),

    vscode.commands.registerCommand('ghcpMem.auditMemory', async () => {
      const doc = await vscode.workspace.openTextDocument({
        content: buildAuditReport(store),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('ghcpMem.purgeMemory', async () => {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: 'Current buffer',
            description: 'Discard uncompressed events and pending snippets',
            value: 'buffer' as const,
          },
          {
            label: 'Workspace memory',
            description: 'Delete sessions captured in this workspace',
            value: 'workspace' as const,
          },
          {
            label: 'All memory',
            description: 'Delete every stored session',
            value: 'all' as const,
          },
        ],
        { title: 'Purge GHCP-MEM data', ignoreFocusOut: true },
      );
      if (!choice) return;
      const confirm = await vscode.window.showWarningMessage(
        `Purge ${choice.label.toLowerCase()}? This cannot be undone.`,
        { modal: true },
        'Purge',
      );
      if (confirm !== 'Purge') return;
      if (choice.value === 'buffer') {
        capture.clearPending();
      } else if (choice.value === 'workspace') {
        await store.clearWorkspace();
      } else {
        await store.clear();
      }
      updateStatusBar();
      vscode.window.showInformationMessage(`GHCP-MEM: ${choice.label} purged.`);
    }),

    vscode.commands.registerCommand('ghcpMem.clearMemory', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Clear ALL stored session context? This cannot be undone.',
        { modal: true },
        'Clear All',
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
        {
          location: vscode.ProgressLocation.Notification,
          title: `GHCP-MEM: Compressing ${eventCount} events...`,
          cancellable: false,
        },
        async () => {
          await compressAndStore();
        },
      );
      vscode.window.setStatusBarMessage('$(check) GHCP-MEM: Compression complete.', 3000);
      void recordSuccessAndMaybePromptForRating();
    }),

    vscode.commands.registerCommand('ghcpMem.exportMemory', async () => {
      const target = await vscode.window.showSaveDialog({
        filters: { JSON: ['json'] },
        defaultUri: vscode.Uri.file('ghcp-mem-export.json'),
      });
      if (!target) return;
      const json = await store.exportToJson();
      await vscode.workspace.fs.writeFile(target, Buffer.from(json, 'utf-8'));
      vscode.window.setStatusBarMessage(`$(check) GHCP-MEM: Exported to ${target.fsPath}`, 3000);
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
        const skippedMsg =
          result.skippedInvalid > 0 ? ` (${result.skippedInvalid} skipped — invalid IDs)` : '';
        vscode.window.setStatusBarMessage(
          `$(check) GHCP-MEM: Imported ${result.imported} session(s)${skippedMsg}.`,
          3000,
        );
        updateStatusBar();
      } catch (err) {
        vscode.window.showErrorMessage(
          `GHCP-MEM: Import failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand('ghcpMem.deleteSession', async (node?: TreeNode) => {
      const id = await pickSessionId(node);
      if (!id) return;
      const answer = await vscode.window.showWarningMessage(
        `Delete session ${id.substring(0, 8)}?`,
        { modal: true },
        'Delete',
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

    vscode.commands.registerCommand('ghcpMem.togglePin', async (node?: TreeNode) => {
      const id = await pickSessionId(node);
      if (!id) return;
      const s = store.getById(id);
      if (!s) return;
      if (s.userTags.includes('pinned')) {
        await store.removeTag(id, 'pinned');
        vscode.window.setStatusBarMessage('GHCP-MEM: session unpinned', 2000);
      } else {
        await store.addTag(id, 'pinned');
        vscode.window.setStatusBarMessage('GHCP-MEM: session pinned', 2000);
      }
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

    vscode.commands.registerCommand('ghcpMem.filterSessions', async () => {
      const current = tree.getFilter();
      const scopePick = await vscode.window.showQuickPick(
        [
          { label: '$(workspace-trusted) Workspace', value: 'workspace' as const },
          { label: '$(repo) Repo (this git origin)', value: 'repo' as const },
          { label: '$(globe) All', value: 'all' as const },
        ],
        { placeHolder: `Scope (current: ${current.scope ?? 'workspace'})`, ignoreFocusOut: true },
      );
      if (!scopePick) return;
      const typePick = await vscode.window.showQuickPick(
        [
          { label: '(any type)', value: undefined },
          { label: 'feature', value: 'feature' as const },
          { label: 'bugfix', value: 'bugfix' as const },
          { label: 'refactor', value: 'refactor' as const },
          { label: 'docs', value: 'docs' as const },
          { label: 'test', value: 'test' as const },
          { label: 'chore', value: 'chore' as const },
          { label: 'research', value: 'research' as const },
          { label: 'config', value: 'config' as const },
          { label: 'security', value: 'security' as const },
          { label: 'deployment', value: 'deployment' as const },
          { label: 'infra', value: 'infra' as const },
          { label: 'unknown', value: 'unknown' as const },
        ],
        { placeHolder: 'Filter by observation type', ignoreFocusOut: true },
      );
      if (!typePick) return;
      const tag = await vscode.window.showInputBox({
        prompt: 'Filter by user tag (leave blank for none)',
        value: current.tag ?? '',
        ignoreFocusOut: true,
      });
      if (tag === undefined) return;
      const sinceStr = await vscode.window.showInputBox({
        prompt: 'Show sessions newer than N days (blank = no limit)',
        value: current.sinceDays ? String(current.sinceDays) : '',
        ignoreFocusOut: true,
        validateInput: (v) => (v && !/^\d+$/.test(v) ? 'Must be a positive integer' : null),
      });
      if (sinceStr === undefined) return;
      const text = await vscode.window.showInputBox({
        prompt: 'Free-text filter (blank to skip)',
        value: current.text ?? '',
        ignoreFocusOut: true,
      });
      if (text === undefined) return;
      tree.setFilter({
        scope: scopePick.value,
        type: typePick.value,
        tag: tag.trim() || undefined,
        sinceDays: sinceStr ? parseInt(sinceStr, 10) : undefined,
        text: text.trim() || undefined,
      });
    }),

    vscode.commands.registerCommand('ghcpMem.clearFilter', () => {
      tree.clearFilter();
    }),

    vscode.commands.registerCommand('ghcpMem.exportSessionMarkdown', async (node?: TreeNode) => {
      const { exportSessionMarkdown, exportSessionsMarkdown } = await import('./markdownExport');
      const sessions = node?.session ? [node.session] : store.getWorkspaceSessions();
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('GHCP-MEM: No sessions to export.');
        return;
      }
      const body =
        sessions.length === 1
          ? exportSessionMarkdown(sessions[0])
          : exportSessionsMarkdown(sessions);
      const doc = await vscode.workspace.openTextDocument({ content: body, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('ghcpMem.runEval', async () => {
      const { runEvalSuite, formatEvalReport } = await import('./eval');
      const report = await runEvalSuite(store);
      const md = formatEvalReport(report);
      const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('ghcpMem.runIntegrityAudit', async () => {
      const { runWorkspaceAudit, formatAuditReport, hasBlockingIssues } =
        await import('./integrityChecker');
      const { issues, rulesRun } = await runWorkspaceAudit();
      const md = formatAuditReport(issues, rulesRun);
      const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
      if (hasBlockingIssues(issues)) {
        vscode.window.setStatusBarMessage(
          `$(alert) GHCP-MEM: ${issues.filter((i) => i.severity === 'error').length} integrity error(s) — see audit report`,
          5000,
        );
      }
    }),

    vscode.commands.registerCommand('ghcpMem.restoreBackup', async () => {
      const backups = await store.listBackups();
      if (backups.length === 0) {
        vscode.window.showInformationMessage('GHCP-MEM: No backups available yet.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        backups.map((b) => ({ label: b.name, description: b.uri.fsPath, uri: b.uri })),
        { placeHolder: 'Select a backup to restore (will replace current memory)' },
      );
      if (!pick) return;
      const answer = await vscode.window.showWarningMessage(
        `Restore from ${pick.label}? This will replace all current memory.`,
        { modal: true },
        'Restore',
      );
      if (answer !== 'Restore') return;
      try {
        const n = await store.restoreFromBackup(pick.uri);
        vscode.window.showInformationMessage(`GHCP-MEM: Restored ${n} session(s).`);
        updateStatusBar();
      } catch (err) {
        vscode.window.showErrorMessage(
          `GHCP-MEM: Restore failed — ${err instanceof Error ? err.message : String(err)}`,
        );
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
        if (s.problemsSolved.length)
          lines.push(`**Solved:** ${s.problemsSolved.slice(0, 3).join('; ')}`);
        lines.push('');
      }
      const blob = lines.join('\n');
      await vscode.env.clipboard.writeText(blob);
      vscode.window.showInformationMessage(
        `GHCP-MEM: Copied ${results.length} memory entries to clipboard. Paste into Copilot Chat.`,
      );
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open');
      } catch {
        /* ignore */
      }
    }),

    vscode.commands.registerCommand('ghcpMem.captureAzureContext', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'GHCP-MEM: Snapshotting Azure context…',
        },
        async () => {
          const rgPick = await vscode.window.showInputBox({
            prompt: 'Resource group to inventory (optional, leave empty to use az default)',
            placeHolder: 'my-rg',
          });
          const ctx = await captureAzureContext({
            includeResources: true,
            resourceGroup: rgPick?.trim() || undefined,
          });
          if (!ctx.subscriptionId && ctx.notes) {
            vscode.window.showWarningMessage(
              `GHCP-MEM: ${ctx.notes}. Install az CLI and run "az login" first.`,
            );
            return;
          }
          const meta: AzureContextMeta = { ...ctx, subsystems: ['cli'] };
          const summaryParts = [
            `Manual Azure context snapshot.`,
            `Subscription: ${ctx.subscriptionName ?? ctx.subscriptionId ?? 'unknown'}.`,
          ];
          if (ctx.resourceGroup) summaryParts.push(`Resource group: ${ctx.resourceGroup}.`);
          if (ctx.resourceIds?.length)
            summaryParts.push(`${ctx.resourceIds.length} resource(s) inventoried.`);
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
            `GHCP-MEM: Azure snapshot saved (${ctx.subscriptionName ?? 'sub'}${ctx.resourceGroup ? ' / ' + ctx.resourceGroup : ''}).`,
          );
          void recordSuccessAndMaybePromptForRating();
        },
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
      const cfg = getConfig();
      if (cfg.enterpriseMode || !cfg.allowTeamExport) {
        vscode.window.showWarningMessage('GHCP-MEM: Pack export is disabled by enterprise policy.');
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: 'Pack name (short, no spaces)',
        placeHolder: 'e.g. payments-onboarding',
        validateInput: (v) =>
          /^[a-z0-9._-]+$/i.test(v.trim()) ? null : 'Use letters, digits, . _ -',
      });
      if (!name) return;
      const description = await vscode.window.showInputBox({
        prompt: 'Pack description (optional)',
      });
      const filterMode = await vscode.window.showQuickPick(
        [
          { label: 'Everything', detail: 'Export all sessions', value: 'all' },
          { label: 'By tag', detail: 'Only sessions matching a tag', value: 'tag' },
          { label: 'By type', detail: 'Only sessions of an observation type', value: 'type' },
        ],
        { placeHolder: 'What to export?' },
      );
      if (!filterMode) return;
      const opts: Parameters<typeof buildPack>[1] = {
        name: name.trim(),
        description,
        redactAgain: true,
      };
      if (filterMode.value === 'tag') {
        const tag = await vscode.window.showInputBox({
          prompt: 'Tag filter (comma-separated for OR)',
        });
        if (tag)
          opts.filterTags = tag
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      } else if (filterMode.value === 'type') {
        const type = await vscode.window.showInputBox({
          prompt: 'Type filter (e.g. feature,bugfix)',
        });
        if (type)
          opts.filterTypes = type
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      }
      const target = await vscode.window.showSaveDialog({
        filters: { 'GHCP-MEM Pack': ['json'] },
        defaultUri: vscode.Uri.file(`${name.trim()}.ghcpmem-pack.json`),
      });
      if (!target) return;
      const pack = buildPack(store, opts);
      await vscode.workspace.fs.writeFile(
        target,
        Buffer.from(JSON.stringify(pack, null, 2), 'utf-8'),
      );
      vscode.window.showInformationMessage(
        `GHCP-MEM: Exported ${pack.sessions.length} session(s) to ${target.fsPath}`,
      );
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
          'Import',
        );
        if (confirm !== 'Import') return;
        const res = await importPack(store, pack);
        updateStatusBar();
        const conflictsTail = res.conflictsRaised
          ? ` ⚠️ ${res.conflictsRaised} potential conflict(s) raised — run \`@mem /conflicts\` to review.`
          : '';
        vscode.window.showInformationMessage(
          `GHCP-MEM: Imported ${res.imported} session(s) from pack "${pack.name}"${res.skipped ? ` (${res.skipped} already present)` : ''}.${conflictsTail}`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `GHCP-MEM: Pack import failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand('ghcpMem.uninstallPack', async () => {
      const installed = listInstalledPacks(store);
      if (installed.length === 0) {
        vscode.window.showInformationMessage('GHCP-MEM: No packs installed.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        installed.map((p) => ({ label: p.name, description: `${p.count} session(s)` })),
        { placeHolder: 'Pack to uninstall' },
      );
      if (!pick) return;
      const confirm = await vscode.window.showWarningMessage(
        `Uninstall pack "${pick.label}" and delete its ${pick.description}?`,
        { modal: true },
        'Uninstall',
      );
      if (confirm !== 'Uninstall') return;
      const n = await uninstallPack(store, pick.label);
      updateStatusBar();
      vscode.window.showInformationMessage(
        `GHCP-MEM: Removed ${n} session(s) from pack "${pick.label}".`,
      );
    }),

    vscode.commands.registerCommand('ghcpMem.showMcpInfo', async () => {
      const cfg = getConfig();
      const storePath = path.join(os.homedir(), '.ghcp-mem', 'sessions.json');
      // Locate the installed mcpServer.js (relative to this extension's out/).
      const extUri = vscode.extensions.getExtension('itcredibl.ghcp-mem')?.extensionUri;
      const mcpJs = extUri
        ? vscode.Uri.joinPath(extUri, 'out', 'mcpServer.js').fsPath
        : '<extension-install>/out/mcpServer.js';
      const snippet = [
        '# Connect External MCP Clients to GHCP-MEM',
        '',
        'GHCP-MEM mirrors its memory to `~/.ghcp-mem/sessions.json` so that any',
        'MCP-compatible client (Cursor, Cline, Windsurf, Claude Desktop, GitHub Copilot CLI, ...) can',
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
        '## GitHub Copilot CLI (/mcp)',
        '',
        'Use `/mcp add` in GitHub Copilot CLI, choose a local/stdio server, and point it at the same Node command shown above.',
        '',
        '```json',
        '{',
        '  "mcpServers": {',
        '    "ghcp-mem": {',
        '      "type": "stdio",',
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
        cfg.enterpriseMode || !cfg.allowMcpWriteAccess
          ? '- Write tools are disabled by policy in this environment.'
          : '- `ghcpMem_store(...)` and `ghcpMem_delete(...)` are available in the MCP server.',
      ].join('\n');
      const doc = await vscode.workspace.openTextDocument({
        content: snippet,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('ghcpMem.seedAzureDemo', async () => {
      const answer = await vscode.window.showInformationMessage(
        'Seed GHCP-MEM with 5 realistic Azure demo sessions? (Safe: tagged "demo", you can delete them anytime.)',
        { modal: true },
        'Seed',
      );
      if (answer !== 'Seed') return;
      const seeds = buildAzureDemoSessions();
      for (const s of seeds) await store.addSession(s);
      tree.refresh();
      updateStatusBar();
      vscode.window.setStatusBarMessage(
        `$(check) GHCP-MEM: Seeded ${seeds.length} Azure demo session(s). Filter by tag:demo to find them.`,
        4000,
      );
    }),
  );

  // ── Proactive context prediction ──
  // When the developer opens a file, silently surface any session history for it
  // in the status bar. Low-friction: no popup, just a glanceable affordance.
  {
    let proactiveCooldown: NodeJS.Timeout | undefined;
    const handleFileOpen = (doc: vscode.TextDocument) => {
      if (doc.uri.scheme !== 'file') return;
      if (!getConfig().enabled) return;
      if (proactiveCooldown) return; // debounce

      const relPath = vscode.workspace.asRelativePath(doc.uri.fsPath);
      const all = store.getAllSessions();
      const matches = all.filter((s) => s.keyFiles.some((sf) => matchFilePath(sf, relPath)));

      if (matches.length > 0) {
        const count = matches.length;
        const latest = [...matches].sort((a, b) => b.endTime - a.endTime)[0];
        const ago = formatAgoSimple(latest.endTime);
        const baseName = relPath.split('/').pop() ?? relPath;
        const msg = `$(history) ${count} mem session${count > 1 ? 's' : ''} for ${baseName} · last: ${ago} — @mem /related`;
        vscode.window.setStatusBarMessage(msg, 8000);
      }

      proactiveCooldown = setTimeout(() => {
        proactiveCooldown = undefined;
      }, 3000);
    };

    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(handleFileOpen),
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e) handleFileOpen(e.document);
      }),
    );
  }

  // ── Team Memory Export ──
  context.subscriptions.push(
    vscode.commands.registerCommand('ghcpMem.exportTeamMemory', async () => {
      const cfg = getConfig();
      if (cfg.enterpriseMode || !cfg.allowTeamExport) {
        vscode.window.showWarningMessage('GHCP-MEM: Team export is disabled by enterprise policy.');
        return;
      }
      const wsF = vscode.workspace.workspaceFolders?.[0];
      if (!wsF) {
        vscode.window.showWarningMessage('GHCP-MEM: No workspace open.');
        return;
      }

      const all = store.getAllSessions();
      if (all.length === 0) {
        vscode.window.showWarningMessage('GHCP-MEM: No sessions to export.');
        return;
      }

      // Build the team context document
      const sorted = [...all].sort((a, b) => b.endTime - a.endTime);
      const unique = (arr: string[]) => [...new Set(arr)];
      const allDecisions = unique(sorted.flatMap((s) => s.decisions)).slice(0, 40);
      const allTopics = unique(sorted.flatMap((s) => s.keyTopics)).slice(0, 30);
      const allFiles = unique(sorted.flatMap((s) => s.keyFiles)).slice(0, 50);
      const recentSummaries = sorted.slice(0, 5);

      const lines: string[] = [
        '# Team Context — GHCP-MEM Memory Pack',
        `> Auto-generated by GHCP-MEM on ${new Date().toLocaleString()}. DO NOT edit manually.`,
        `> ${all.length} sessions captured across this workspace.`,
        '',
        '## Architecture & Decisions',
        '',
        ...allDecisions.map((d) => `- ${d}`),
        '',
        '## Key Files',
        '',
        ...allFiles.slice(0, 30).map((f) => `- \`${f}\``),
        '',
        '## Topics & Technologies',
        '',
        allTopics.join(', '),
        '',
        '## Recent Session Summaries',
        '',
        ...recentSummaries.map((s) => {
          const date = new Date(s.startTime).toLocaleDateString();
          const br = s.branchName ? ` · \`${s.branchName}\`` : '';
          return `### ${date} [${s.observationType}]${br}\n\n${s.summary}\n`;
        }),
        '',
        '---',
        `_Updated: ${new Date().toISOString()} · Sessions: ${all.length}_`,
      ];

      const content = lines.join('\n');
      const memDir = vscode.Uri.joinPath(wsF.uri, '.github', 'memory');
      const outFile = vscode.Uri.joinPath(memDir, 'team-context.md');

      try {
        await vscode.workspace.fs.createDirectory(memDir);
        await vscode.workspace.fs.writeFile(outFile, Buffer.from(content, 'utf-8'));
        const choice = await vscode.window.showInformationMessage(
          `GHCP-MEM: Team memory exported to .github/memory/team-context.md (${all.length} sessions, ${allDecisions.length} decisions).`,
          'Open File',
          'Dismiss',
        );
        if (choice === 'Open File') {
          const doc = await vscode.workspace.openTextDocument(outFile);
          await vscode.window.showTextDocument(doc, { preview: true });
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `GHCP-MEM: Failed to write team memory: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  // ── Game-changing UX features ──

  // Visual memory timeline
  context.subscriptions.push(
    vscode.commands.registerCommand('ghcpMem.openTimeline', () => {
      MemoryTimelinePanel.show(store, context);
    }),
  );

  // File session history quick-pick — invoked by the CodeLens
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'ghcpMem.showFileHistory',
      async (relPath?: string, sessions?: CompressedSession[]) => {
        // When called programmatically (CodeLens) sessions are passed directly.
        // When triggered from the command palette, derive from active editor.
        let targetPath = relPath;
        let targetSessions = sessions;

        if (!targetPath || !targetSessions) {
          const doc = vscode.window.activeTextEditor?.document;
          if (!doc) {
            vscode.window.showWarningMessage('GHCP-MEM: No active file.');
            return;
          }
          targetPath = vscode.workspace.asRelativePath(doc.uri.fsPath);
          const codeLens = new SessionCodeLensProvider(store);
          targetSessions = codeLens.findSessionsForFile(targetPath, doc.uri.fsPath);
          codeLens.dispose();
        }

        if (!targetSessions || targetSessions.length === 0) {
          vscode.window.showInformationMessage(`GHCP-MEM: No session history for "${targetPath}".`);
          return;
        }

        const items: vscode.QuickPickItem[] = targetSessions.map(
          (s) =>
            ({
              label: `$(history) [${s.observationType}]  ${new Date(s.endTime).toLocaleString()}`,
              description: s.id.substring(0, 8),
              detail: s.summary.substring(0, 200),
              id: s.id,
            }) as vscode.QuickPickItem & { id: string },
        );

        const pick = (await vscode.window.showQuickPick(items, {
          title: `Session history: ${targetPath}`,
          placeHolder: `${targetSessions.length} session(s) touched this file`,
          matchOnDescription: true,
          matchOnDetail: true,
        })) as (vscode.QuickPickItem & { id: string }) | undefined;

        if (pick?.id) {
          await vscode.commands.executeCommand('workbench.action.chat.open', {
            query: `@mem /detail ${pick.id}`,
          });
        }
      },
    ),
  );

  // Session CodeLens — shows session count inline on files
  const codeLensProvider = new SessionCodeLensProvider(store);
  context.subscriptions.push(
    codeLensProvider,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
  );

  log('INFO', 'Timeline, file history, and CodeLens features registered.');

  if (config.autoInjectStartupContext) {
    // Load team-shared project rules before the first injection so they are
    // present in the generated context from activation onward.
    await provider.refreshProjectRules();
    // A `/rules` mutation (or external edit) rewrites the generated context.
    provider.setRulesChangedHook(async () => {
      if (!getConfig().autoInjectStartupContext) return;
      await writeStartupContext();
      await writeCrossEditorContext();
    });
    watchProjectRules(context);
    await writeStartupContext();
    writeCrossEditorContext();
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ghcpMem')) {
        const c = getConfig();
        if (compressionTimer) clearInterval(compressionTimer);
        if (idleCheckTimer) clearInterval(idleCheckTimer);
        startCompressionTimer(c.compressionIntervalMinutes, c.idleTimeoutSeconds);
        startJanitorTimer();
        void syncPolicySource();
      }
    }),
  );

  context.subscriptions.push(capture, store, provider, tree, statusBarItem);

  context.subscriptions.push({
    dispose: () => {
      if (compressionTimer) clearInterval(compressionTimer);
      if (idleCheckTimer) clearInterval(idleCheckTimer);
      if (janitorTimer) clearInterval(janitorTimer);
      // 1. Synchronously write any drained events to disk FIRST so even if the
      //    LM compress below hangs or the host is killed, the next activation
      //    can pick the events back up. This is the only safe step here.
      try {
        const snapshot = capture.drain();
        if (snapshot.events.length > 0) {
          writeRecoveryFileSync(
            snapshot.events,
            snapshot.azureSubsystems,
            snapshot.azureTags,
            snapshot.redactionCount,
          );
        }
        // Re-inject so the async compress below still has something to work on.
        for (const e of snapshot.events) capture.pushExistingEvent?.(e);
      } catch {
        /* swallow — recovery file is best-effort */
      }
      // 2. Kick off a best-effort compress. deactivate() awaits this promise.
      shutdownCompress = compressAndStore()
        .then(() => {
          try {
            deleteRecoveryFileSync();
          } catch {
            /* ignore */
          }
        })
        .catch(() => {
          /* leave recovery file in place for next activate */
        });
    },
  });

  const stats = store.getStats();
  log('INFO', `Active. ${stats.workspaceSessions} workspace session(s) available.`);

  // Health threshold notification — warn when score falls below 30.
  const health = computeHealth(store.getAllSessions());
  const healthThreshold = vscode.workspace
    .getConfiguration('ghcpMem')
    .get<number>('healthAlertThreshold', 30);
  if (health.score < healthThreshold && stats.totalSessions > 0) {
    vscode.window
      .showWarningMessage(
        `GHCP-MEM: Memory health is low (${health.score}/100). Run "GHCP-MEM: Show Memory Health Score" for details.`,
        'Show Health',
      )
      .then((action) => {
        if (action === 'Show Health') {
          vscode.commands.executeCommand('ghcpMem.showHealth');
        }
      });
  }
}

async function syncPolicySource(): Promise<void> {
  const source = getConfig().policySource;
  if (!source) {
    await refreshPolicyRedactionRules(undefined);
    return;
  }

  try {
    const count = await refreshPolicyRedactionRules(source);
    log('INFO', `Loaded ${count} policy redaction rule(s) from ${source}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('WARN', `Policy source load failed for ${source}: ${message}`);
  }
}

export async function deactivate(): Promise<void> {
  // VS Code waits a bounded amount of time for this to settle. If the
  // in-flight compress hasn't finished by then the host is killed — but
  // the synchronous recovery-file write in the subscription dispose above
  // means the events are already safe on disk for next activation.
  if (shutdownCompress) {
    try {
      await shutdownCompress;
    } catch {
      /* ignore */
    }
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
  // Cap the events we persist to keep the synchronous write fast and bounded.
  // 500 most-recent events is well within the compressor's useful window;
  // anything older in a 3000-event buffer is context the LM would have
  // truncated anyway. At ~500 bytes/event this keeps the file under ~250 KB.
  const MAX_RECOVERY_EVENTS = 500;
  const eventsToSave =
    events.length > MAX_RECOVERY_EVENTS ? events.slice(-MAX_RECOVERY_EVENTS) : events;
  const payload: RecoveryPayload = {
    version: 1,
    capturedAt: Date.now(),
    events: eventsToSave,
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
  try {
    fsSync.unlinkSync(recoveryFile.fsPath);
  } catch {
    /* ignore */
  }
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
  } catch {
    /* malformed — drop it */
  }
  // Always delete the file, even on parse error, to prevent infinite recovery loops.
  try {
    await vscode.workspace.fs.delete(recoveryFile);
  } catch {
    /* ignore */
  }
  if (!payload || payload.events.length === 0) return;
  for (const e of payload.events) capture.pushExistingEvent?.(e);
  log('INFO', `Restored ${payload.events.length} event(s) from prior session.`);
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
    sessions.map((s) => ({
      label: `[${s.observationType}] ${new Date(s.startTime).toLocaleString()}`,
      description: s.id.substring(0, 8),
      detail: s.summary.substring(0, 120),
      id: s.id,
    })),
    { placeHolder: 'Select a session' },
  );
  return pick?.id;
}

async function compressAndStore(): Promise<void> {
  const { events, redactionCount, azureSubsystems, azureTags } = capture.drain();
  if (events.length === 0) return;
  setStatusBarState('compressing');
  try {
    const session = await compressor.compress({
      events,
      sessionStartTime: capture.startTime,
      captureRedactionCount: redactionCount,
      azureSubsystems,
      azureTags,
    });
    if (session) {
      const quality = scoreSessionQuality(session);
      session.qualityScore = quality.score;
      const floor = getConfig().qualityFloor;
      if (quality.score < floor) {
        session.lowQuality = true;
        log(
          'INFO',
          `dropping low-quality session ${session.id} (score=${quality.score.toFixed(2)} < ${floor}): ${quality.reasons.join(', ')}`,
        );
        capture.resetStartTime();
        setStatusBarState('idle');
        return;
      }
      if (!(await confirmPersistSession(session))) {
        setStatusBarState('idle');
        return;
      }
      await store.addSession(session);
      capture.resetStartTime();
      setStatusBarState('idle');
      autosave?.notifyFlushed();
      const config = getConfig();
      if (config.autoInjectStartupContext) {
        writeStartupContext();
        writeCrossEditorContext();
      }
    } else {
      setStatusBarState('idle');
    }
  } catch (err) {
    setStatusBarState('error');
    log('ERROR', `compressAndStore failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

async function confirmPersistSession(session: CompressedSession): Promise<boolean> {
  const config = getConfig();
  if (!config.previewBeforePersist && !config.enterpriseMode) return true;

  // Once the user has confirmed a snapshot in this session, don't prompt again
  // for the rest of it — even if a Workspace-level setting or enterprise mode
  // would otherwise re-arm the modal on every compression cycle.
  if (persistPromptSuppressedThisSession) return true;

  const preview = buildSessionPreview(session);
  const doc = await vscode.workspace.openTextDocument({ content: preview, language: 'markdown' });
  // Open the preview beside the code without stealing focus, so it sits
  // "behind" the editor the user is working in rather than taking over the
  // active group. It stays wired up (clickable tab) for as long as the modal
  // is up, then we close it after the decision so it doesn't linger.
  await vscode.window.showTextDocument(doc, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: true,
  });

  const closePreview = async (): Promise<void> => {
    try {
      const tab = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .find(
          (t) =>
            t.input instanceof vscode.TabInputText && t.input.uri.toString() === doc.uri.toString(),
        );
      if (tab) await vscode.window.tabGroups.close(tab);
    } catch {
      // Best-effort cleanup; never block persistence on a stale tab.
    }
  };

  // The "don't ask again" path. When the user picks this, we permanently
  // disable previewBeforePersist so they're never interrupted again. If
  // enterpriseMode is the reason the prompt was forced on, we tell them
  // explicitly that enterprise mode keeps it on regardless.
  const PERSIST_ALWAYS = "Persist, don't ask again";
  const PERSIST_ONCE = 'Persist';
  const DISCARD = 'Discard';

  const choice = await vscode.window.showInformationMessage(
    'Persist this compressed memory snapshot?',
    {
      modal: true,
      detail:
        'Pick "don\'t ask again" to silence this prompt for future captures. Re-enable any time in Settings: ghcpMem.previewBeforePersist.',
    },
    PERSIST_ALWAYS,
    PERSIST_ONCE,
    DISCARD,
  );

  // Decision made — tear down the side preview so it doesn't linger in the
  // user's editor regardless of which button they picked.
  await closePreview();

  if (choice === PERSIST_ALWAYS) {
    // Suppress for the rest of this session immediately. This is the part the
    // user can rely on: even if the persisted setting below is overridden by a
    // Workspace value or enterprise mode, they won't be prompted again until
    // VS Code is restarted.
    persistPromptSuppressedThisSession = true;
    try {
      // Globally — survives across workspaces. Matches user intent ("once and for all").
      await vscode.workspace
        .getConfiguration('ghcpMem')
        .update('previewBeforePersist', false, vscode.ConfigurationTarget.Global);
      if (config.enterpriseMode) {
        // Enterprise mode forces previewBeforePersist back on via the OR in
        // getConfig(), so the Global update above won't survive a restart. It's
        // silenced for the rest of this session via the in-memory flag; be
        // honest that it will return next session unless enterprise mode is off.
        const followUp = await vscode.window.showWarningMessage(
          'GHCP-MEM: persist prompt silenced for this session, but enterprise mode re-enables it on restart. To fully silence it, also disable ghcpMem.enterpriseMode.',
          'Open Settings',
        );
        if (followUp === 'Open Settings') {
          void vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'ghcpMem.enterpriseMode',
          );
        }
      } else {
        vscode.window.setStatusBarMessage(
          '$(check) GHCP-MEM: persist prompt disabled. Re-enable in Settings: ghcpMem.previewBeforePersist',
          5000,
        );
      }
    } catch (err) {
      // Setting update can fail in unusual hosts (e.g. read-only configs).
      // Persist the snapshot anyway — the user's intent was "yes, save".
      log(
        'WARN',
        `Failed to persist 'don't ask again' choice: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true;
  }

  return choice === PERSIST_ONCE;
}

function startCompressionTimer(intervalMinutes: number, idleSeconds = 30): void {
  compressionTimer = setInterval(
    async () => {
      if (capture.eventCount > 0) await compressAndStore();
    },
    intervalMinutes * 60 * 1000,
  );

  // Idle-aware compression: fires ASAP when the developer stops typing for
  // idleSeconds, rather than waiting the full interval. Set idleSeconds to 0
  // to rely only on the interval timer. Polls every 5 s; lightweight.
  if (idleSeconds > 0) {
    idleCheckTimer = setInterval(async () => {
      if (capture.eventCount > 0 && Date.now() - lastActivityMs >= idleSeconds * 1000) {
        lastActivityMs = Date.now(); // reset so we don't fire again immediately
        await compressAndStore();
      }
    }, 5_000);
  }
}

function startJanitorTimer(): void {
  if (janitorTimer) {
    clearInterval(janitorTimer);
    janitorTimer = undefined;
  }
  const cfg = vscode.workspace.getConfiguration('ghcpMem');
  if (!cfg.get<boolean>('janitorEnabled', true)) return;
  const days = Math.max(1, cfg.get<number>('janitorIntervalDays', 7));
  const pruneAfterDays = Math.max(0, cfg.get<number>('janitorPruneAfterDays', 0));
  const tick = async () => {
    try {
      const c = getConfig();
      const r = await runJanitor(store, {
        qualityFloor: c.qualityFloor,
        pruneAfterDays,
      });
      log(
        'INFO',
        `janitor: rescored=${r.rescored} flagged=${r.flagged} unflagged=${r.unflagged} pruned=${r.pruned}`,
      );
    } catch (err) {
      log('WARN', `janitor failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // Run once shortly after activation, then on the configured cadence.
  setTimeout(tick, 60_000);
  janitorTimer = setInterval(tick, days * 24 * 60 * 60 * 1000);
}

/** Live status bar states: compressing shows a spinner; error shows in red. */
function setStatusBarState(state: 'idle' | 'compressing' | 'error'): void {
  if (!statusBarItem) return;
  if (state === 'compressing') {
    statusBarItem.text = '$(loading~spin) MEM compressing…';
    statusBarItem.backgroundColor = undefined;
  } else if (state === 'error') {
    statusBarItem.text = '$(error) MEM error';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else {
    updateStatusBar();
    statusBarItem.backgroundColor = undefined;
  }
}

function updateStatusBar(): void {
  if (!statusBarItem) return;
  const stats = store.getStats();
  const cfg = getConfig();
  const glyph = fillGlyph(stats.totalSessions, cfg.maxStoredSessions);
  const health = computeHealth(store.getAllSessions());
  const captureState = capture?.eventCount > 0 ? '●' : '○';
  const scope = cfg.enterpriseMode ? 'enterprise' : cfg.scope;
  statusBarItem.text = `$(history) MEM ${captureState} ${glyph} ${health.score}`;
  statusBarItem.tooltip = [
    'GHCP-MEM',
    `${stats.workspaceSessions} session(s) in this workspace, ${stats.totalSessions} total`,
    `Memory health: ${health.score}/100`,
    `Scope: ${scope}`,
    `Capture: ${captureState === '●' ? 'active' : 'idle'}`,
    `Pending events: ${capture.eventCount}`,
    `Total redactions: ${stats.totalRedactions}`,
    'Click to capture a snapshot',
  ].join('\n');
}

async function maybeShowPrivacyWizard(context: vscode.ExtensionContext): Promise<void> {
  const key = 'ghcpMem.privacyWizardCompleted';
  if (context.globalState.get<boolean>(key)) return;
  const choice = await vscode.window.showInformationMessage(
    'GHCP-MEM privacy setup can lock down capture, snippets, terminal commands, and exports before you start.',
    'Run Privacy Wizard',
    'Later',
  );
  if (choice === 'Run Privacy Wizard') {
    await runPrivacyWizard(context);
  }
  await context.globalState.update(key, true);
}

async function runPrivacyWizard(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('ghcpMem');
  const updates: Record<string, boolean> = {};
  const questions: Array<[string, string, boolean]> = [
    ['captureFileEdits', 'Capture file edits?', cfg.get('captureFileEdits', true)],
    ['captureDiagnostics', 'Capture diagnostics?', cfg.get('captureDiagnostics', true)],
    [
      'captureTerminalCommands',
      'Capture terminal commands?',
      cfg.get('captureTerminalCommands', true),
    ],
    [
      'captureCodeSnippets',
      'Store code snippets from edits?',
      cfg.get('captureCodeSnippets', true),
    ],
    ['allowMcpWriteAccess', 'Allow MCP write tools?', cfg.get('allowMcpWriteAccess', false)],
    ['allowTeamExport', 'Allow team export?', cfg.get('allowTeamExport', true)],
    [
      'previewBeforePersist',
      'Preview each memory before it is persisted?',
      cfg.get('previewBeforePersist', false),
    ],
  ];

  for (const [key, label, current] of questions) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Yes', value: true },
        { label: 'No', value: false },
      ],
      {
        title: label,
        placeHolder: current ? 'Currently enabled' : 'Currently disabled',
        ignoreFocusOut: true,
      },
    );
    if (!pick) continue;
    updates[key] = pick.value;
  }

  const enterprise = await vscode.window.showQuickPick(
    [
      { label: 'Enable enterprise mode', value: true },
      { label: 'Keep standard mode', value: false },
    ],
    {
      title: 'Enable strict enterprise mode?',
      placeHolder: cfg.get('enterpriseMode', false) ? 'Currently enabled' : 'Currently disabled',
      ignoreFocusOut: true,
    },
  );
  if (enterprise) updates.enterpriseMode = enterprise.value;

  for (const [key, value] of Object.entries(updates)) {
    await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
  }
  await context.globalState.update('ghcpMem.privacyWizardCompleted', true);
  vscode.window.showInformationMessage('GHCP-MEM: Privacy settings updated.');
}

function buildSessionPreview(session: CompressedSession): string {
  const lines = [
    '# GHCP-MEM Preview',
    '',
    `- Session: \`${session.id}\``,
    `- Workspace: ${session.workspaceName}`,
    `- Type: ${session.observationType}`,
    `- Redactions: ${session.redactionCount}`,
    `- Events captured: ${session.rawEventCount}`,
    '',
    '## Summary',
    session.summary || '_No summary available_',
    '',
    '## Files',
    ...(session.keyFiles.length ? session.keyFiles.map((f) => `- ${f}`) : ['- _None_']),
    '',
    '## Decisions',
    ...(session.decisions.length ? session.decisions.map((d) => `- ${d}`) : ['- _None_']),
  ];
  return lines.join('\n');
}

function buildAuditReport(store: ContextStore): string {
  const sessions = store
    .getAllSessions()
    .slice()
    .sort((a, b) => b.endTime - a.endTime);
  const lines = [
    '# GHCP-MEM Memory Audit',
    '',
    '| Session | Workspace | Captured | Redactions | Retention reason |',
    '|---|---|---:|---:|---|',
  ];
  for (const s of sessions.slice(0, 100)) {
    const reason = s.userTags.includes('pinned')
      ? 'Pinned'
      : s.decisions.length > 0
        ? 'Decision-bearing'
        : s.keyTopics.length > 0
          ? 'Topic-bearing'
          : 'Recent activity';
    lines.push(
      `| \`${s.id.substring(0, 8)}\` | ${s.workspaceName} | ${s.rawEventCount} | ${s.redactionCount} | ${reason} |`,
    );
  }
  return lines.join('\n');
}

async function recordSuccessAndMaybePromptForRating(): Promise<void> {
  if (!reviewStateStore || reviewPromptInFlight) return;
  const state = reviewStateStore.get<ReviewPromptState>(REVIEW_PROMPT_KEY) ?? {
    successes: 0,
    rated: false,
    doNotAskAgain: false,
  };
  if (state.rated || state.doNotAskAgain) return;

  state.successes += 1;
  await reviewStateStore.update(REVIEW_PROMPT_KEY, state);

  const now = Date.now();
  const cooldownActive =
    typeof state.lastPromptAt === 'number' && now - state.lastPromptAt < REVIEW_PROMPT_COOLDOWN_MS;
  const stats = store.getStats();
  const eligible =
    state.successes >= REVIEW_PROMPT_MIN_SUCCESSES &&
    stats.totalSessions >= REVIEW_PROMPT_MIN_SESSIONS &&
    !cooldownActive;
  if (!eligible) return;

  reviewPromptInFlight = true;
  try {
    const choice = await vscode.window.showInformationMessage(
      'Is GHCP-MEM helping your workflow? A Marketplace rating helps more developers discover it.',
      'Rate GHCP-MEM',
      'Later',
      "Don't Ask Again",
    );
    state.lastPromptAt = now;
    if (choice === 'Rate GHCP-MEM') {
      state.rated = true;
      await vscode.env.openExternal(vscode.Uri.parse(MARKETPLACE_REVIEW_URL));
    } else if (choice === "Don't Ask Again") {
      state.doNotAskAgain = true;
    }
    await reviewStateStore.update(REVIEW_PROMPT_KEY, state);
  } finally {
    reviewPromptInFlight = false;
  }
}

async function writeStartupContext(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return;
  const dir = vscode.Uri.joinPath(ws.uri, '.github', 'instructions');
  const file = vscode.Uri.joinPath(dir, 'session-memory.instructions.md');
  const contextText = provider.buildStartupContext();

  // If there are no sessions yet, remove any stale file so Copilot doesn't
  // see outdated context from a previous install or workspace.
  if (!contextText) {
    try {
      await vscode.workspace.fs.delete(file);
    } catch {
      /* file may not exist, that's fine */
    }
    lastStartupContextHash = '';
    return;
  }

  const content = `---
applyTo: "**"
description: "Auto-generated session context from GHCP-MEM. Summaries of recent coding sessions for continuity."
---

${contextText}
`;
  // Skip the write if content hasn't changed — avoids unnecessary file churn
  // and git-dirty noise on every compression pass.
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  if (contentHash === lastStartupContextHash) return;
  try {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(file, Buffer.from(content, 'utf-8'));
    lastStartupContextHash = contentHash;
    // Ensure the auto-generated file is git-ignored so it is never committed.
    await ensureGitIgnored(ws.uri, '.github/instructions/session-memory.instructions.md');
    log(
      'INFO',
      `Startup context written: ${provider.buildStartupContext().split('###').length - 1} session(s) injected.`,
    );
  } catch (err) {
    log(
      'ERROR',
      `writeStartupContext failed — Copilot will not have prior session context: ${err}`,
    );
  }
}

/** Write session context into CLAUDE.md and .cursor/rules for cross-editor continuity. */
async function writeCrossEditorContext(): Promise<void> {
  const contextText = provider.buildStartupContext();
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return;

  const START = '<!-- GHCP-MEM:START -->';
  const END = '<!-- GHCP-MEM:END -->';
  // When there's nothing to inject, remove any previously-written block so a
  // deleted rules file / cleared store doesn't leave stale guidance behind.
  const block = contextText ? `${START}\n${contextText}\n${END}` : '';

  const targets: [vscode.Uri, string][] = [
    [vscode.Uri.joinPath(ws.uri, 'CLAUDE.md'), 'CLAUDE.md'],
    [vscode.Uri.joinPath(ws.uri, '.cursor', 'rules'), '.cursor/rules'],
  ];

  const contentHash = crypto.createHash('sha256').update(contextText).digest('hex');
  if (contentHash === lastClaudeMdHash) return;

  for (const [fileUri, gitIgnorePath] of targets) {
    try {
      let existing = '';
      try {
        existing = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf-8');
      } catch {}
      const startIdx = existing.indexOf(START);
      const endIdx = existing.indexOf(END);
      let updated: string;
      if (startIdx !== -1 && endIdx !== -1) {
        // Replace (or, when block is empty, strip) the managed region.
        const before = existing.slice(0, startIdx);
        const after = existing.slice(endIdx + END.length);
        updated = block ? before + block + after : (before + after).replace(/\n{3,}/g, '\n\n');
      } else if (block) {
        updated = existing ? `${existing}\n\n${block}\n` : `${block}\n`;
      } else {
        continue; // nothing to write and no existing block to strip.
      }
      const dir = vscode.Uri.joinPath(fileUri, '..');
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(updated, 'utf-8'));
      await ensureGitIgnored(ws.uri, gitIgnorePath);
    } catch (err) {
      log('WARN', `Could not write cross-editor context to ${gitIgnorePath}: ${err}`);
    }
  }
  lastClaudeMdHash = contentHash;
}

/**
 * Watch the team-shared project-rules file so hand-edits (or edits from
 * another tool / teammate's pull) refresh the in-memory cache and rewrite the
 * generated context. The rules file itself is committed; only the generated
 * files it feeds are gitignored, so this never creates a write loop.
 */
function watchProjectRules(context: vscode.ExtensionContext): void {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return;
  const pattern = new vscode.RelativePattern(ws, '.github/memory/rules.md');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const onChange = async () => {
    await provider.refreshProjectRules();
    if (!getConfig().autoInjectStartupContext) return;
    await writeStartupContext();
    await writeCrossEditorContext();
  };
  watcher.onDidCreate(() => void onChange());
  watcher.onDidChange(() => void onChange());
  watcher.onDidDelete(() => void onChange());
  context.subscriptions.push(watcher);
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
    const lines = existing.split('\n').map((l) => l.trim());
    if (lines.includes(entry)) return;
    const updated =
      existing.endsWith('\n') || existing === ''
        ? existing + entry + '\n'
        : existing + '\n' + entry + '\n';
    await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(updated, 'utf-8'));
  } catch {
    // Non-fatal — ignore FS errors in restricted sandboxes.
  }
}

function formatAgoSimple(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(diffMs / 3600000);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(diffMs / 86400000)}d ago`;
}

function formatReport(
  stats: ReturnType<ContextStore['getStats']>,
  recent: CompressedSession[],
): string {
  const lines: string[] = [
    '# GHCP-MEM — Context Report',
    '',
    '## Statistics',
    `- Total sessions: **${stats.totalSessions}**`,
    `- This workspace: **${stats.workspaceSessions}**`,
    `- Total redactions applied: **${stats.totalRedactions}**`,
  ];
  if (stats.oldestSession)
    lines.push(`- Oldest session: ${new Date(stats.oldestSession).toLocaleString()}`);
  if (stats.newestSession)
    lines.push(`- Newest session: ${new Date(stats.newestSession).toLocaleString()}`);
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
  if (typeof s.confidence === 'number') {
    const eff = effectiveConfidence(s) ?? s.confidence;
    const emoji = eff >= 0.75 ? '🟢' : eff >= 0.5 ? '🟡' : '🔴';
    const mode = s.compressorMode ? ` (${s.compressorMode})` : '';
    const trunc = s.eventLogTruncated ? ', event log truncated' : '';
    const decayHint =
      Math.abs(eff - s.confidence) > 0.02
        ? ` — original ${s.confidence.toFixed(2)}, decayed to ${eff.toFixed(2)}`
        : '';
    lines.push(`**Trust:** ${emoji} confidence ${eff.toFixed(2)}${mode}${trunc}${decayHint}`);
  }
  if (s.keyFiles.length) lines.push(`**Files:** ${s.keyFiles.join(', ')}`);
  if (s.keyTopics.length) lines.push(`**Topics:** ${s.keyTopics.join(', ')}`);
  if (s.decisions.length) {
    lines.push(`**Decisions:** ${renderClaimList(s.decisions, s.decisionEvidence)}`);
  }
  if (s.problemsSolved.length) {
    lines.push(`**Solved:** ${renderClaimList(s.problemsSolved, s.problemEvidence)}`);
  }
  if (s.userTags.length) lines.push(`**Tags:** ${s.userTags.join(', ')}`);
  if (s.azureContext) {
    const ac = s.azureContext;
    lines.push(
      '**Azure:** ' +
        [
          ac.subscriptionName && `sub=${ac.subscriptionName}`,
          ac.resourceGroup && `rg=${ac.resourceGroup}`,
          ac.subsystems?.length && `subsystems=${ac.subsystems.join(',')}`,
          ac.resourceIds?.length && `resources=${ac.resourceIds.length}`,
        ]
          .filter(Boolean)
          .join(' · '),
    );
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
    extraTags: string[] = [],
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
      [
        'Front Door in front of SWA for global cache + WAF',
        'System-assigned identity on SWA, no keys in code',
      ],
      [],
      ['iac-bicep', 'azd'],
      ['bicep', 'swa'],
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
      ['azd', 'deployment'],
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
      ['functions'],
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
      ['aks', 'helm'],
    ),
    mk(
      15 * 60000,
      'security',
      'Hardened Azure Storage account: disabled shared-key access, enabled OAuth-only data plane, rotated the one remaining SAS token and replaced it with a user-delegation SAS minted from managed identity.',
      ['infra/modules/storage.bicep', 'src/api/blobClient.ts'],
      ['azure-storage', 'sas', 'rbac', 'managed-identity'],
      [
        'Shared-key disabled everywhere',
        'All SAS tokens must be user-delegation, never account-key',
      ],
      ['Inventoried and replaced 1 hardcoded SAS token'],
      ['iac-bicep', 'storage' as AzureSubsystem],
      ['storage', 'security'],
    ),
  ];
}
