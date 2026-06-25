import * as vscode from 'vscode';
import { createHash } from 'crypto';

export interface SessionEvent {
  timestamp: number;
  type: EventType;
  data: EventData;
}

export type EventType =
  | 'file_edit'
  | 'file_open'
  | 'file_close'
  | 'file_create'
  | 'file_delete'
  | 'file_rename'
  | 'terminal_command'
  | 'diagnostic_change'
  | 'git_operation'
  | 'debug_session'
  | 'task_run';

export interface FileEditData {
  filePath: string;
  languageId: string;
  changeCount: number;
  linesAdded: number;
  linesRemoved: number;
  snippet: string;
  /**
   * Content hash of the file's text *after* the edit batch was applied.
   * Used by the validator's SHA-grounding pass to tell whether the file
   * still contains the version we summarised, or whether it has drifted
   * (or been deleted) since capture. Optional for backward compat with
   * sessions captured before the grounding layer landed.
   */
  contentHash?: string;
  /**
   * Stable LSP-anchored symbol identifier for the dominant edited range,
   * in the form `"<workspaceRelativePath>#<symbolName>"` (e.g.
   * `"src/auth.ts#hashPassword"`). Captured via the
   * `vscode.executeDocumentSymbolProvider` command at flush time.
   *
   * Lets evidence survive line-number drift — the validator can re-resolve
   * the symbol in the current file even after refactors that move it
   * up or down the file. Optional: legacy sessions and non-symbol-aware
   * languages (plain text, etc.) lack this field.
   */
  symbolId?: string;
}

export interface FileLifecycleData {
  filePath: string;
  languageId?: string;
  oldPath?: string;
}

export interface TerminalData {
  command: string;
  exitCode?: number;
}

export interface DiagnosticData {
  filePath: string;
  errorCount: number;
  warningCount: number;
  topMessages: string[];
}

export interface GitOperationData {
  operation: string;
  detail: string;
}

export interface DebugSessionData {
  name: string;
  type: string;
  action: 'start' | 'stop';
}

export interface TaskRunData {
  name: string;
  source: string;
  exitCode?: number;
}

export type EventData =
  | FileEditData
  | FileLifecycleData
  | TerminalData
  | DiagnosticData
  | GitOperationData
  | DebugSessionData
  | TaskRunData;

/**
 * Observation types — auto-classified by the LM compressor.
 * Inspired by claude-mem's typed observations but derived, not manually tagged.
 */
export type ObservationType =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'chore'
  | 'research'
  | 'config'
  | 'security'
  | 'deployment'
  | 'infra'
  | 'unknown';

/**
 * A single piece of grounded evidence linking a compressed claim back to the
 * raw observations that produced it. Required for every decision/problem the
 * compressor emits — claims without evidence are dropped at write time.
 *
 * Evidence is intentionally narrow: it carries just enough information for
 * the validator to re-verify the claim against the current workspace, and
 * for the UI to render a clickable provenance link. We do NOT store the raw
 * snippet here — that would defeat redaction and bloat the store. Instead
 * we store the file path, an optional content hash (so we can detect drift),
 * the optional line range that was touched, and the originating event index.
 */
export interface Evidence {
  kind:
    | 'file_edit'
    | 'file_create'
    | 'file_delete'
    | 'file_rename'
    | 'diagnostic'
    | 'terminal'
    | 'git'
    | 'task'
    | 'debug';
  /** Workspace-relative file path the evidence refers to, when applicable. */
  filePath?: string;
  /**
   * Content hash of `filePath` at capture time. Set when the originating event
   * was a `file_edit` (or `file_create`) that carried a snapshot hash. Lets the
   * validator distinguish `verified` (hash still matches), `drifted` (file
   * exists but hash changed) and `missing` (file is gone).
   */
  fileHash?: string;
  /**
   * Stable LSP symbol identifier — `<filePath>#<symbolName>` — captured at
   * compression time from the dominant `file_edit` event's symbolId. Survives
   * line-number drift across refactors so the validator can keep a symbol
   * pin verified even when its enclosing file has been reformatted.
   */
  symbolId?: string;
  /** Index into the original event log this evidence was derived from. */
  eventIndex?: number;
  /** Capture timestamp (ms epoch) of the originating event. */
  capturedAt?: number;
}

/** Which path produced a CompressedSession — used by the trust scorer. */
export type CompressorMode = 'lm' | 'fallback';

/** Snapshot of the user's current Azure control-plane context at capture time. */
export interface AzureContextMeta {
  subscriptionId?: string;
  subscriptionName?: string;
  tenantId?: string;
  resourceGroup?: string;
  defaultLocation?: string;
  resourceIds?: string[];
  subsystems?: string[];
  capturedAt?: string;
  notes?: string;
}

