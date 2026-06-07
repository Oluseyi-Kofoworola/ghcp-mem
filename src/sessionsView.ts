import * as vscode from 'vscode';
import { ContextStore } from './contextStore';
import { CompressedSession, ObservationType } from './types';
import { getRepoScopeSync } from './repoScope';

/**
 * Active filter state for the sidebar tree.
 *
 * `setFilter`/`clearFilter` are public so a command can wire a quick-filter
 * bar UX (input box → set filter → refresh).
 */
export interface TreeFilter {
  text?: string;
  type?: ObservationType;
  tag?: string;
  sinceDays?: number;
  scope?: 'all' | 'workspace' | 'repo';
}

/**
 * Tree view in the sidebar showing stored sessions grouped by date.
 * This is something claude-mem only provides via an external port-37777 web
 * viewer — here it's native VS Code with no server.
 */
export class SessionsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;
  private storeListener: vscode.Disposable;
  private filter: TreeFilter = {};

  constructor(private readonly store: ContextStore) {
    this.storeListener = store.onChange(() => this.refresh());
  }

  refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  /** Set the active filter and refresh the view. */
  setFilter(next: TreeFilter): void {
    this.filter = { ...next };
    this.refresh();
  }

  /** Get a copy of the active filter (for the picker UX). */
  getFilter(): TreeFilter {
    return { ...this.filter };
  }

  /** Clear all filter state. */
  clearFilter(): void {
    this.filter = {};
    this.refresh();
  }

  hasActiveFilter(): boolean {
    return !!(
      this.filter.text ||
      this.filter.type ||
      this.filter.tag ||
      this.filter.sinceDays ||
      this.filter.scope
    );
  }

  getTreeItem(e: TreeNode): vscode.TreeItem {
    return e;
  }

  getChildren(e?: TreeNode): TreeNode[] {
    if (!e) {
      // Pool selection follows the scope filter.
      let pool: CompressedSession[];
      if (this.filter.scope === 'all') pool = this.store.getAllSessions();
      else if (this.filter.scope === 'repo') pool = this.store.getRepoSessions();
      else pool = this.store.getWorkspaceSessions();

      const filtered = this.applyFilter([...pool]).sort((a, b) => b.startTime - a.startTime);
      const stats = this.store.getStats();
      const nodes: TreeNode[] = [];

      const header = new TreeNode(
        `📊 ${filtered.length} shown · ${stats.totalSessions} total · ${stats.totalRedactions} redactions`,
        vscode.TreeItemCollapsibleState.None,
        'header',
      );
      header.tooltip = 'Baton statistics';
      nodes.push(header);

      if (this.hasActiveFilter()) {
        const desc = describeFilter(this.filter);
        const filterNode = new TreeNode(
          `🔎 Filter: ${desc}`,
          vscode.TreeItemCollapsibleState.None,
          'filter',
        );
        filterNode.tooltip = 'Click to clear filter';
        filterNode.command = { command: 'baton.clearFilter', title: 'Clear filter' };
        nodes.push(filterNode);
      }

      if (filtered.length === 0) {
        nodes.push(
          new TreeNode(
            this.hasActiveFilter() ? 'No sessions match this filter' : 'No sessions yet',
            vscode.TreeItemCollapsibleState.None,
            'info',
          ),
        );
        return nodes;
      }

      const groups = new Map<string, CompressedSession[]>();
      const pinned: CompressedSession[] = [];
      for (const s of filtered) {
        if (s.userTags.includes('pinned')) {
          pinned.push(s);
          continue;
        }
        const key = new Date(s.startTime).toLocaleDateString();
        const arr = groups.get(key) ?? [];
        arr.push(s);
        groups.set(key, arr);
      }
      if (pinned.length) {
        const n = new TreeNode(
          `📌 Pinned (${pinned.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
          'pinned-day',
        );
        n.sessions = pinned;
        nodes.push(n);
      }
      for (const [day, items] of groups.entries()) {
        const n = new TreeNode(
          `${day} (${items.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
          'day',
        );
        n.sessions = items;
        nodes.push(n);
      }
      return nodes;
    }
    if ((e.context === 'day' || e.context === 'pinned-day') && e.sessions) {
      return e.sessions.map((s) => {
        const time = new Date(s.startTime).toLocaleTimeString();
        const pin = s.userTags.includes('pinned') ? '📌 ' : '';
        const n = new TreeNode(
          `${pin}[${s.observationType}] ${time} — ${s.summary.substring(0, 60)}`,
          vscode.TreeItemCollapsibleState.None,
          'session',
        );
        n.session = s;
        const branchLabel = s.branchName ? `  [${s.branchName}]` : '';
        n.tooltip = s.summary + branchLabel;
        const tagDesc = s.userTags.filter((t) => t !== 'pinned').join(', ');
        n.description = s.branchName
          ? tagDesc
            ? `${s.branchName} · ${tagDesc}`
            : s.branchName
          : tagDesc;
        n.id = s.id;
        n.command = {
          command: 'baton.openSession',
          title: 'Open',
          arguments: [s.id],
        };
        return n;
      });
    }
    return [];
  }

  /** Apply the current filter to a session list. */
  private applyFilter(sessions: CompressedSession[]): CompressedSession[] {
    const f = this.filter;
    if (!this.hasActiveFilter()) return sessions;
    const sinceTs = f.sinceDays ? Date.now() - f.sinceDays * 86_400_000 : 0;
    const text = f.text?.toLowerCase();
    const repoId = f.scope === 'repo' ? getRepoScopeSync().id : undefined;
    return sessions.filter((s) => {
      if (f.type && s.observationType !== f.type) return false;
      if (f.tag && !s.userTags.includes(f.tag)) return false;
      if (sinceTs && s.endTime < sinceTs) return false;
      if (repoId && s.repoScope && s.repoScope !== repoId) return false;
      if (text) {
        const hay = [
          s.summary,
          s.observationType,
          ...s.keyFiles,
          ...s.keyTopics,
          ...s.decisions,
          ...s.problemsSolved,
          ...s.userTags,
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
  }

  dispose(): void {
    this.storeListener.dispose();
    this.onDidChangeEmitter.dispose();
  }
}

export class TreeNode extends vscode.TreeItem {
  sessions?: CompressedSession[];
  session?: CompressedSession;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly context: 'day' | 'pinned-day' | 'session' | 'info' | 'header' | 'filter',
  ) {
    super(label, collapsibleState);
    this.contextValue = context;
    if (context === 'day') this.iconPath = new vscode.ThemeIcon('calendar');
    if (context === 'pinned-day') this.iconPath = new vscode.ThemeIcon('pinned');
    if (context === 'session') this.iconPath = new vscode.ThemeIcon('note');
    if (context === 'info') this.iconPath = new vscode.ThemeIcon('info');
    if (context === 'filter') this.iconPath = new vscode.ThemeIcon('filter-filled');
    if (context === 'header') this.iconPath = new vscode.ThemeIcon('graph');
  }
}

/** Human-readable filter summary for the header chip. */
export function describeFilter(f: TreeFilter): string {
  const parts: string[] = [];
  if (f.text) parts.push(`"${f.text}"`);
  if (f.type) parts.push(`type=${f.type}`);
  if (f.tag) parts.push(`tag=${f.tag}`);
  if (f.sinceDays) parts.push(`since=${f.sinceDays}d`);
  if (f.scope && f.scope !== 'workspace') parts.push(`scope=${f.scope}`);
  return parts.join(' · ') || '(none)';
}
