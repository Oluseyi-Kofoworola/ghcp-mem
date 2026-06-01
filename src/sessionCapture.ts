import * as vscode from 'vscode';
import { createHash } from 'crypto';
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
import { redact } from './redactor';
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
  private eventSizes: number[] = [];
  private volatileBytes = 0;
  private disposables: vscode.Disposable[] = [];
  private sessionStartTime: number;
  private editBatch = new Map<
    string,
    {
      added: number;
      removed: number;
      count: number;
      lastSnippet: string;
      lang: string;
      contentHash?: string;
      /** Last edit's range — used to resolve a stable LSP symbol at flush time. */
      lastRange?: vscode.Range;
      uri?: vscode.Uri;
    }
  >();
  private editFlushTimer: NodeJS.Timeout | undefined;
  private totalRedactions = 0;
  private azureSubsystems = new Set<AzureSubsystem>();
  private azureTags = new Set<string>();
  private semanticSignatures = new Map<string, string>();
  /**
   * Timestamp after which file_open events are allowed. Set to 3 s in the
   * future at start() to suppress the flood of re-open events that VS Code
   * fires when it restores all previously open editors on startup — those
   * events add noise to the session log without representing real user intent.
   */
  private fileOpenAllowedAt = 0;

  constructor() {
    this.sessionStartTime = Date.now();
  }

  start(): void {
    // Suppress file_open noise from VS Code restoring previously open editors.
    this.fileOpenAllowedAt = Date.now() + 3000;
    const config = getConfig();
    if (config.captureFileEdits) this.registerEditCapture();
    this.registerFileLifecycleCapture();
    if (config.captureDiagnostics) this.registerDiagnosticsCapture();
    if (config.captureGitOps) this.registerGitCapture();
    if (config.captureTerminalCommands && !config.enterpriseMode) this.registerTerminalCapture();
    this.registerDebugCapture();
    this.registerTaskCapture();
  }

  drain(): {
    events: SessionEvent[];
    redactionCount: number;
    azureSubsystems: AzureSubsystem[];
    azureTags: string[];
  } {
    this.flushEditBatch();
    const drained = [...this.events];
    const redactionCount = this.totalRedactions;
    const azureSubsystems = [...this.azureSubsystems];
    const azureTags = [...this.azureTags];
    this.events = [];
    this.eventSizes = [];
    this.volatileBytes = 0;
    this.totalRedactions = 0;
    this.azureSubsystems.clear();
    this.azureTags.clear();
    return { events: drained, redactionCount, azureSubsystems, azureTags };
  }

  clearPending(): void {
    this.events = [];
    this.eventSizes = [];
    this.volatileBytes = 0;
    this.totalRedactions = 0;
    this.editBatch.clear();
    this.semanticSignatures.clear();
    this.azureSubsystems.clear();
    this.azureTags.clear();
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

        const nextSignature = semanticTextSignature(e.document.getText());
        const prevSignature = this.semanticSignatures.get(filePath);
        this.semanticSignatures.set(filePath, nextSignature);
        if (prevSignature === nextSignature) return;

        const az = classifyFile(filePath);
        if (az.isAzure) {
          az.subsystems.forEach((s) => this.azureSubsystems.add(s));
          az.tags.forEach((t) => this.azureTags.add(t));
        }

        const existing = this.editBatch.get(filePath) ?? {
          added: 0,
          removed: 0,
          count: 0,
          lastSnippet: '',
          lang: e.document.languageId,
          contentHash: undefined as string | undefined,
          lastRange: undefined as vscode.Range | undefined,
          uri: undefined as vscode.Uri | undefined,
        };

        for (const change of e.contentChanges) {
          const addedLines = change.text.split('\n').length - 1;
          const removedLines = change.range.end.line - change.range.start.line;
          existing.added += addedLines;
          existing.removed += removedLines;
          existing.count++;
          existing.lastRange = change.range;
          existing.uri = e.document.uri;

          if (change.text.length > 0 && change.text.length < 500) {
            // Redact before storing
            const result = redact(change.text.substring(0, 200), {
              redactSecrets: config.redactSecrets,
              honorPrivateTags: config.honorPrivateTags,
            });
            this.totalRedactions += result.redactionCount;
            existing.lastSnippet = config.captureCodeSnippets
              ? result.text
              : '[REDACTED:snippet-disabled]';
          }
        }

        // Stamp the post-edit content hash so the grounding validator can
        // detect drift later. We reuse the semantic signature we already
        // computed for change-skipping above — no extra hash call.
        existing.contentHash = nextSignature;

        this.editBatch.set(filePath, existing);

        if (this.editFlushTimer) clearTimeout(this.editFlushTimer);
        this.editFlushTimer = setTimeout(() => this.flushEditBatch(), 5000);
      }),
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
        contentHash: batch.contentHash,
      };
      this.pushEvent('file_edit', data);

      // Best-effort LSP symbol resolution. Runs async after the event has
      // been pushed; if it succeeds before drain(), the symbolId is set on
      // the (still-buffered) event. If drain happens first, symbolId stays
      // undefined and the validator/compressor degrade gracefully.
      if (batch.uri && batch.lastRange) {
        void this.resolveAndAttachSymbol(data, batch.uri, batch.lastRange);
      }
    }
    this.editBatch.clear();
  }

  /**
   * Resolve the dominant symbol at the given range using VS Code's built-in
   * document symbol provider. Updates `data.symbolId` in place on success.
   *
   * Deliberately non-blocking — VS Code's DocumentSymbolProvider can take
   * 50–500 ms to warm up for large files and we never want to delay event
   * persistence behind it. Failures are swallowed: a missing symbolId is
   * always preferable to a stalled flush.
   */
  private async resolveAndAttachSymbol(
    data: FileEditData,
    uri: vscode.Uri,
    range: vscode.Range,
  ): Promise<void> {
    try {
      const symbols = await vscode.commands.executeCommand<
        Array<vscode.DocumentSymbol | vscode.SymbolInformation>
      >('vscode.executeDocumentSymbolProvider', uri);
      if (!symbols || symbols.length === 0) return;
      const found = findEnclosingSymbol(symbols, range);
      if (found) data.symbolId = `${data.filePath}#${found}`;
    } catch {
      // LSP unavailable, language without symbol provider, doc closed —
      // any of these are fine, the field just stays undefined.
    }
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
        // Ignore the startup re-open flood (VS Code restores all prior editors).
        if (Date.now() < this.fileOpenAllowedAt) return;
        this.semanticSignatures.set(
          vscode.workspace.asRelativePath(doc.uri),
          semanticTextSignature(doc.getText()),
        );
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
          this.semanticSignatures.delete(vscode.workspace.asRelativePath(file));
          this.pushEvent('file_delete', {
            filePath: vscode.workspace.asRelativePath(file),
          } as FileLifecycleData);
        }
      }),

      vscode.workspace.onDidRenameFiles((e) => {
        for (const file of e.files) {
          if (shouldSkip(file.newUri) && shouldSkip(file.oldUri)) continue;
          const oldPath = vscode.workspace.asRelativePath(file.oldUri);
          const newPath = vscode.workspace.asRelativePath(file.newUri);
          const sig = this.semanticSignatures.get(oldPath);
          if (sig) {
            this.semanticSignatures.set(newPath, sig);
            this.semanticSignatures.delete(oldPath);
          }
          this.pushEvent('file_rename', {
            filePath: newPath,
            oldPath,
          } as FileLifecycleData);
        }
      }),
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
          const errorCount = diags.filter(
            (d) => d.severity === vscode.DiagnosticSeverity.Error,
          ).length;
          const warningCount = diags.filter(
            (d) => d.severity === vscode.DiagnosticSeverity.Warning,
          ).length;
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
            .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
            .slice(0, 3)
            .map((d) => {
              const msg = `[${d.severity === 0 ? 'E' : 'W'}] ${d.message.substring(0, 120)}`;
              return redact(msg, { redactSecrets: config.redactSecrets, honorPrivateTags: false })
                .text;
            });

          this.pushEvent('diagnostic_change', {
            filePath,
            errorCount,
            warningCount,
            topMessages,
          } as DiagnosticData);
        }
      }),
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
            }),
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
        this.pushEvent('debug_session', {
          name: s.name,
          type: s.type,
          action: 'start',
        } as DebugSessionData);
      }),
      vscode.debug.onDidTerminateDebugSession((s) => {
        this.pushEvent('debug_session', {
          name: s.name,
          type: s.type,
          action: 'stop',
        } as DebugSessionData);
      }),
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
      }),
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
      onDidStartTerminalShellExecution?: (
        cb: (e: { execution: { commandLine?: { value?: string } | string } }) => void,
      ) => vscode.Disposable;
    };
    if (typeof w.onDidStartTerminalShellExecution !== 'function') return;

    try {
      this.disposables.push(
        w.onDidStartTerminalShellExecution((e) => {
          const raw =
            typeof e.execution.commandLine === 'string'
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
            az.subsystems.forEach((s) => this.azureSubsystems.add(s));
            az.tags.forEach((t) => this.azureTags.add(t));
          }

          this.pushEvent('terminal_command', {
            command: config.enterpriseMode ? '[REDACTED:enterprise-terminal]' : redacted.text,
          } as TerminalData);
        }),
      );
    } catch {
      // API not yet finalized in this build — ignore.
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  /** Cap event buffer at MAX_EVENTS and MAX_VOLATILE_BYTES, discarding oldest entries. */
  private static readonly MAX_EVENTS = 5000;
  private static readonly MAX_VOLATILE_BYTES = 5 * 1024 * 1024;

  private static eventSize(e: SessionEvent): number {
    return Buffer.byteLength(JSON.stringify(e), 'utf8');
  }

  private trimEvents(): void {
    let removeCount = 0;
    let bytes = this.volatileBytes;
    while (
      (this.events.length - removeCount > SessionCapture.MAX_EVENTS ||
        bytes > SessionCapture.MAX_VOLATILE_BYTES) &&
      removeCount < this.eventSizes.length
    ) {
      bytes -= this.eventSizes[removeCount];
      removeCount++;
    }
    if (removeCount > 0) {
      this.events.splice(0, removeCount);
      this.eventSizes.splice(0, removeCount);
      this.volatileBytes = bytes;
    }
  }

  private pushEvent(type: SessionEvent['type'], data: SessionEvent['data']): void {
    const e = { timestamp: Date.now(), type, data };
    this.events.push(e);
    this.eventSizes.push(SessionCapture.eventSize(e));
    this.volatileBytes += this.eventSizes[this.eventSizes.length - 1];
    this.trimEvents();
  }

  /**
   * Push a previously-captured event back into the buffer — used by the
   * shutdown-recovery flow in extension.ts so events left behind by an
   * unclean reload aren't lost. Same overflow trimming as pushEvent().
   */
  pushExistingEvent(e: SessionEvent): void {
    this.events.push(e);
    this.eventSizes.push(SessionCapture.eventSize(e));
    this.volatileBytes += this.eventSizes[this.eventSizes.length - 1];
    this.trimEvents();
  }

  dispose(): void {
    this.flushEditBatch();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

export function semanticTextSignature(text: string): string {
  const normalized = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Walk a DocumentSymbol tree (or flat SymbolInformation array) and return
 * the name of the deepest symbol whose range contains `target`. Used by
 * sessionCapture to anchor an edit to its enclosing class/function so the
 * Evidence layer can survive line-number drift.
 *
 * Returns `undefined` when the range falls outside every symbol — typically
 * top-of-file edits (imports, comments) which have no enclosing scope.
 */
export function findEnclosingSymbol(
  symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
  target: vscode.Range,
): string | undefined {
  let best: { name: string; depth: number } | undefined;
  const visit = (s: vscode.DocumentSymbol | vscode.SymbolInformation, depth: number) => {
    const range =
      (s as vscode.DocumentSymbol).range ?? (s as vscode.SymbolInformation).location?.range;
    if (!range) return;
    // Cheap containment check: target.start.line within [range.start.line, range.end.line].
    if (target.start.line < range.start.line || target.start.line > range.end.line) return;
    if (!best || depth > best.depth) best = { name: s.name, depth };
    const children = (s as vscode.DocumentSymbol).children;
    if (Array.isArray(children)) {
      for (const c of children) visit(c, depth + 1);
    }
  };
  for (const s of symbols) visit(s, 0);
  return best?.name;
}
