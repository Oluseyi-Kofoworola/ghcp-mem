import * as vscode from 'vscode';
import { ContextStore } from './contextStore';
import { CompressedSession } from './types';

/**
 * Tree view in the sidebar showing stored sessions grouped by date.
 * This is something claude-mem only provides via an external port-37777 web
 * viewer — here it's native VS Code with no server.
 */
export class SessionsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;
  private storeListener: vscode.Disposable;

  constructor(private readonly store: ContextStore) {
    this.storeListener = store.onChange(() => this.refresh());
  }

  refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  getTreeItem(e: TreeNode): vscode.TreeItem {
    return e;
  }

  getChildren(e?: TreeNode): TreeNode[] {
    if (!e) {
      // Root: group by day
      const sessions = [...this.store.getWorkspaceSessions()].sort((a, b) => b.startTime - a.startTime);
      if (sessions.length === 0) {
        return [new TreeNode('No sessions yet', vscode.TreeItemCollapsibleState.None, 'info')];
      }
      const stats = this.store.getStats();
      const header = new TreeNode(
        `📊 ${stats.workspaceSessions} here · ${stats.totalSessions} total · ${stats.totalRedactions} redactions`,
        vscode.TreeItemCollapsibleState.None,
        'header'
      );
      header.tooltip = 'GHCP-MEM statistics for this workspace';
      const groups = new Map<string, CompressedSession[]>();
      for (const s of sessions) {
        const key = new Date(s.startTime).toLocaleDateString();
        const arr = groups.get(key) ?? [];
        arr.push(s);
        groups.set(key, arr);
      }
      const dayNodes = Array.from(groups.entries()).map(([day, items]) => {
        const n = new TreeNode(`${day} (${items.length})`, vscode.TreeItemCollapsibleState.Expanded, 'day');
        n.sessions = items;
        return n;
      });
      return [header, ...dayNodes];
    }
    if (e.context === 'day' && e.sessions) {
      return e.sessions.map(s => {
        const time = new Date(s.startTime).toLocaleTimeString();
        const n = new TreeNode(`[${s.observationType}] ${time} — ${s.summary.substring(0, 60)}`, vscode.TreeItemCollapsibleState.None, 'session');
        n.session = s;
        n.tooltip = s.summary;
        n.description = s.userTags.join(', ');
        n.id = s.id;
        n.command = {
          command: 'ghcpMem.openSession',
          title: 'Open',
          arguments: [s.id],
        };
        return n;
      });
    }
    return [];
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
    public readonly context: 'day' | 'session' | 'info' | 'header'
  ) {
    super(label, collapsibleState);
    this.contextValue = context;
    if (context === 'day') this.iconPath = new vscode.ThemeIcon('calendar');
    if (context === 'session') this.iconPath = new vscode.ThemeIcon('note');
    if (context === 'info') this.iconPath = new vscode.ThemeIcon('info');
  }
}
