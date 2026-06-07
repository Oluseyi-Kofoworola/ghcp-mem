import * as vscode from 'vscode';
import { ContextStore, SearchFilters } from './contextStore';
import { CompressedSession } from './types';
import { extractTerms, keywordScore, computeAvgDocLen } from './searchCore';

/**
 * Lightweight retrieval evaluation harness (rebase recommendation #7).
 *
 * Computes recall@k and MRR on a small canned query set built from the
 * sessions currently in the store. The "ground truth" is the strongest
 * token overlap between the query and each session's summary+topics+files —
 * not a perfect oracle, but enough to flag regressions when we tweak
 * weights in `search()` / RRF / freshness filtering.
 *
 * We compare three configurations:
 *  1. Keyword only (filters.workspaceOnly + the default text-scoring path)
 *  2. Hybrid (default search, which already does RRF + recency + workspace boost)
 *  3. Hybrid + freshness (the production path via searchWithEmbedding)
 *
 * No external dependencies and no network — runs entirely against the
 * in-memory ContextStore.
 */

export interface EvalQuery {
  q: string;
  /** Session ids that *should* appear in the top-K. */
  relevant: string[];
}

export interface EvalRunStats {
  label: string;
  k: number;
  recall: number;
  mrr: number;
  /** Phase 3: normalised Discounted Cumulative Gain at k. */
  ndcg: number;
  perQuery: Array<{ q: string; hits: number; rank: number | null }>;
}

export interface EvalReport {
  totalSessions: number;
  totalQueries: number;
  k: number;
  runs: EvalRunStats[];
  generatedAt: string;
}

const K = 5;
/** Lower bound on queries — eval should never be measured on too small a sample. */
const MIN_QUERIES = 20;
/** Upper bound on queries — we don't need thousands; latency matters too. */
const MAX_QUERIES = 50;

/**
 * Build a query set from existing sessions for self-evaluation.
 *
 * Sample size scales with the store: we want enough queries for the recall
 * number to be statistically meaningful, but capped so eval stays fast.
 * Caller can override via `max` (used by tests).
 */
export function buildSelfQueries(sessions: CompressedSession[], max?: number): EvalQuery[] {
  const target =
    max ?? Math.max(MIN_QUERIES, Math.min(MAX_QUERIES, Math.floor(sessions.length / 2)));
  const queries: EvalQuery[] = [];
  for (const s of sessions.slice(0, target)) {
    const topic = (s.keyTopics[0] || s.problemsSolved[0] || s.decisions[0] || '').trim();
    if (!topic || topic.length < 4) continue;
    queries.push({ q: topic.slice(0, 80), relevant: [s.id] });
  }
  return queries;
}

/**
 * Pure keyword-only ranker — used by the eval suite as a baseline.
 *
 * Deliberately *does not* call `store.search()`, which fuses keyword + recency
 * via RRF. Here we score by the same `keywordScore()` helper the production
 * search uses, but we sort by that score alone — no recency, no embeddings,
 * no RRF, no freshness filter. This is what the docstring claims and what the
 * eval suite needs to actually compare against the hybrid path.
 */
