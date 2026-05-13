import * as vscode from 'vscode';

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
}

export interface ContextDatabase {
  version: number;
  sessions: CompressedSession[];
  lastUpdated: number;
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
  // Lazy require to keep this file importable in non-node contexts (e.g. tests)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('crypto') as typeof import('crypto');
  return createHash('sha256').update(material).digest('hex');
}

export interface PluginConfig {
  enabled: boolean;
  compressionIntervalMinutes: number;
  maxStoredSessions: number;
  retentionDays: number;
  captureFileEdits: boolean;
  captureTerminalCommands: boolean;
  captureDiagnostics: boolean;
  captureGitOps: boolean;
  contextRetrievalCount: number;
  redactSecrets: boolean;
  honorPrivateTags: boolean;
  excludeGlobs: string[];
  autoInjectStartupContext: boolean;
}

export function getConfig(): PluginConfig {
  const cfg = vscode.workspace.getConfiguration('ghcpMem');
  return {
    enabled: cfg.get('enabled', true),
    compressionIntervalMinutes: cfg.get('compressionIntervalMinutes', 15),
    maxStoredSessions: cfg.get('maxStoredSessions', 50),
    retentionDays: cfg.get('retentionDays', 90),
    captureFileEdits: cfg.get('captureFileEdits', true),
    captureTerminalCommands: cfg.get('captureTerminalCommands', true),
    captureDiagnostics: cfg.get('captureDiagnostics', true),
    captureGitOps: cfg.get('captureGitOps', true),
    contextRetrievalCount: cfg.get('contextRetrievalCount', 5),
    redactSecrets: cfg.get('redactSecrets', true),
    honorPrivateTags: cfg.get('honorPrivateTags', true),
    excludeGlobs: cfg.get('excludeGlobs', []),
    autoInjectStartupContext: cfg.get('autoInjectStartupContext', true),
  };
}

/** Minimal glob matcher for excludeGlobs. */
export function isPathExcluded(relPath: string, globs: string[]): boolean {
  if (!globs?.length) return false;
  return globs.some(g => getCachedGlobRegex(g).test(relPath));
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