export interface CompressedSession {
  id: string;
  workspaceId: string;
  workspaceName: string;
  startTime: number;
  endTime: number;
  summary: string;
  observationType: ObservationType;
  keyFiles: string[];
  keyTopics: string[];
  decisions: string[];
  problemsSolved: string[];
  rawEventCount: number;
  userTags: string[];
  redactionCount: number;
  /** SHA-256 of semantic content (summary + keyFiles + decisions + topics) — used for dedup. */
  contentHash?: string;
  /** Optional embedding vector (if the vscode.lm embeddings API is available at capture time). */
  embedding?: number[];
  /** Optional Azure context snapshot — set when the session touched Azure-related files/commands. */
  azureContext?: AzureContextMeta;
  /**
   * Stable repo-scope identifier (see {@link './repoScope'.getRepoScope}).
   * When present, retrieval can be partitioned per-repo — mirrors GitHub
   * agentic memory's repository-scoped guarantee, but resolved locally.
   */
  repoScope?: string;
  /** Human-readable label for the repo scope (e.g. "github.com/foo/bar"). */
  repoScopeLabel?: string;
  /** Git branch name at time of session capture (e.g. "feat/auth", "main"). */
  branchName?: string;
  /**
   * Parallel array to `decisions` — `decisionEvidence[i]` is the evidence list
   * for `decisions[i]`. Length always matches `decisions.length` when set.
   * Sessions captured before the grounding layer landed will not have this.
   */
  decisionEvidence?: Evidence[][];
  /**
   * Parallel array to `problemsSolved` — `problemEvidence[i]` is the evidence
   * for `problemsSolved[i]`. Same shape and backward-compat semantics as
   * `decisionEvidence`.
   */
  problemEvidence?: Evidence[][];
  /**
   * Map of workspace-relative file path → content hash captured at compression
   * time. The validator compares each entry against the current file content
   * to classify the session as `verified` / `drifted` / `broken`.
   */
  keyFileHashes?: Record<string, string>;
  /**
   * `true` iff the compressor's event log exceeded its budget and had to drop
   * events. Subtracts from the per-session confidence score. The reservoir
   * sampler tries hard to avoid this for high-signal event types but may still
   * drop low-signal noise on very long sessions.
   */
  eventLogTruncated?: boolean;
  /**
   * Which compression path produced this session. `'fallback'` is the
   * heuristic path used when the LM was unavailable or its JSON failed to
   * parse — such sessions get a lower base confidence.
   */
  compressorMode?: CompressorMode;
  /**
   * Trust score in [0, 1] derived from evidence breadth, redaction noise,
   * compressor mode and truncation. Renderers should display this with a
   * confidence badge so callers can discount low-confidence memories.
   * Undefined on legacy sessions — treat as ~0.5 (neutral) for ranking.
   */
  confidence?: number;
  /**
   * ID of an older session that this one supersedes. Set by the
   * `/supersede` command or the `setSupersedes` ContextStore mutator.
   * The store keeps both rows so the audit trail survives; retrieval
   * down-ranks superseded rows so they don't drown the current decision.
   */
  supersedes?: string;
  /**
   * Set on the OLDER session when a newer one supersedes it. Mirrors
   * `supersedes` so retrieval can detect supersession from either side.
   */
  supersededBy?: string;
  /**
   * `true` when the developer explicitly retracted this session via the
   * `/retract` command. Retracted sessions are excluded from retrieval,
   * injection, and exports — but kept on disk for audit and undo.
   */
  retracted?: boolean;
  /** Optional reason captured at retraction time (free-form, redacted). */
  retractedReason?: string;
  /**
   * ID of the original session this row corrects. Set by `/correct`,
   * which creates a new session with the corrected text and links it
   * back to its parent. Retrieval still surfaces the original (with a
   * "see correction X" hint) so historical context is preserved.
   */
  correctionOf?: string;
  /**
   * Local reinforcement-learning counters. Every successful retrieval bumps
   * `retrieved`; explicit `/accept` and `/reject` chat commands let the
   * developer mark a memory as actually useful (or not). The search ranker
   * uses `log(1+retrieved)` as a reinforcement signal and applies a small
   * penalty when `rejected` dominates `accepted`.
   *
   * All counters are local — no telemetry leaves the machine.
   */
  usage?: {
    retrieved: number;
    lastRetrievedAt: number;
    accepted: number;
    rejected: number;
    lastInteractionAt?: number;
  };
  /** Heuristic ingestion quality score in [0,1] (see ./quality). */
  qualityScore?: number;
  /**
   * Marked when scoreSessionQuality fell below `ghcpMem.qualityFloor`.
   * Kept on disk for audit but excluded from startup injection.
   */
  lowQuality?: boolean;
}

