import * as vscode from 'vscode';
import {
  SessionEvent,
  FileEditData,
  FileLifecycleData,
  DiagnosticData,
  GitOperationData,
  DebugSessionData,
  TaskRunData,
  TerminalData,
  getConfig,
  isPathExcluded,
} from './types';
import { redact, looksSensitive } from './redactor';
import { classifyFile, classifyCommand, AzureSubsystem } from './azureDetect';

/**
 * Captures VS Code workspace events during a coding session.
 * Improvements over claude-mem:
 *   - Honors excludeGlobs (e.g. .env, secrets/**, node_modules)
 *   - Redacts secrets in captured snippets before buffering
 *   - Respects <private> tags in edited code
 *   - Classifies Azure-related activity (Bicep, AZD, az CLI, kubectl, Functions)
 */
export class SessionCapture implements vscode.Disposable {
  private events: SessionEvent[] = [];
  private disposables: vscode.Disposable[] = [];
  private sessionStartTime: number;
  private editBatch = new Map<string, { added: number; removed: number; count: number; lastSnippet: string; lang: string }>();
  private editFlushTimer: NodeJS.Timeout | undefined;
  private totalRedactions = 0;
  private azureSubsystems = new Set<AzureSubsystem>();
  private azureTags = new Set<string>();

  constructor() {
    this.sessionStartTime = Date.now();
  }

  start(): void {
    const config = getConfig();
    if (config.captureFileEdits) this.registerEditCapture();
    this.registerFileLifecycleCapture();
    if (config.captureDiagnostics) this.registerDiagnosticsCapture();
    if (config.captureGitOps) this.registerGitCapture();
    if (config.captureTerminalCommands) this.registerTerminalCapture();
    this.registerDebugCapture();
    this.registerTaskCapture();
  }

  drain(): { events: SessionEvent[]; redactionCount: number; azureSubsystems: AzureSubsystem[]; azureTags: string[] } {
    this.flushEditBatch();
    const drained = [...this.events];
    const redactionCount = this.totalRedactions;
    const azureSubsystems = [...this.azureSubsystems];
    const azureTags = [...this.azureTags];
    this.events = [];
    this.totalRedactions = 0;
    this.azureSubsystems.clear();
    this.azureTags.clear();
    return { events: drained, redactionCount, azureSubsystems, azureTags };
  }

  get eventCount(): number {
    return this.events.length + this.editBatch.size;
  }

  get startTime(): number {
    return this.sessionStartTime;
  }

  resetStartTime(): void {
    this.sessionStartTime = Date.now();
  }

  // ── File Edit Capture ──────────────────────────────────────