function keywordOnlyRun(store: ContextStore, query: string, limit: number): CompressedSession[] {
  const terms = extractTerms(query);
  if (terms.size === 0) return [];
  const wsId = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
  const all = store.getAllSessions();
  const avgDocLen = computeAvgDocLen(all);
  return all
    .map((s) => ({ s, score: keywordScore(s, terms, wsId, avgDocLen) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => e.s);
}

function recallAtK(top: CompressedSession[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  let hit = 0;
  for (const s of top.slice(0, k)) if (relevant.has(s.id)) hit++;
  return hit / Math.min(relevant.size, k);
}

function reciprocalRank(
  top: CompressedSession[],
  relevant: Set<string>,
): { mrr: number; rank: number | null } {
  for (let i = 0; i < top.length; i++) {
    if (relevant.has(top[i].id)) return { mrr: 1 / (i + 1), rank: i + 1 };
  }
  return { mrr: 0, rank: null };
}

/**
 * Normalised DCG at k. Treats every relevant id as graded-relevance 1 — the
 * gold corpus shape (`{q, relevant: id[]}`) doesn't carry per-id grades, so
 * this collapses to the standard binary nDCG: `DCG@k / IDCG@k`.
 *
 * Exported so the regression gate (`scripts/eval-check.js`) can call it
 * directly without re-implementing the math.
 */
export function ndcgAtK(top: CompressedSession[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  let dcg = 0;
  for (let i = 0; i < Math.min(top.length, k); i++) {
    if (relevant.has(top[i].id)) {
      // gain = 1 (binary relevance), discount = log2(i+2) — i is 0-based.
      dcg += 1 / Math.log2(i + 2);
    }
  }
  const idealHits = Math.min(relevant.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

async function evalRun(
  label: string,
  queries: EvalQuery[],
  run: (q: string) => Promise<CompressedSession[]> | CompressedSession[],
): Promise<EvalRunStats> {
  let totalRecall = 0;
  let totalMrr = 0;
  let totalNdcg = 0;
  const perQuery: EvalRunStats['perQuery'] = [];
  for (const q of queries) {
    const top = await Promise.resolve(run(q.q));
    const relevantSet = new Set(q.relevant);
    const r = recallAtK(top, relevantSet, K);
    const { mrr, rank } = reciprocalRank(top, relevantSet);
    const n = ndcgAtK(top, relevantSet, K);
    totalRecall += r;
    totalMrr += mrr;
    totalNdcg += n;
    perQuery.push({ q: q.q, hits: r * Math.min(relevantSet.size, K), rank });
  }
  const n = Math.max(queries.length, 1);
  return {
    label,
    k: K,
    recall: totalRecall / n,
    mrr: totalMrr / n,
    ndcg: totalNdcg / n,
    perQuery,
  };
}

/**
 * Run the eval suite against a caller-supplied gold corpus. Unlike
 * `runEvalSuite`, this never falls back to self-queries — the gold set
 * is the ground truth and we report metrics straight against it. Used by
 * `scripts/eval-check.js --gold <path>` to gate regressions in CI.
 */
export async function runGoldEval(store: ContextStore, queries: EvalQuery[]): Promise<EvalReport> {
  const all = store.getAllSessions();
  const filters: SearchFilters = {};
  const runs: EvalRunStats[] = [];
  if (queries.length === 0) {
    return {
      totalSessions: all.length,
      totalQueries: 0,
      k: K,
      runs: [],
      generatedAt: new Date().toISOString(),
    };
  }
  runs.push(await evalRun('keyword-only', queries, (q) => keywordOnlyRun(store, q, 20)));
  runs.push(await evalRun('hybrid (default)', queries, (q) => store.search(q, filters, 20)));
  runs.push(
    await evalRun('hybrid + freshness', queries, (q) => store.searchWithEmbedding(q, filters, 20)),
  );
  return {
    totalSessions: all.length,
    totalQueries: queries.length,
    k: K,
    runs,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Run the eval suite against the store's current contents. If there are
 * fewer than 3 sessions, returns an empty report (we can't measure recall
 * with that little data — bail rather than produce a misleading number).
 */
export async function runEvalSuite(store: ContextStore): Promise<EvalReport> {
  const all = store.getAllSessions();
  const queries = buildSelfQueries(all);
  const filters: SearchFilters = {};
  const runs: EvalRunStats[] = [];

  if (all.length >= 3 && queries.length > 0) {
    runs.push(await evalRun('keyword-only', queries, (q) => keywordOnlyRun(store, q, 20)));
    runs.push(await evalRun('hybrid (default)', queries, (q) => store.search(q, filters, 20)));
    runs.push(
      await evalRun('hybrid + freshness', queries, (q) =>
        store.searchWithEmbedding(q, filters, 20),
      ),
    );
  }

  return {
    totalSessions: all.length,
    totalQueries: queries.length,
    k: K,
    runs,
    generatedAt: new Date().toISOString(),
  };
}

/** Format an eval report as readable markdown. */
export function formatEvalReport(r: EvalReport): string {
  const lines: string[] = [];
  lines.push('# Baton Retrieval Eval');
  lines.push('');
  lines.push(`- generated: ${r.generatedAt}`);
  lines.push(`- sessions: ${r.totalSessions}`);
  lines.push(`- queries: ${r.totalQueries}`);
  lines.push(`- k: ${r.k}`);
  lines.push('');
  if (r.runs.length === 0) {
    lines.push(
      '_Not enough sessions or queries to run an evaluation (need ≥3 sessions with topics)._',
    );
    return lines.join('\n');
  }
  lines.push('| Config | Recall@k | MRR | nDCG@k |');
  lines.push('| --- | ---:| ---:| ---:|');
  for (const run of r.runs) {
    lines.push(
      `| ${run.label} | ${run.recall.toFixed(3)} | ${run.mrr.toFixed(3)} | ${run.ndcg.toFixed(3)} |`,
    );
  }
  lines.push('');
  for (const run of r.runs) {
    lines.push(`## ${run.label}`);
    lines.push('');
    lines.push('| Query | Rank | Hits |');
    lines.push('| --- | ---:| ---:|');
    for (const p of run.perQuery) {
      // Escape backslashes first, then pipes, so a query containing literal
      // `\` doesn't break GFM table rendering (and the CodeQL
      // incomplete-string-escaping check stays clean).
      const q = p.q.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
      lines.push(`| ${q} | ${p.rank ?? '—'} | ${p.hits} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
