import * as vscode from 'vscode';
import { ContextStore } from './contextStore';
import { CompressedSession } from './types';

/** Color palette keyed by observationType — WCAG AA-safe on both light and dark. */
const TYPE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  feature: { bg: '#1a4731', border: '#3fb950', text: '#56d364' },
  bugfix: { bg: '#4a1717', border: '#f85149', text: '#ff7b72' },
  refactor: { bg: '#0d2e5c', border: '#58a6ff', text: '#79c0ff' },
  docs: { bg: '#2c1e5c', border: '#bc8cff', text: '#d2a8ff' },
  test: { bg: '#3d2600', border: '#e3b341', text: '#f0c040' },
  chore: { bg: '#1c1c1c', border: '#6e7681', text: '#8b949e' },
  research: { bg: '#3a2700', border: '#ffa657', text: '#ffb77c' },
  config: { bg: '#002244', border: '#79c0ff', text: '#a5d6ff' },
  security: { bg: '#4a2900', border: '#ff7b72', text: '#ffa198' },
  deployment: { bg: '#1a3320', border: '#56d364', text: '#7ee787' },
  infra: { bg: '#2d1f3d', border: '#d2a8ff', text: '#e2c0ff' },
  unknown: { bg: '#1c1c1c', border: '#484f58', text: '#6e7681' },
};

/**
 * Interactive visual memory timeline — a full WebviewPanel showing every session
 * as a color-coded card grouped by day. Supports type filtering, click-to-detail,
 * and a live search bar.
 */
export class MemoryTimelinePanel {
  private static instance: MemoryTimelinePanel | undefined;
  private panel: vscode.WebviewPanel;
  private storeListener: vscode.Disposable;