export interface ContextDatabase {
  version: number;
  sessions: CompressedSession[];
  lastUpdated: number;
  /** Optional free-form observations seeded from CI/CD pipelines. */
  observations?: Array<{
    id: string;
    text: string;
    seedLabel: string;
    capturedAt: string;
    redactionCount: number;
  }>;
  /**
   * Consolidated semantic + procedural memory derived from the episodic
   * sessions (see {@link './lessons'}). Maintained by the janitor and the
   * hot-path "remember this" write path; surfaced in startup injection so the
   * agent sees durable project knowledge, not just raw session logs.
   */
  lessons?: import('./lessons').Lesson[];
}

/**
 * Compute a stable content hash from a session's semantic payload.
 * Exported so tests and the compressor can both use it.
 */
export function computeContentHash(input: {
  summary: string;
  keyFiles: string[];
  keyTopics: string[];
  decisions: string[];
  problemsSolved: string[];
}): string {
  const material = JSON.stringify({
    s: input.summary.trim(),
    f: [...input.keyFiles].sort(),
    t: [...input.keyTopics].sort(),
    d: [...input.decisions].sort(),
    p: [...input.problemsSolved].sort(),
  });
  return createHash('sha256').update(material).digest('hex');
}

/** Retrieval / storage scope — mirrors GitHub agentic memory's repo-scoping. */
export type MemoryScope = 'user' | 'workspace' | 'repo';

export interface PluginConfig {
  enabled: boolean;
  compressionIntervalMinutes: number;
  maxStoredSessions: number;
  /** Soft cap on the on-disk size of ~/.ghcp-mem/sessions.json (MB). */
  maxStoreSizeMB: number;
  retentionDays: number;
  captureFileEdits: boolean;
  captureTerminalCommands: boolean;
  captureDiagnostics: boolean;
  captureGitOps: boolean;
  contextRetrievalCount: number;
  redactSecrets: boolean;
  honorPrivateTags: boolean;
  detectHighEntropySecrets: boolean;
  localEmbeddings: boolean;
  excludeGlobs: string[];
  autoInjectStartupContext: boolean;
  startupContextSessionCount: number;
  /** Inject team-shared project rules from .github/memory/rules.md into every session. */
  projectRules: boolean;
  /** Retrieval scope. 'user' = cross-workspace, 'workspace' = current folder, 'repo' = current git repo. */
  scope: MemoryScope;
  /**
   * User-tag allow-list whose sessions are always included in startup
   * context and retrieval, regardless of scope. The escape hatch for
   * cross-repo org-level knowledge (coding standards, naming, WAF, etc.).
   */
  globalTags: string[];
  /** Sessions scoring below this on the heuristic quality gate are flagged lowQuality and excluded from injection. */
  qualityFloor: number;
  /** Filter out sessions whose key files no longer exist in the current workspace. */
  validateAgainstCodebase: boolean;
  /** Sessions with freshness below this value are dropped from retrieval (0–1). */
  freshnessFloor: number;
  /** GitHub agentic-memory-compatible mode: force retentionDays=28 + repo scope. */
  githubCompatibleMode: boolean;
  /** Lock down capture and export to a redacted-only, read-mostly enterprise posture. */
  enterpriseMode: boolean;
  /** Persist raw code snippets in captured edits. Disabled in enterprise mode. */
  captureCodeSnippets: boolean;
  /** Allow the extension-side MCP tools that mutate or export memory. */
  allowMcpWriteAccess: boolean;
  /** Allow team export and pack export flows. */
  allowTeamExport: boolean;
  /** Require an explicit preview before a compressed session is persisted. */
  previewBeforePersist: boolean;
  /** Remote policy URL whose JSON redaction rules are appended after built-ins. */
  policySource?: string;
  /**
   * How many seconds of editor inactivity must pass before an idle-triggered
   * compression fires. Set to 0 to rely only on the interval timer.
   */
  idleTimeoutSeconds: number;
  /** User-defined regex redaction rules applied after the built-in 26-rule set. */
  customRedactionRules: CustomRedactionRule[];
  /**
   * Phase 5 NER-lite: plain-string organisation/project/codename entities to
   * scrub from captured text. Each entry is treated as a literal,
   * case-insensitive, word-boundary-anchored regex. Use for terms that
   * don't match any built-in pattern (e.g. internal product names,
   * customer codenames, deal IDs).
   */
  customSensitiveEntities: string[];
}

/** A user-defined redaction rule injected via `ghcpMem.customRedactionRules`. */
export interface CustomRedactionRule {
  /** Human-readable label shown in audit output. */
  name: string;
  /** JavaScript regex source string (no delimiters, e.g. "MY_SECRET_[A-Z0-9]{20}"). */
  pattern: string;
  /** Replacement string. Defaults to "[REDACTED:custom]". */
  replacement?: string;
  /** Regex flags. Defaults to "g". */
  flags?: string;
}

