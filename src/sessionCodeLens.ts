import * as vscode from 'vscode';
import { ContextStore } from './contextStore';
import { CompressedSession } from './types';

/**
 * Inline session history CodeLens for every open file.
 *
 * Shows a single lens at line 0 of any file that appears in the keyFiles
 * of one or more stored sessions, e.g.:
 *
 *   🧠 3 sessions · Last: feature  2h ago  ·  show history
 *
 * Click → `ghcpMem.showFileHistory` which opens a quick-pick listing all
 * sessions that touched the file, with a preview of each summary.
 */
export class SessionCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;
  private storeListener: vscode.Disposable;

  constructor(private readonly store: ContextStore) {
    this.storeListener = store.onChange(() => this.onDidChangeEmitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const filePath = document.uri.fsPath;
    const relPath = vscode.workspace.asRelativePath(filePath);

    const hits = this.findSessionsForFile(relPath, filePath);
    if (hits.length === 0) return [];

    const latest = hits[0];
    const ago = formatAgo(latest.endTime);
    const typeLabel = latest.observationType;
    const label = `🧠 ${hits.length} session${hits.length !== 1 ? 's' : ''} · Last: ${typeLabel}  ${ago}  · show history`;

    const lens = new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
      title: label,
      command: 'ghcpMem.showFileHistory',
      arguments: [relPath, hits],
      tooltip: `GHCP-MEM: ${hits.length} coding session(s) touched this file. Click to browse.`,
    });

    return [lens];
  }

  /** Resolve is a no-op — command is fully populated in provideCodeLenses. */
  resolveCodeLens(lens: vscode.CodeLens): vscode.CodeLens {
    return lens;
  }

  /**
   * Find all sessions that contain the given file path in their keyFiles list.
   * Matches by: exact match, suffix match (relative vs absolute), or basename.
   */
  findSessionsForFile(relPath: string, absPath: string): CompressedSession[] {
    const basename = relPath.split('/').pop()?.toLowerCase() ?? '';
    const rel = relPath.toLowerCase();
    const abs = absPath.toLowerCase();

    return this.store
      .getAllSessions()
      .filter((s) =>
        s.keyFiles.some((f) => {
          const fl = f.toLowerCase();
          return (
            fl === rel ||
            fl === abs ||
            abs.endsWith('/' + fl) ||
            rel.endsWith('/' + fl) ||
            fl.split('/').pop() === basename
          );
        }),
      )
      .sort((a, b) => b.endTime - a.endTime);
  }

  dispose(): void {
    this.storeListener.dispose();
    this.onDidChangeEmitter.dispose();
  }
}

/** Human-readable relative time (e.g. "2h ago", "3d ago"). */
function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
