/**
 * Shared workspace-path fuzzy match.
 *
 * Sessions store file paths as workspace-relative strings at capture time;
 * later when we want to ask "did any session touch this file?" the candidate
 * path may be (a) the same string, (b) a longer/shorter relative variant
 * because the workspace root changed, or (c) the same basename in a moved
 * directory. The same four-way comparison was copy-pasted across at least
 * four sites (contextProvider.ts and extension.ts) — diverging silently as
 * the codebase grew. v1.11.0 consolidates it here so the matching rule has
 * exactly one definition and the tests can pin it.
 *
 * The match is intentionally permissive: this drives "show me sessions that
 * touched this file" UX, not security boundaries, so false positives are
 * cheap and false negatives hurt discovery. Comparison is case-insensitive
 * because filesystems on macOS/Windows are.
 */

/**
 * Returns true if `stored` (a session's recorded file path) plausibly refers
 * to the same file as `candidate` (the path the caller has in hand right now).
 *
 * Match conditions, any one suffices:
 *   1. exact case-insensitive equality
 *   2. one path is a path-suffix of the other (handles workspace-root drift)
 *   3. same final basename (handles file moved to a new directory)
 */
export function matchFilePath(stored: string, candidate: string): boolean {
  if (!stored || !candidate) return false;
  const s = stored.toLowerCase();
  const c = candidate.toLowerCase();
  if (s === c) return true;
  if (s.endsWith('/' + c) || c.endsWith('/' + s)) return true;
  return baseName(s) === baseName(c);
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