  private registerEditCapture(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file') return;
        if (e.contentChanges.length === 0) return;

        const config = getConfig();
        const filePath = vscode.workspace.asRelativePath(e.document.uri);

        if (isPathExcluded(filePath, config.excludeGlobs)) return;

        const az = classifyFile(filePath);
        if (az.isAzure) {
          az.subsystems.forEach(s => this.azureSubsystems.add(s));
          az.tags.forEach(t => this.azureTags.add(t));
        }

        const existing = this.editBatch.get(filePath) ?? {
          added: 0, removed: 0, count: 0, lastSnippet: '', lang: e.document.languageId,
        };

        for (const change of e.contentChanges) {
          const addedLines = change.text.split('\n').length - 1;
          const removedLines = change.range.end.line - change.range.start.line;
          existing.added += addedLines;
          existing.removed += removedLines;
          existing.count++;

          if (change.text.length > 0 && change.text.length < 500) {
            // Redact before storing
            const result = redact(change.text.substring(0, 200), {
              redactSecrets: config.redactSecrets,
              honorPrivateTags: config.honorPrivateTags,
            });
            this.totalRedactions += result.redactionCount;
            existing.lastSnippet = result.text;
          }
        }

        this.editBatch.set(filePath, existing);

        if (this.editFlushTimer) clearTimeout(this.editFlushTimer);
        this.editFlushTimer = setTimeout(() => this.flushEditBatch(), 5000);
      })
    );
  }

  private flushEditBatch(): void {
    if (this.editFlushTimer) {
      clearTimeout(this.editFlushTimer);
      this.editFlushTimer = undefined;
    }

    for (const [filePath, batch] of this.editBatch) {
      const data: FileEditData = {
        filePath,
        languageId: batch.lang,
        changeCount: batch.count,
        linesAdded: batch.added,
        linesRemoved: batch.removed,
        snippet: batch.lastSnippet,
      };
      this.pushEvent('file_edit', data);
    }
    this.editBatch.clear();
  }

  // ── File Lifecycle Capture ─────────────────────────────────

  private registerFileLifecycleCapture(): void {
    const shouldSkip = (uri: vscode.Uri) => {
      const config = getConfig();
      const rel = vscode.workspace.asRelativePath(uri);
      return isPathExcluded(rel, config.excludeGlobs);
    };

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme !== 'file' || shouldSkip(doc.uri)) return;
        this.pushEvent('file_open', {
          filePath: vscode.workspace.asRelativePath(doc.uri),
          languageId: doc.languageId,
        } as FileLifecycleData);
      }),

      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme !== 'file' || shouldSkip(doc.uri)) return;
        this.pushEvent('file_close', {
          filePath: vscode.workspace.asRelativePath(doc.uri),
        } as FileLifecycleData);
      }),

      vscode.workspace.onDidCreateFiles((e) => {
        for (const file of e.files) {
          if (shouldSkip(file)) continue;
          this.pushEvent('file_create', {
            filePath: vscode.workspace.asRelativePath(file),
          } as FileLifecycleData);
        }
      }),

      vscode.workspace.onDidDeleteFiles((e) => {
        for (const file of e.files) {
          if (shouldSkip(file)) continue;
          this.pushEvent('file_delete', {
            filePath: vscode.workspace.asRelativePath(file),
          } as FileLifecycleData);
        }
      }),

      vscode.workspace.onDidRenameFiles((e) => {
        for (const file of e.files) {
          if (shouldSkip(file.newUri) && shouldSkip(file.oldUri)) continue;
          this.pushEvent('file_rename', {
            filePath: vscode.workspace.asRelativePath(file.newUri),
            oldPath: vscode.workspace.asRelativePath(file.oldUri),
          } as FileLifecycleData);
        }
      })
    );
  }

  // ── Diagnostics Capture ────────────────────────────────────

  private registerDiagnosticsCapture(): void {
    const lastDiagState = new Map<string, number>();
    // Cap to bound memory growth across long sessions / renamed files. The
    // entries are only used to detect "changed since last fire" so dropping
    // the oldest tracker is a no-op except for re-emitting a duplicate event.
    const DIAG_STATE_CAP = 500;

    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics((e) => {
        const config = getConfig();
        for (const uri of e.uris) {
          if (uri.scheme !== 'file') continue;
          const filePath = vscode.workspace.asRelativePath(uri);
          if (isPathExcluded(filePath, config.excludeGlobs)) continue;

          const diags = vscode.languages.getDiagnostics(uri);
          const errorCount = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
          const warningCount = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
          const total = errorCount + warningCount;

          const prev = lastDiagState.get(filePath) ?? 0;
          if (total === prev) continue;
          if (total === 0) {
            lastDiagState.delete(filePath);
          } else {
            if (lastDiagState.size >= DIAG_STATE_CAP) {
              const firstKey = lastDiagState.keys().next().value;
              if (firstKey !== undefined) lastDiagState.delete(firstKey);
            }
            lastDiagState.set(filePath, total);
          }

          // Redact diagnostic messages (paths sometimes contain usernames / tokens in URLs)
          const topMessages = diags
            .filter(d => d.severity <= vscode.DiagnosticSeverity.Warning)
            .slice(0, 3)
            .map(d => {
              const msg = `[${d.severity === 0 ? 'E' : 'W'}] ${d.message.substring(0, 120)}`;
              return redact(msg, { redactSecrets: config.redactSecrets, honorPrivateTags: false }).text;
            });

          this.pushEvent('diagnostic_change', {
            filePath, errorCount, warningCount, topMessages,
          } as DiagnosticData);
        }
      })
    );
  }

  // ── Git Capture ────────────────────────────────────────────

  private registerGitCapture(): void {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) return;

    (async () => {
      try {
        const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
        const api = git.getAPI(1);
        if (!api) return;

        for (const repo of api.repositories) {
          this.disposables.push(
            repo.state.onDidChange(() => {
              const head = repo.state.HEAD;
              if (head) {
                this.pushEvent('git_operation', {
                  operation: 'state_change',
                  detail: `Branch: ${head.name ?? 'detached'}, commit: ${head.commit?.substring(0, 8) ?? 'none'}`,
                } as GitOperationData);
              }
            })
          );
        }
      } catch {
        // Git extension unavailable
      }
    })();
  }

  // ── Debug Session Capture ──────────────────────────────────

  private registerDebugCapture(): void {
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((s) => {
        this.pushEvent('debug_session', { name: s.name, type: s.type, action: 'start' } as DebugSessionData);
      }),
      vscode.debug.onDidTerminateDebugSession((s) => {
        this.pushEvent('debug_session', { name: s.name, type: s.type, action: 'stop' } as DebugSessionData);
      })
    );
  }

  // ── Task Capture ───────────────────────────────────────────

  private registerTaskCapture(): void {
    this.disposables.push(
      vscode.tasks.onDidEndTaskProcess((e) => {
        this.pushEvent('task_run', {
          name: e.execution.task.name,
          source: e.execution.task.source,
          exitCode: e.exitCode,
        } as TaskRunData);
      })
    );
  }

  // ── Terminal Command Capture ───────────────────────────────
  /**
   * Uses the shell-integration API (finalized in VS Code 1.93) to observe
   * command lines. Falls back to a silent no-op when shell integration isn't
   * active for the user's terminal.
   *
   * The full command is redacted before buffering — SAS tokens, SP secrets,
   * subscription GUIDs are stripped here too.
   */
  private registerTerminalCapture(): void {
    const w = vscode.window as unknown as {
      onDidStartTerminalShellExecution?: (cb: (e: { execution: { commandLine?: { value?: string } | string } }) => void) => vscode.Disposable;
    };
    if (typeof w.onDidStartTerminalShellExecution !== 'function') return;

    try {
      this.disposables.push(
        w.onDidStartTerminalShellExecution((e) => {
          const raw = typeof e.execution.commandLine === 'string'
            ? e.execution.commandLine
            : e.execution.commandLine?.value;
          if (!raw || typeof raw !== 'string') return;
          const trimmed = raw.trim();
          if (!trimmed) return;

          const config = getConfig();
          const redacted = redact(trimmed.substring(0, 400), {
            redactSecrets: config.redactSecrets,
            honorPrivateTags: false,
          });
          this.totalRedactions += redacted.redactionCount;

          const az = classifyCommand(trimmed);
          if (az.isAzure) {
            az.subsystems.forEach(s => this.azureSubsystems.add(s));
            az.tags.forEach(t => this.azureTags.add(t));
          }

          this.pushEvent('terminal_command', {
            command: redacted.text,
          } as TerminalData);
        })
      );
    } catch {
      // API not yet finalized in this build — ignore.
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private pushEvent(type: SessionEvent['type'], data: SessionEvent['data']): void {
    this.events.push({ timestamp: Date.now(), type, data });
    // splice(0, n) removes in-place — avoids allocating a second array copy
    // that this.events.slice(-3000) would create on every overflow.
    if (this.events.length > 5000) {
      this.events.splice(0, this.events.length - 3000);
    }
  }

  dispose(): void {
    this.flushEditBatch();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