  private constructor(
    private readonly store: ContextStore,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'batonTimeline',
      '🧠 Baton Timeline',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      },
    );

    this.panel.iconPath = new vscode.ThemeIcon('history');

    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      this.storeListener.dispose();
      MemoryTimelinePanel.instance = undefined;
    });

    this.storeListener = store.onChange(() => this.refresh());
    this.refresh();
  }

  static show(store: ContextStore, context: vscode.ExtensionContext): void {
    if (MemoryTimelinePanel.instance) {
      MemoryTimelinePanel.instance.panel.reveal(vscode.ViewColumn.One);
      MemoryTimelinePanel.instance.refresh();
    } else {
      MemoryTimelinePanel.instance = new MemoryTimelinePanel(store, context);
    }
  }

  private refresh(): void {
    const sessions = this.store.getAllSessions().sort((a, b) => b.startTime - a.startTime);
    this.panel.webview.html = this.buildHtml(sessions);
  }

  /**
   * Render a single horizontal "learned ranker" card showing the current
   * adaptive weights and feedback sample counts. Empty string when the
   * learner is still in cold-start (defaults all 1.0).
   */
  private buildAdaptiveCard(): string {
    const weights = this.store.getAdaptiveWeights();
    const samples = this.store.getAdaptiveSampleCount();
    const hasDelta = Object.values(weights).some((v) => Math.abs(v - 1) > 0.001);
    if (!hasDelta && samples.accepted + samples.rejected === 0) return '';
    const cells = Object.entries(weights)
      .map(([name, w]) => {
        const delta = w - 1;
        const color = delta > 0.02 ? '#3fb950' : delta < -0.02 ? '#ff7b72' : '#8b949e';
        const sign = delta > 0 ? '+' : '';
        return `<span class="weight-chip" title="${name} multiplier">${name}: <strong style="color:${color}">${w.toFixed(2)} (${sign}${(delta * 100).toFixed(0)}%)</strong></span>`;
      })
      .join('');
    const samplesText = `${samples.accepted} 👍 / ${samples.rejected} 👎`;
    const note =
      samples.accepted + samples.rejected < 10
        ? ' <em>(cold-start — defaults active until 10+ samples)</em>'
        : '';
    return `<div class="adaptive-row" title="Adaptive ranking weights learned from your accept/reject feedback (Phase 5)">
      <strong>🎚 Learned ranker:</strong> ${cells}
      <span class="samples">${samplesText}${note}</span>
    </div>`;
  }

  private handleMessage(msg: { type: string; id?: string; query?: string; tag?: string }): void {
    if (msg.type === 'openDetail' && msg.id) {
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@baton /detail ${msg.id}`,
      });
    } else if (msg.type === 'copyId' && msg.id) {
      vscode.env.clipboard.writeText(msg.id);
      vscode.window.setStatusBarMessage(
        `$(check) Copied session ID: ${msg.id.substring(0, 8)}`,
        2500,
      );
    } else if (msg.type === 'openSearch' && msg.query) {
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@baton /search ${msg.query}`,
      });
    } else if (msg.type === 'togglePin' && msg.id) {
      void (async () => {
        const s = this.store.getById(msg.id!);
        if (!s) return;
        if (s.userTags.includes('pinned')) {
          await this.store.removeTag(msg.id!, 'pinned');
          vscode.window.setStatusBarMessage('Baton: session unpinned', 2000);
        } else {
          await this.store.addTag(msg.id!, 'pinned');
          vscode.window.setStatusBarMessage('Baton: session pinned', 2000);
        }
      })();
    } else if (msg.type === 'addTag' && msg.id) {
      void (async () => {
        const tag = (
          await vscode.window.showInputBox({
            prompt: 'Tag this session',
            placeHolder: 'e.g. wip, reference, debug-rabbit-hole',
            validateInput: (v) => (v.trim() ? null : 'Tag cannot be empty'),
          })
        )?.trim();
        if (!tag) return;
        await this.store.addTag(msg.id!, tag);
        vscode.window.setStatusBarMessage(`Baton: tagged with #${tag}`, 2000);
      })();
    } else if (msg.type === 'deleteSession' && msg.id) {
      void (async () => {
        const s = this.store.getById(msg.id!);
        if (!s) return;
        const summary = s.summary.length > 80 ? s.summary.substring(0, 77) + '…' : s.summary;
        const choice = await vscode.window.showWarningMessage(
          `Prune this session from memory?\n\n${summary}`,
          { modal: true },
          'Delete',
        );
        if (choice !== 'Delete') return;
        await this.store.deleteSession(msg.id!);
        vscode.window.setStatusBarMessage('Baton: session pruned', 2000);
      })();
    } else if (msg.type === 'verify' && msg.id) {
      // Surface verification through the chat participant so the UX stays
      // consistent with @baton /verify and we don't duplicate the renderer.
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@baton /verify ${msg.id}`,
      });
    } else if (msg.type === 'correct' && msg.id) {
      void (async () => {
        const text = (
          await vscode.window.showInputBox({
            prompt:
              'Correction text (a new linked session will be recorded; the original is superseded)',
            placeHolder: 'e.g. "The actual decision was to use Redis Sentinel, not Cluster"',
            validateInput: (v) => (v.trim() ? null : 'Correction cannot be empty'),
          })
        )?.trim();
        if (!text) return;
        vscode.commands.executeCommand('workbench.action.chat.open', {
          query: `@baton /correct ${msg.id} ${text}`,
        });
      })();
    } else if (msg.type === 'retract' && msg.id) {
      void (async () => {
        const s = this.store.getById(msg.id!);
        if (!s) return;
        if (s.retracted) {
          await this.store.undoRetract(s.id);
          vscode.window.setStatusBarMessage('Baton: retraction undone', 2500);
          return;
        }
        const reason = await vscode.window.showInputBox({
          prompt: `Retract session ${s.id.substring(0, 8)} (reason optional)`,
          placeHolder: 'e.g. "Decision was wrong — see ADR-014"',
        });
        if (reason === undefined) return; // user pressed Esc
        await this.store.setRetracted(s.id, reason.trim() || undefined);
        vscode.window.setStatusBarMessage('Baton: session retracted', 2500);
      })();
    } else if (msg.type === 'gotoFile' && msg.id) {
      // msg.id encodes "<sessionId>::<workspaceRelativePath>" so the renderer
      // doesn't need a separate field. Defensive parsing — refuse anything
      // that doesn't split cleanly OR carries an unsafe path. The path
      // check mirrors `packs.ts:isUnsafeRelPath` so a malicious imported
      // pack cannot use a click on a file chip to open an arbitrary path
      // outside the workspace root.
      const idx = msg.id.indexOf('::');
      if (idx === -1) return;
      const relPath = msg.id.slice(idx + 2).trim();
      if (!relPath) return;
      if (
        relPath.startsWith('/') ||
        /^[a-zA-Z]:[\\/]/.test(relPath) ||
        relPath.startsWith('file://') ||
        relPath.split(/[\\/]/).includes('..')
      ) {
        vscode.window.setStatusBarMessage(
          `Baton: refused unsafe path "${relPath.substring(0, 60)}"`,
          4000,
        );
        return;
      }
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) return;
      const target = vscode.Uri.joinPath(ws.uri, relPath);
      void vscode.window.showTextDocument(target).then(undefined, () => {
        vscode.window.setStatusBarMessage(`Baton: cannot open ${relPath}`, 3000);
      });
    }
  }

  private buildHtml(sessions: CompressedSession[]): string {
    const stats = {
      total: sessions.length,
      types: new Map<string, number>(),
      files: new Set<string>(),
    };
    for (const s of sessions) {
      stats.types.set(s.observationType, (stats.types.get(s.observationType) ?? 0) + 1);
      s.keyFiles.forEach((f) => stats.files.add(f));
    }

    // Group sessions by calendar day
    const groups = new Map<string, CompressedSession[]>();
    for (const s of sessions) {
      const key = new Date(s.startTime).toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const arr = groups.get(key) ?? [];
      arr.push(s);
      groups.set(key, arr);
    }

    const typeFilterPills = Array.from(new Set(sessions.map((s) => s.observationType)))
      .map((t) => {
        const c = TYPE_COLORS[t] ?? TYPE_COLORS.unknown;
        return `<button class="type-pill" data-type="${t}" style="border-color:${c.border};color:${c.text}" onclick="toggleType('${t}')">${t} <span class="pill-count">${stats.types.get(t) ?? 0}</span></button>`;
      })
      .join('');

    const dayHtml = Array.from(groups.entries())
      .map(([day, daySessions]) => {
        const cards = daySessions.map((s) => this.buildCard(s)).join('');
        return `
        <div class="day-group" data-types="${daySessions.map((s) => s.observationType).join(',')}">
          <h2 class="day-label">
            <span class="day-icon">📅</span> ${day}
            <span class="day-count">${daySessions.length} session${daySessions.length !== 1 ? 's' : ''}</span>
          </h2>
          <div class="cards-row">${cards}</div>
        </div>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Baton Timeline</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #0d1117);
    --fg: var(--vscode-editor-foreground, #e6edf3);
    --border: var(--vscode-panel-border, #30363d);
    --surface: var(--vscode-editorWidget-background, #161b22);
    --surface2: var(--vscode-list-hoverBackground, #1c2128);
    --accent: var(--vscode-focusBorder, #1f6feb);
    --input-bg: var(--vscode-input-background, #0d1117);
    --input-fg: var(--vscode-input-foreground, #e6edf3);
    --input-border: var(--vscode-input-border, #30363d);
    --muted: var(--vscode-descriptionForeground, #8b949e);
    --radius: 8px;
    --card-width: 320px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    line-height: 1.6;
    padding: 0;
  }
  .header {
    position: sticky; top: 0; z-index: 100;
    background: var(--bg); border-bottom: 1px solid var(--border);
    padding: 12px 20px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .header-row {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  }
  .logo { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
  .logo span { color: var(--accent); }
  .stats { color: var(--muted); font-size: 12px; }
  .search-box {
    flex: 1; min-width: 220px;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: var(--radius);
    padding: 6px 12px; font-size: 13px; outline: none;
    transition: border-color 0.15s;
  }
  .search-box:focus { border-color: var(--accent); }
  .type-filters { display: flex; gap: 6px; flex-wrap: wrap; }
  .type-pill {
    padding: 3px 10px; border-radius: 20px; border: 1px solid;
    background: transparent; cursor: pointer; font-size: 11px; font-weight: 600;
    transition: all 0.15s; opacity: 0.7;
  }
  .type-pill:hover, .type-pill.active { opacity: 1; }
  .type-pill.active { background: rgba(255,255,255,0.08); }
  .pill-count { opacity: 0.7; }
  .clear-btn {
    padding: 4px 12px; border-radius: var(--radius);
    background: var(--surface2); color: var(--muted);
    border: 1px solid var(--border); cursor: pointer; font-size: 12px;
  }
  .clear-btn:hover { color: var(--fg); }
  .adaptive-row {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    padding: 6px 0 0 0; font-size: 11px; color: var(--muted);
    border-top: 1px dashed var(--border); margin-top: 6px;
  }
  .weight-chip {
    padding: 1px 8px; border-radius: 10px;
    background: rgba(255,255,255,0.04); color: var(--fg);
    border: 1px solid var(--border); font-family: var(--vscode-editor-font-family, monospace);
  }
  .samples { color: var(--muted); margin-left: auto; }
  .samples em { color: var(--muted); opacity: 0.8; }
  .timeline { padding: 20px; max-width: 1400px; margin: 0 auto; }
  .day-group { margin-bottom: 32px; }
  .day-group.hidden { display: none; }
  .day-label {
    font-size: 15px; font-weight: 600; color: var(--muted);
    margin-bottom: 12px; padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 8px;
  }
  .day-icon { font-size: 16px; }
  .day-count {
    margin-left: auto; font-size: 11px; font-weight: 400;
    background: var(--surface2); padding: 2px 8px; border-radius: 20px;
  }
  .cards-row {
    display: flex; flex-wrap: wrap; gap: 12px;
  }
  .session-card {
    width: var(--card-width); border-radius: var(--radius);
    border: 1px solid; padding: 14px;
    cursor: pointer; transition: transform 0.12s, box-shadow 0.12s;
    position: relative; overflow: hidden;
  }
  .session-card::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0;
    width: 3px;
  }
  .session-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  .session-card.filtered-out { display: none; }
  .card-header {
    display: flex; align-items: center; gap: 6px;
    margin-bottom: 8px; flex-wrap: wrap;
  }
  .type-badge {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    padding: 2px 7px; border-radius: 4px; letter-spacing: 0.5px;
    border: 1px solid currentColor;
  }
  .session-time { color: var(--muted); font-size: 11px; margin-left: auto; }
  .session-id {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px; color: var(--muted);
    background: var(--surface); padding: 1px 5px; border-radius: 3px;
    cursor: copy; transition: color 0.1s;
  }
  .session-id:hover { color: var(--fg); }
  .session-summary {
    font-size: 12px; line-height: 1.5; color: var(--fg);
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .session-meta { display: flex; flex-wrap: wrap; gap: 4px; }
  .meta-chip {
    font-size: 10px; padding: 1px 6px; border-radius: 3px;
    background: var(--surface2); color: var(--muted);
    max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .meta-chip.file { color: #79c0ff; }
  .meta-chip.topic { color: #d2a8ff; }
  .meta-chip.tag { color: #e3b341; }
  .meta-chip.branch { color: #7ee787; font-style: italic; }
  .status-row {
    display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px;
  }
  .trust-chip, .status-chip, .usage-chip {
    font-size: 10px; padding: 1px 6px; border-radius: 10px;
    background: rgba(255,255,255,0.05); color: var(--fg);
    border: 1px solid var(--border);
  }
  .status-chip.superseded { color: #ffa657; border-color: #ffa657; }
  .status-chip.retracted { color: #ff7b72; border-color: #ff7b72; }
  .status-chip.correction { color: #d2a8ff; border-color: #d2a8ff; }
  .usage-chip { color: var(--muted); }
  .decisions {
    margin: 4px 0 6px 0; padding: 0 0 0 14px;
    font-size: 11px; color: var(--fg);
  }
  .decision-row { margin-bottom: 4px; line-height: 1.45; }
  .ev-chip {
    font-size: 10px; padding: 0 4px; margin-left: 4px;
    background: var(--surface); border: 1px solid var(--border);
    color: #79c0ff; cursor: pointer; border-radius: 3px;
  }
  .ev-chip:hover { background: var(--surface2); }
  .retracted-card { opacity: 0.55; filter: grayscale(0.4); }
  .superseded-card { opacity: 0.85; }
  .card-actions {
    position: absolute; top: 8px; right: 8px;
    display: none; gap: 3px;
  }
  .session-card:hover .card-actions { display: flex; }
  .card-btn {
    font-size: 12px; padding: 2px 6px; border-radius: 4px;
    background: var(--surface); border: 1px solid var(--border);
    color: var(--fg); cursor: pointer; line-height: 1.2; min-width: 22px;
  }
  .card-btn:hover { background: var(--surface2); transform: scale(1.08); }
  .card-btn[data-action="delete"]:hover { color: #ff7b72; border-color: #ff7b72; }
  .card-btn[data-action="pin"]:hover { color: #e3b341; border-color: #e3b341; }
  .session-card.pinned {
    box-shadow: inset 0 0 0 2px #e3b341;
  }
  .pinned-indicator {
    font-size: 11px; opacity: 0.9;
  }
  .empty-state {
    text-align: center; padding: 60px 20px; color: var(--muted);
  }
  .empty-state .icon { font-size: 48px; display: block; margin-bottom: 16px; }
  .no-match { text-align: center; padding: 40px; color: var(--muted); display: none; }
</style>
</head>
<body>
<div class="header">
  <div class="header-row">
    <div class="logo">🧠 <span>GHCP</span>-MEM</div>
    <div class="stats">${sessions.length} sessions · ${stats.files.size} files touched</div>
    <input class="search-box" id="searchBox" placeholder="Search summaries, files, topics…" oninput="handleSearch(this.value)" />
    <button class="clear-btn" onclick="clearAll()">✕ Clear</button>
  </div>
  <div class="type-filters" id="typeFilters">${typeFilterPills}</div>
  ${this.buildAdaptiveCard()}
</div>

<div class="timeline" id="timeline">
  ${
    sessions.length === 0
      ? `
  <div class="empty-state">
    <span class="icon">🌱</span>
    <div>No sessions yet.</div>
    <div>Start coding and Baton will automatically capture your sessions.</div>
  </div>`
      : dayHtml
  }
  <div class="no-match" id="noMatch">No sessions match your filter.</div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let activeTypes = new Set();
  let searchText = '';

  function toggleType(type) {
    if (activeTypes.has(type)) activeTypes.delete(type);
    else activeTypes.add(type);
    document.querySelectorAll('.type-pill').forEach(p => {
      p.classList.toggle('active', activeTypes.has(p.dataset.type));
    });
    applyFilters();
  }

  function handleSearch(val) {
    searchText = val.toLowerCase().trim();
    applyFilters();
  }

  function clearAll() {
    activeTypes.clear();
    searchText = '';
    document.getElementById('searchBox').value = '';
    document.querySelectorAll('.type-pill').forEach(p => p.classList.remove('active'));
    applyFilters();
  }

  function applyFilters() {
    let visibleCount = 0;
    document.querySelectorAll('.session-card').forEach(card => {
      const type = card.dataset.type;
      const text = card.dataset.text || '';
      const typeMatch = activeTypes.size === 0 || activeTypes.has(type);
      const textMatch = !searchText || text.includes(searchText);
      const visible = typeMatch && textMatch;
      card.classList.toggle('filtered-out', !visible);
      if (visible) visibleCount++;
    });

    // Hide empty day groups
    document.querySelectorAll('.day-group').forEach(g => {
      const cards = g.querySelectorAll('.session-card:not(.filtered-out)');
      g.classList.toggle('hidden', cards.length === 0);
    });

    document.getElementById('noMatch').style.display = visibleCount === 0 ? 'block' : 'none';
  }

  document.addEventListener('click', e => {
    const idEl = e.target.closest('.session-id');
    if (idEl) {
      e.stopPropagation();
      vscode.postMessage({ type: 'copyId', id: idEl.dataset.fullId });
      idEl.textContent = '✓ copied!';
      setTimeout(() => { idEl.textContent = idEl.dataset.fullId?.substring(0, 8) + '…'; }, 1500);
      return;
    }
    const evBtn = e.target.closest('.ev-chip');
    if (evBtn) {
      e.stopPropagation();
      vscode.postMessage({ type: evBtn.dataset.action, id: evBtn.dataset.id });
      return;
    }
    const btn = e.target.closest('.card-btn');
    if (btn) {
      e.stopPropagation();
      const action = btn.dataset.action || 'open';
      const id = btn.dataset.id;
      switch (action) {
        case 'pin':       vscode.postMessage({ type: 'togglePin', id }); break;
        case 'tag':       vscode.postMessage({ type: 'addTag', id }); break;
        case 'delete':    vscode.postMessage({ type: 'deleteSession', id }); break;
        case 'verify':    vscode.postMessage({ type: 'verify', id }); break;
        case 'correct':   vscode.postMessage({ type: 'correct', id }); break;
        case 'retract':   vscode.postMessage({ type: 'retract', id }); break;
        case 'open':
        default:          vscode.postMessage({ type: 'openDetail', id }); break;
      }
      return;
    }
    const card = e.target.closest('.session-card');
    if (card) {
      vscode.postMessage({ type: 'openDetail', id: card.dataset.id });
    }
  });
</script>
</body>
</html>`;
  }

  private buildCard(s: CompressedSession): string {
    const c = TYPE_COLORS[s.observationType] ?? TYPE_COLORS.unknown;
    const time = new Date(s.startTime).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    const shortId = s.id.substring(0, 8);
    const isPinned = s.userTags.includes('pinned');
    const branchChip = s.branchName
      ? `<span class="meta-chip branch" title="git branch">⎇ ${htmlEscape(s.branchName)}</span>`
      : '';
    const metaChips = [
      branchChip,
      ...s.keyFiles
        .slice(0, 2)
        .map(
          (f) =>
            `<span class="meta-chip file" title="${htmlEscape(f)}">${htmlEscape(f.split('/').pop() ?? f)}</span>`,
        ),
      ...s.keyTopics
        .slice(0, 2)
        .map((t) => `<span class="meta-chip topic">${htmlEscape(t)}</span>`),
      ...s.userTags
        .filter((t) => t !== 'pinned')
        .slice(0, 2)
        .map((t) => `<span class="meta-chip tag">#${htmlEscape(t)}</span>`),
    ].join('');

    // Phase 2 inspector chips — trust badge, supersession, retraction.
    const trustChip =
      typeof s.confidence === 'number'
        ? (() => {
            const conf = s.confidence!;
            const emoji = conf >= 0.75 ? '🟢' : conf >= 0.5 ? '🟡' : '🔴';
            const mode = s.compressorMode ? ` ${s.compressorMode}` : '';
            const trunc = s.eventLogTruncated ? ' · truncated' : '';
            return `<span class="trust-chip" title="Trust score${mode}${trunc} — set at compression time">${emoji} ${conf.toFixed(2)}</span>`;
          })()
        : '';
    const supersededChip = s.supersededBy
      ? `<span class="status-chip superseded" title="Superseded by ${s.supersededBy.substring(0, 8)}">⤴ superseded</span>`
      : '';
    const correctionChip = s.correctionOf
      ? `<span class="status-chip correction" title="Correction of ${s.correctionOf.substring(0, 8)}">✏️ correction</span>`
      : '';
    const retractedChip = s.retracted
      ? `<span class="status-chip retracted" title="Retracted${s.retractedReason ? ': ' + s.retractedReason : ''}">🚫 retracted</span>`
      : '';
    const usageChip = (() => {
      const u = s.usage;
      if (!u || u.retrieved + u.accepted + u.rejected === 0) return '';
      const parts = [];
      if (u.retrieved) parts.push(`${u.retrieved}× retrieved`);
      if (u.accepted) parts.push(`👍${u.accepted}`);
      if (u.rejected) parts.push(`👎${u.rejected}`);
      return `<span class="usage-chip" title="Local reinforcement counters">${parts.join(' · ')}</span>`;
    })();
    const statusRow = [trustChip, supersededChip, correctionChip, retractedChip, usageChip]
      .filter(Boolean)
      .join(' ');

    // Per-decision evidence chips — clickable to jump straight to the file.
    const evidenceRow = (() => {
      if (!s.decisions.length) return '';
      const items = s.decisions
        .slice(0, 3)
        .map((text, i) => {
          const ev = s.decisionEvidence?.[i];
          const files = ev
            ? Array.from(new Set(ev.map((e) => e.filePath).filter((f): f is string => !!f))).slice(
                0,
                2,
              )
            : [];
          const fileChips = files
            .map(
              (f) =>
                `<button class="ev-chip" data-action="gotoFile" data-id="${htmlEscape(s.id + '::' + f)}" title="Open ${htmlEscape(f)}">📎 ${htmlEscape(f.split('/').pop() ?? f)}</button>`,
            )
            .join('');
          const dec = htmlEscape(text.length > 100 ? text.substring(0, 97) + '…' : text);
          return `<li class="decision-row">${dec}${fileChips ? ' ' + fileChips : ''}</li>`;
        })
        .join('');
      return `<ul class="decisions">${items}</ul>`;
    })();

    // Build a searchable text blob for client-side filtering
    const searchBlob = [
      s.summary,
      ...s.keyFiles,
      ...s.keyTopics,
      ...s.decisions,
      ...s.userTags,
      s.branchName ?? '',
    ]
      .join(' ')
      .toLowerCase()
      .replace(/"/g, '&quot;');

    const pinnedClass = isPinned ? ' pinned' : '';
    const retractedClass = s.retracted ? ' retracted-card' : '';
    const supersededClass = s.supersededBy ? ' superseded-card' : '';
    const pinIcon = isPinned ? '<span class="pinned-indicator" title="Pinned">📌</span>' : '';
    const retractLabel = s.retracted ? '↩' : '🚫';
    const retractTitle = s.retracted
      ? 'Undo retraction'
      : 'Retract this session (excluded from retrieval + injection)';

    return `<div class="session-card${pinnedClass}${retractedClass}${supersededClass}" data-id="${s.id}" data-type="${s.observationType}" data-text="${searchBlob}"
      style="background:${c.bg};border-color:${c.border}">
      <div style="position:absolute;left:0;top:0;bottom:0;width:3px;background:${c.border};border-radius:var(--radius) 0 0 var(--radius)"></div>
      <div class="card-header">
        <span class="type-badge" style="color:${c.text};border-color:${c.border}">${s.observationType}</span>
        ${pinIcon}
        <span class="session-time">${time}</span>
        <span class="session-id" data-full-id="${s.id}" title="Click to copy full ID">${shortId}…</span>
      </div>
      <div class="card-actions">
        <button class="card-btn" data-action="verify" data-id="${s.id}" title="Re-verify grounding against the current workspace">🔍</button>
        <button class="card-btn" data-action="correct" data-id="${s.id}" title="Record a correction (linked, supersedes original)">✏️</button>
        <button class="card-btn" data-action="retract" data-id="${s.id}" title="${retractTitle}">${retractLabel}</button>
        <button class="card-btn" data-action="pin" data-id="${s.id}" title="${isPinned ? 'Unpin session' : 'Pin session (kept on top + boosted in startup brief)'}">${isPinned ? '📌' : '📌'}</button>
        <button class="card-btn" data-action="tag" data-id="${s.id}" title="Add user tag">🏷</button>
        <button class="card-btn" data-action="delete" data-id="${s.id}" title="Prune this session">🗑</button>
        <button class="card-btn" data-action="open" data-id="${s.id}" title="Open detail">→</button>
      </div>
      <div class="session-summary">${htmlEscape(s.summary)}</div>
      ${statusRow ? `<div class="status-row">${statusRow}</div>` : ''}
      ${evidenceRow}
      ${metaChips ? `<div class="session-meta">${metaChips}</div>` : ''}
    </div>`;
  }
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
