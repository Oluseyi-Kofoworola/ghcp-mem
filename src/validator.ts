import * as vscode from 'vscode';
import { CompressedSession } from './types';

/**
 * Lightweight codebase validation for stored memories.
 *
 * Mirrors GitHub Copilot agentic memory's "validated against the current
 * codebase before use" guarantee, but local-only — no cloud round-trip.
 *
 * The validator checks whether the `keyFiles` referenced by a session still
 * exist in the active workspace. A session with most of its files missing
 * is likely stale (renamed, deleted, or simply from a different repo) and
 * should be down-ranked or filtered.
 *
 * Cheap by design: relies on `vscode.workspace.fs.stat` so a single check
 * is O(1) per file, and we short-circuit if the session has zero `keyFiles`.
 *
 * Results are cached per-session for a short window so repeated retrievals
 * don't re-stat the same paths.
 */

export interface ValidationResult {
  sessionId: string;
  /** Fraction of keyFiles that still exist (0–1). 1 means fully fresh. */
  freshness: number;
  /** Files that no longer exist in the workspace. */
  missing: string[];
  /** Files that still exist. */
  present: string[];
  /** Sessions whose `keyFiles` is empty get freshness=1 (nothing to check). */
  emptyKeyFiles: boolean;
  /**
   * Paths that couldn't be normalised (e.g. absolute paths from a different
   * workspace root, or paths containing `..`). Not counted in freshness, but
   * exposed here so callers can detect path-resolution issues that would
   * otherwise be invisible.
   */
  skipped: number;
  checkedAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, ValidationResult>();

/** For tests: clear the validation cache. */
export function _clearValidationCache(): void {
  cache.clear();
}

/**
 * Validate a single session against the workspace filesystem.
 * Cached for TTL_MS so retrieval doesn't re-stat on every search.
 */
export async function validateSession(
  session: CompressedSession,
  workspaceRoot?: vscode.Uri,
): Promise<ValidationResult> {
  const cached = cache.get(session.id);
  if (cached && Date.now() - cached.checkedAt < TTL_MS) return cached;

  if (!session.keyFiles?.length) {
    const result: ValidationResult = {
      sessionId: session.id,
      freshness: 1,
      missing: [],
      present: [],
      emptyKeyFiles: true,
      skipped: 0,
      checkedAt: Date.now(),
    };
    cache.set(session.id, result);
    return result;
  }

  const root = workspaceRoot ?? resolveWorkspaceRootForSession(session);
  // No workspace open — we cannot validate, return neutral freshness.
  if (!root) {
    const result: ValidationResult = {
      sessionId: session.id,
      freshness: 1,
      missing: [],
      present: [],
      emptyKeyFiles: false,
      skipped: 0,
      checkedAt: Date.now(),
    };
    cache.set(session.id, result);
    return result;
  }

  const missing: string[] = [];
  const present: string[] = [];
  let skipped = 0;
  for (const rel of session.keyFiles) {
    const cleaned = cleanRelPath(rel);
    if (!cleaned) {
      // Couldn't normalize (absolute from another root, contains `..`, etc.)
      // — count it as skipped so callers can detect path-resolution issues.
      skipped++;
      continue;
    }
    const target = vscode.Uri.joinPath(root, cleaned);
    try {
      await vscode.workspace.fs.stat(target);
      present.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  const total = present.length + missing.length;
  const freshness = total === 0 ? 1 : present.length / total;
  const result: ValidationResult = {
    sessionId: session.id,
    freshness,
    missing,
    present,
    emptyKeyFiles: false,
    skipped,
    checkedAt: Date.now(),
  };
  cache.set(session.id, result);
  return result;
}

/**
 * Bulk-validate sessions. Returns a map keyed by session.id.
 *
 * Resolves each `stat` in parallel — `vscode.workspace.fs.stat` is async and
 * non-blocking, and we cap concurrency implicitly via Promise.all rather than
 * adding a semaphore (sessions are typically ≤50).
 */
export async function validateSessions(
  sessions: CompressedSession[],
  workspaceRoot?: vscode.Uri,
): Promise<Map<string, ValidationResult>> {
  const results = await Promise.all(sessions.map(s => validateSession(s, workspaceRoot ?? resolveWorkspaceRootForSession(s))));
  const map = new Map<string, ValidationResult>();
  for (const r of results) map.set(r.sessionId, r);
  return map;
}

function resolveWorkspaceRootForSession(session: CompressedSession): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return undefined;
  const byId = folders.find(f => f.uri.toString() === session.workspaceId);
  if (byId) return byId.uri;
  return folders[0].uri;
}

/**
 * Normalize a stored key-file path so we can resolve it against the workspace root.
 *
 * - Strips leading slashes
 * - Drops `file://` URIs
 * - Rejects absolute paths from other roots (returns undefined)
 * - Rejects path traversal (`..`)
 */
function cleanRelPath(p: string): string | undefined {
  if (!p) return undefined;
  let s = p.trim();
  if (s.startsWith('file://')) {
    try { s = vscode.Uri.parse(s).fsPath; } catch { /* ignore */ }
  }
  // Reject absolute paths — we only validate things that look workspace-relative.
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/')) {
    // Try to extract a workspace-relative tail by matching against workspace folders.
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) {
      const root = f.uri.fsPath;
      if (s.toLowerCase().startsWith(root.toLowerCase())) {
        s = s.slice(root.length).replace(/^[\\/]+/, '');
        break;
      }
    }
    if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/')) return undefined;
  }
  if (s.split(/[\\/]/).includes('..')) return undefined;
  return s.replace(/\\/g, '/');
}
