/**
 * Snippet layer — chunk-level retrieval over compressed sessions.
 *
 * The original Phase 1 critique called out that storing only one embedding
 * per session loses granular recall: a 10-minute "auth + billing + settings"
 * session pools its vector across three unrelated topics, so an "auth"
 * query either retrieves the noisy whole-session blob or misses entirely.
 *
 * This module gives developers proper chunk-level recall WITHOUT taking
 * a native-dep dependency on a vector index. Each CompressedSession is
 * decomposed into typed snippets (summary, decision, problem, topic).
 * Snippets are derived (not stored separately) so there's no schema
 * migration: addSession indexes incrementally, and the on-disk shape
 * stays identical.
 *
 * Retrieval uses the same BM25 + recency + confidence stack as session
 * search, but at snippet granularity — so `@mem how do we hash passwords`
 * returns the actual decision text + its session ID, not the whole 800-
 * token session card.
 *
 * Pure module: no vscode imports, safe to share with the MCP server.
 */

import { CompressedSession, Evidence } from './types';

/** Kind of chunk a snippet represents. Drives weighting at retrieval time. */
export type SnippetKind = 'summary' | 'decision' | 'problem' | 'topic';

export interface Snippet {
  /** Composite ID: `<sessionId>#<kind>:<index>` — stable across rebuilds. */
  id: string;
  sessionId: string;
  kind: SnippetKind;
  text: string;
  /** Wall-clock timestamp this snippet was first emitted (= session.endTime). */
  emittedAt: number;
  /** Inherited from parent session — same shape so renderers stay simple. */
  confidence?: number;
  /** Evidence backing the specific snippet (decisions/problems only). */
  evidence?: Evidence[];
  /**
   * Workspace ID of the parent session. Lets the snippet ranker apply the
   * same workspace boost as session retrieval without joining back to
   * CompressedSession at scoring time.
   */
  workspaceId: string;
  /**
   * Retraction state inherited from the parent session. Retracted snippets
   * are filtered out before scoring (consistent with session search).
   */
  retracted: boolean;
  /** Parent supersededBy id — used for soft down-rank, same as sessions. */
  supersededBy?: string;
}

/**
 * Decompose a single session into its constituent snippets.
 *
 *  summary  → one snippet, kind='summary'
 *  decision → one snippet per `decisions[i]`, kind='decision', evidence
 *             aligned with `decisionEvidence[i]`
 *  problem  → one snippet per `problemsSolved[i]`, kind='problem', evidence
 *             aligned with `problemEvidence[i]`
 *  topic    → one snippet per `keyTopics[i]`, kind='topic' (no evidence)
 *
 * Topics are emitted as standalone snippets so a "JWT" search lights up
 * a session that lists JWT as a topic but never wrote a decision about it.
 * Empty fields are skipped so we never produce a snippet for an empty string.
 */
export function snippetsFromSession(s: CompressedSession): Snippet[] {
  const out: Snippet[] = [];
  const base = {
    sessionId: s.id,
    emittedAt: s.endTime,
    confidence: s.confidence,
    workspaceId: s.workspaceId,
    retracted: !!s.retracted,
    supersededBy: s.supersededBy,
  } as const;

  if (s.summary && s.summary.trim()) {
    out.push({ ...base, id: `${s.id}#summary:0`, kind: 'summary', text: s.summary.trim() });
  }
  s.decisions.forEach((text, i) => {
    if (!text || !text.trim()) return;
    out.push({
      ...base,
      id: `${s.id}#decision:${i}`,
      kind: 'decision',
      text: text.trim(),
      evidence: s.decisionEvidence?.[i],
    });
  });
  s.problemsSolved.forEach((text, i) => {
    if (!text || !text.trim()) return;
    out.push({
      ...base,
      id: `${s.id}#problem:${i}`,
      kind: 'problem',
      text: text.trim(),
      evidence: s.problemEvidence?.[i],
    });
  });
  s.keyTopics.forEach((text, i) => {
    if (!text || !text.trim()) return;
    out.push({ ...base, id: `${s.id}#topic:${i}`, kind: 'topic', text: text.trim() });
  });

  return out;
}

/**
 * Field weights for snippet BM25. Decisions/problems are the high-value
 * payload; summary is medium; topics are short keywords (so low TF but
 * useful for recall). These weights deliberately mirror the per-field
 * weights in `searchCore.ts` so session search and snippet search produce
 * coherent rankings.
 */
const KIND_WEIGHT: Record<SnippetKind, number> = {
  decision: 4,
  problem: 4,
  summary: 3,
  topic: 5,
};

/**
 * Tokenise snippet text using the same rules as the session-level scorer
 * so a query that hits a session also hits the snippets within it.
 */
export function tokenizeSnippet(text: string): Set<string> {
  return new Set(
    (text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * BM25-weighted keyword score for a single snippet against a query term set.
 * Mirrors the structure of `keywordScore()` in `searchCore.ts` but operates
 * on snippet fields instead of session fields. Always returns ≥ 0.
 */
export function snippetScore(s: Snippet, terms: Set<string>, avgDocLen = 20): number {
  if (terms.size === 0) return 0;
  const tokens = tokenizeSnippet(s.text);
  if (tokens.size === 0) return 0;
  const weight = KIND_WEIGHT[s.kind];
  const docLen = tokens.size * weight;
  let score = 0;
  for (const term of terms) {
    if (!tokens.has(term)) continue;
    // Weighted TF of 1 (binary presence × field weight) into BM25 saturation.
    const tf = weight;
    score += (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen)));
  }
  return score;
}

/** Average doc length across a snippet set — used for BM25 normalisation. */
export function avgSnippetLen(snippets: Snippet[]): number {
  if (snippets.length === 0) return 20;
  let total = 0;
  for (const s of snippets) total += tokenizeSnippet(s.text).size * KIND_WEIGHT[s.kind];
  return total / snippets.length || 20;
}