/** Clamp a number to a closed interval; NaN/non-finite falls back to `fallback`. */
function clampNum(raw: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function getConfig(): PluginConfig {
  const cfg = vscode.workspace.getConfiguration('ghcpMem');
  const githubCompatibleMode = cfg.get('githubCompatibleMode', false);
  // Default 'repo' so memories don't leak across projects when opening a new
  // workspace. Users who genuinely want cross-repo retrieval can opt back to
  // 'user' or 'workspace'.
  const scope = cfg.get<MemoryScope>('scope', 'repo');
  return {
    enabled: cfg.get('enabled', true),
    compressionIntervalMinutes: cfg.get('compressionIntervalMinutes', 15),
    maxStoredSessions: cfg.get('maxStoredSessions', 50),
    maxStoreSizeMB: cfg.get('maxStoreSizeMB', 25),
    // GitHub-compatible mode pins retention to 28 days like Copilot agentic memory.
    retentionDays: githubCompatibleMode ? 28 : cfg.get('retentionDays', 90),
    captureFileEdits: cfg.get('captureFileEdits', true),
    captureTerminalCommands:
      cfg.get('captureTerminalCommands', true) && !cfg.get('enterpriseMode', false),
    captureDiagnostics: cfg.get('captureDiagnostics', true),
    captureGitOps: cfg.get('captureGitOps', true),
    contextRetrievalCount: cfg.get('contextRetrievalCount', 5),
    redactSecrets: cfg.get('redactSecrets', true),
    honorPrivateTags: cfg.get('honorPrivateTags', true),
    detectHighEntropySecrets: cfg.get('detectHighEntropySecrets', true),
    localEmbeddings: cfg.get('localEmbeddings', true),
    excludeGlobs: cfg.get('excludeGlobs', []),
    autoInjectStartupContext: cfg.get('autoInjectStartupContext', true),
    startupContextSessionCount: clampNum(cfg.get('startupContextSessionCount', 5), 1, 20, 5),
    projectRules: cfg.get('projectRules', true),
    scope: githubCompatibleMode ? 'repo' : scope,
    globalTags: normalizeGlobalTags(cfg.get<string[]>('globalTags', ['global'])),
    qualityFloor: clampNum(cfg.get('qualityFloor', 0.3), 0, 1, 0.3),
    validateAgainstCodebase: cfg.get('validateAgainstCodebase', true),
    // Clamp to [0, 1] regardless of what the user types in settings.json.
    // package.json declares min/max for the UI, but raw JSON edits can bypass that.
    freshnessFloor: clampNum(cfg.get('freshnessFloor', 0.25), 0, 1, 0.25),
    githubCompatibleMode,
    enterpriseMode: cfg.get('enterpriseMode', false),
    captureCodeSnippets: cfg.get('captureCodeSnippets', true) && !cfg.get('enterpriseMode', false),
    // Default `false` (v1.6.1+): MCP is read-only out of the box. Write tools
    // (memory-store/delete/correct/retract/supersede) require opt-in. This is
    // the enterprise-safe posture; flipping to `true` is a deliberate choice.
    allowMcpWriteAccess: cfg.get('allowMcpWriteAccess', false) && !cfg.get('enterpriseMode', false),
    allowTeamExport: cfg.get('allowTeamExport', true) && !cfg.get('enterpriseMode', false),
    previewBeforePersist:
      cfg.get('previewBeforePersist', false) || cfg.get('enterpriseMode', false),
    policySource: normalizeOptionalString(cfg.get<string | undefined>('policySource', undefined)),
    idleTimeoutSeconds: clampNum(cfg.get('idleTimeoutSeconds', 30), 0, 300, 30),
    customRedactionRules: cfg.get<CustomRedactionRule[]>('customRedactionRules', []),
    customSensitiveEntities: cfg.get<string[]>('customSensitiveEntities', []),
  };
}

function normalizeOptionalString(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeGlobalTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['global'];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Minimal glob matcher for excludeGlobs. */
export function isPathExcluded(relPath: string, globs: string[]): boolean {
  if (!globs?.length) return false;
  return globs.some((g) => getCachedGlobRegex(g).test(relPath));
}

// Memoize compiled glob patterns. Called on every captured file event so the
// regex compile cost compounds quickly with default excludeGlobs (5+ patterns).
const GLOB_CACHE = new Map<string, RegExp>();
const GLOB_CACHE_LIMIT = 256;
function getCachedGlobRegex(g: string): RegExp {
  let re = GLOB_CACHE.get(g);
  if (re) return re;
  re = globToRegex(g);
  if (GLOB_CACHE.size >= GLOB_CACHE_LIMIT) GLOB_CACHE.clear();
  GLOB_CACHE.set(g, re);
  return re;
}

export function globToRegex(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}
