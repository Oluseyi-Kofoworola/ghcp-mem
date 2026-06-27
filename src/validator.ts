import * as vscode from 'vscode';
import { CompressedSession } from './types';
import { semanticTextSignature } from './sessionCapture';

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
 * Phase 1 upgrade: when a session was captured with `keyFileHashes`, the
 * validator goes one step further than stat() and compares the current file
 * content hash against the stored hash. This catches the failure mode where
 * the file still exists but its content has drifted away from the version
 * the memory was summarising — `validateAgainstCodebase` previously gave
 * such cases a freshness of 1.0, which let stale memories leak into the
 * injection layer.
 *
 * Verification classes per key file:
 *   verified — file exists AND stored hash matches current hash
 *   drifted  — file exists but stored hash differs from current
 *   missing  — file is gone or unreadable
 *   neutral  — file exists, no stored hash to compare against (legacy)
 *
 * Cheap by design: relies on `vscode.workspace.fs.stat` so a single check
 * is O(1) per file (when there is no stored hash to compare) and reads the
 * file content only when a hash comparison is requested.
 *
 * Results are cached per-session for a short window so repeated retrievals
 * don't re-stat the same paths.
 */

export type FileVerificationStatus = 'verified' | 'drifted' | 'missing' | 'neutral';

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
  /**
   * Per-file verification breakdown — populated when the session carried
   * `keyFileHashes`. Maps the workspace-relative path to one of:
   *   verified | drifted | missing | neutral
   * Files for which no hash comparison was possible (legacy sessions, or
   * sessions where the validator was disabled mid-flight) get `neutral`.
   */
  verification: Record<string, FileVerificationStatus>;
  /** Files whose stored hash matches current content. */
  verifiedFiles: string[];
  /** Files that exist but whose content has drifted from the stored hash. */
  driftedFiles: string[];
  /**
   * Confidence-weighted freshness in [0, 1]. Verified files count fully,
   * drifted files count half, neutral files count fully (legacy parity),
   * missing files count zero. Falls back to plain `freshness` when there
   * are no hashes to compare. Use this in ranking, not `freshness`.
   */
  groundedFreshness: number;
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
      verification: {},
      verifiedFiles: [],
      driftedFiles: [],
      groundedFreshness: 1,
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
      verification: {},
      verifiedFiles: [],
      driftedFiles: [],
      groundedFreshness: 1,
      checkedAt: Date.now(),
    };
    cache.set(session.id, result);
    return result;
  }

  const hashes = session.keyFileHashes ?? {};
  const missing: string[] = [];
  const present: string[] = [];
  const verifiedFiles: string[] = [];
  const driftedFiles: string[] = [];
  const verification: Record<string, FileVerificationStatus> = {};
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
      const expected = hashes[rel];
      if (expected) {
        // Hash comparison — read content and re-hash with the same
        // semantic signature function used at capture time. Any IO error
        // collapses to "missing" to avoid silent freshness=1 on bad reads.
        try {
          const buf = await vscode.workspace.fs.readFile(target);
          const text = Buffer.from(buf).toString('utf-8');
          const actual = semanticTextSignature(text);
          if (actual === expected) {
            verification[rel] = 'verified';
            verifiedFiles.push(rel);
          } else {
            verification[rel] = 'drifted';
            driftedFiles.push(rel);
          }
        } catch {
          verification[rel] = 'missing';
          // Stat said present but read failed — treat as missing for
          // freshness scoring, but also pop it back out of present[] so the
          // legacy `freshness` field stays consistent.
          present.pop();
          missing.push(rel);
        }
      } else {
        verification[rel] = 'neutral';
      }
    } catch {
      missing.push(rel);
      verification[rel] = 'missing';
    }
  }
  const total = present.length + missing.length;
  const freshness = total === 0 ? 1 : present.length / total;

  // Grounded freshness weights verification quality, so a session whose
  // files all exist but whose content has drifted gets penalised compared
  // to one whose files are byte-identical to capture time.
  let groundedScore = 0;
  let groundedTotal = 0;
  for (const rel of session.keyFiles) {
    const status = verification[rel];
    if (!status) continue; // skipped
    groundedTotal++;
    if (status === 'verified' || status === 'neutral') groundedScore += 1;
    else if (status === 'drifted') groundedScore += 0.5;
    // missing → 0
  }
  const groundedFreshness = groundedTotal === 0 ? 1 : groundedScore / groundedTotal;

  const result: ValidationResult = {
    sessionId: session.id,
    freshness,
    missing,
    present,
    emptyKeyFiles: false,
    skipped,
    verification,
    verifiedFiles,
    driftedFiles,
    groundedFreshness,
    checkedAt: Date.now(),
  };
  cache.set(session.id, result);
  return result;
}

/**
 * Bulk-validate sessions. Returns a map keyed by session.id.
 *
 * Resolves each `stat` in parallel with a concurrency cap of 20 to avoid
 * firing thousands of concurrent fs.stat calls on large stores.
 */
export async function validateSessions(
  sessions: CompressedSession[],
  workspaceRoot?: vscode.Uri,
): Promise<Map<string, ValidationResult>> {
  const CONCURRENCY = 20;
  const allResults: ValidationResult[] = [];
  for (let i = 0; i < sessions.length; i += CONCURRENCY) {
    const batch = sessions.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((s) => validateSession(s, workspaceRoot ?? resolveWorkspaceRootForSession(s))),
    );
    allResults.push(...batchResults);
  }
  const map = new Map<string, ValidationResult>();
  for (const r of allResults) map.set(r.sessionId, r);
  return map;
}

function resolveWorkspaceRootForSession(session: CompressedSession): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return undefined;
  const byId = folders.find((f) => f.uri.toString() === session.workspaceId);
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
    try {
      s = vscode.Uri.parse(s).fsPath;
    } catch {
      /* ignore */
    }
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
