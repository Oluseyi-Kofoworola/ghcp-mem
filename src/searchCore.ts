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

/** BM25 tuning parameters. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Compute a weighted document length for BM25 normalisation.
 * Counts unique terms across all weighted fields (weighted by field weight).
 */
export function sessionDocLen(s: ScorableSession): number {
  let total = 0;
  const addField = (text: string, weight: number) => {
    total += extractTerms(text).size * weight;
  };
  addField(s.summary, WEIGHT_SUMMARY);
  for (const t of s.keyTopics) addField(t, WEIGHT_KEY_TOPIC);
  for (const f of s.keyFiles) addField(f, WEIGHT_KEY_FILE);
  for (const d of s.decisions) addField(d, WEIGHT_DECISION);
  for (const p of s.problemsSolved) addField(p, WEIGHT_PROBLEM);
  for (const t of s.userTags) addField(t, WEIGHT_USER_TAG);
  return total || 1;
}

/**
 * Compute the average document length across a set of sessions for BM25.
 * Falls back to a sensible default (50 weighted terms) when the set is empty.
 */
export function computeAvgDocLen(sessions: ScorableSession[]): number {
  if (sessions.length === 0) return 50;
  return sessions.reduce((sum, s) => sum + sessionDocLen(s), 0) / sessions.length;
}

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
      .filter((t) => t.length > 2),
  );
}

/**
 * BM25-weighted keyword score for one session against a set of query terms.
 *
 * Field weights are applied as multipliers to the per-term weighted TF,
 * preserving the original field-importance hierarchy while adding BM25's
 * TF-saturation and document-length normalisation.
 *
 * When `workspaceId` is supplied AND matches the session's workspaceId the
 * score gets a small additive boost. The MCP server passes no workspaceId
 * since it serves cross-workspace queries from disk.
 *
 * @param avgDocLen  Average document length (weighted) across the candidate
 *                   set. Callers should compute this with `computeAvgDocLen()`
 *                   before scoring. Defaults to 50 for backward compatibility.
 */
export function keywordScore(
  s: ScorableSession,
  terms: Set<string>,
  workspaceId?: string,
  avgDocLen = 50,
): number {
  let score = 0;
  if (workspaceId && s.workspaceId === workspaceId) score += WORKSPACE_BOOST;

  // Build a weighted term-frequency map across all fields.
  const wtf = new Map<string, number>();
  const addField = (text: string, weight: number) => {
    for (const tok of extractTerms(text)) {
      wtf.set(tok, (wtf.get(tok) ?? 0) + weight);
    }
  };
  addField(s.summary, WEIGHT_SUMMARY);
  for (const t of s.keyTopics) addField(t, WEIGHT_KEY_TOPIC);
  for (const f of s.keyFiles) addField(f, WEIGHT_KEY_FILE);
  for (const d of s.decisions) addField(d, WEIGHT_DECISION);
  for (const p of s.problemsSolved) addField(p, WEIGHT_PROBLEM);
  for (const t of s.userTags) addField(t, WEIGHT_USER_TAG);

  const docLen = wtf.size || 1;

  for (const term of terms) {
    const tf = wtf.get(term) ?? 0;
    if (tf === 0) continue;
    // BM25 TF-saturation with document-length normalisation.
    score += (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen)));
  }

  return score;
}
