/**
 * Shared search primitives used by both ContextStore (in-process) and the
 * standalone MCP server (out-of-process). Keeping these in one module
 * prevents the two ranking paths from drifting — the v1.1.5 ranking bug
 * existed precisely because mcpServer.ts and contextStore.ts each carried
 * their own copy of the keyword scorer.
 *
 * The structural shape of a session here is intentionally a narrow subset
 * of `CompressedSession` so this module stays import-free of vscode types
 * (the MCP server runs as a plain Node process under stdio).
 */

/** Minimum surface of a session needed by the shared scorer. */
export interface ScorableSession {
  workspaceId: string;
  summary: string;
  keyFiles: string[];
  keyTopics: string[];
  decisions: string[];
  problemsSolved: string[];
  userTags: string[];
  observationType: string;
}

/** Field weights — kept identical to the original duplicated logic. */
const WEIGHT_SUMMARY = 3;
const WEIGHT_KEY_TOPIC = 5;
const WEIGHT_KEY_FILE = 2;
const WEIGHT_DECISION = 4;
const WEIGHT_PROBLEM = 4;
const WEIGHT_USER_TAG = 6;
const WORKSPACE_BOOST = 2;

/**
 * Tokenise a piece of free text into a set of search terms.
 * Identical splitting rules used everywhere we score: lowercase, strip
 * non-[a-z0-9_-] punctuation to spaces, split on whitespace, drop ≤2-char
 * tokens (so 'js', 'is', 'to' don't bloat the index).
 */
export function extractTerms(text: string): Set<string> {
  return new Set(
    (text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2),
  );
}

/**
 * Keyword score for one session against a set of query terms.
 * When `workspaceId` is supplied AND matches the session's workspaceId the
 * score gets a small additive boost. The MCP server passes no workspaceId
 * since it serves cross-workspace queries from disk.
 */
export function keywordScore(
  s: ScorableSession,
  terms: Set<string>,
  workspaceId?: string,
): number {
  let score = 0;
  if (workspaceId && s.workspaceId === workspaceId) score += WORKSPACE_BOOST;

  const check = (text: string, weight: number) => {
    const toks = extractTerms(text);
    for (const t of terms) if (toks.has(t)) score += weight;
  };

  check(s.summary, WEIGHT_SUMMARY);
  for (const t of s.keyTopics) check(t, WEIGHT_KEY_TOPIC);
  for (const f of s.keyFiles) check(f, WEIGHT_KEY_FILE);
  for (const d of s.decisions) check(d, WEIGHT_DECISION);
  for (const p of s.problemsSolved) check(p, WEIGHT_PROBLEM);
  for (const t of s.userTags) check(t, WEIGHT_USER_TAG);

  return score;
}
