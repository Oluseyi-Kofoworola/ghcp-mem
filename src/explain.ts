/**
 * Score-decomposition explainer.
 *
 * Phase 6 trust-transparency win: when a developer asks "why did `@baton auth`
 * surface session 4f7e3a91 above 1a2b3c4d?", the system can show its work.
 *
 * `explainScore(session, query, store)` reruns the exact fusion math used
 * by `ContextStore.search()` but emits a structured per-component report
 * instead of a number. Each contribution is labelled, signed, and grouped
 * so a renderer can show the developer:
 *
 *   keyword     +0.045   (rank 2/14, learned ×1.12)
 *   recency     +0.180   (7-day half-life, intent ×1.0, learned ×1.05)
 *   confidence  +0.030   (effective 0.82, learned ×1.00)
 *   reinforcement +0.012 (5 retrievals, learned ×1.08)
 *   feedback    +0.100   (2 accepts − 0 rejects, learned ×1.02)
 *   match ratio +0.250   (2 of 2 query terms matched)
 *   workspace   +0.150   (active workspace)
 *   superseded   0.000   (live)
 *   ─────────────────────
 *   TOTAL       +0.767
 *
 * This is the single most important feature for moving from "the LLM
 * said this happened" to a system developers actually trust — when the
 * ranking is wrong, they can finally see WHY and run /correct or /reject
 * with informed confidence.
 *
 * Pure module: no vscode imports. The chat command in `contextProvider`
 * wraps the result in markdown.
 */

import { CompressedSession } from './types';
import { extractTerms, keywordScore, computeAvgDocLen } from './searchCore';
import { effectiveConfidence } from './decay';
import { classifyIntent, intentWeights } from './queryIntent';
import { defaultWeights, SignalName } from './adaptiveWeights';

/** A single named contribution to the final fused score. */
export interface ScoreContribution {
  label: string;
  value: number;
  /** Short human-readable explanation (e.g. "rank 2/14, learned ×1.12"). */
  detail: string;
}

export interface ScoreExplanation {
  sessionId: string;
  query: string;
  intent: string;
  total: number;
  contributions: ScoreContribution[];
  /** Comparable rank of this session within the candidate pool (1-based). */
  rank?: number;
  /** Total candidate count (so the rank is contextualised). */
  candidateCount?: number;
}

export interface ExplainContext {
  /** All sessions visible to the ranker — used to compute ranks + BM25 normalisation. */
  allSessions: CompressedSession[];
  /** Current learned weight multipliers — defaults to identity when not provided. */
  learnedWeights?: Record<SignalName, number>;
  /** Optional active workspace ID (for the workspace boost). */
  activeWorkspaceId?: string;
}

/**
 * Compute a complete per-component breakdown of one session's score for
 * a given query. Mirrors the fusion logic in `ContextStore.search` exactly
 * so the explained total agrees with the actual rank to within float noise.
 */
export function explainScore(
  session: CompressedSession,
  query: string,
  ctx: ExplainContext,
): ScoreExplanation {
  const terms = extractTerms(query);
  const intent = classifyIntent(query);
  const weights = intentWeights(intent);
  const learned = ctx.learnedWeights ?? defaultWeights();
  const all = ctx.allSessions;

  // Reconstruct the candidate pool: retracted excluded, everything else
  // visible at scoring time.
  const candidates = all.filter((s) => !s.retracted);

  // ── keyword rank ──────────────────────────────────────────────────────────
  const avgDocLen = computeAvgDocLen(candidates);
  const kScores = candidates.map((s) => ({
    id: s.id,
    k: keywordScore(s, terms, ctx.activeWorkspaceId, avgDocLen),
  }));
  kScores.sort((a, b) => b.k - a.k);
  const kRank = kScores.findIndex((e) => e.id === session.id);
  const kRrf = kRank >= 0 ? 1 / (60 + kRank) : 1 / (60 + 60 * 10);
  const keywordContribution = kRrf * weights.keywordWeight * learned.keyword;

  // ── recency rank + decay ──────────────────────────────────────────────────
  const rSorted = [...candidates].sort((a, b) => b.endTime - a.endTime);
  const rRank = rSorted.findIndex((s) => s.id === session.id);
  const rRrf = rRank >= 0 ? 1 / (60 + rRank) : 1 / (60 + 60 * 10);
  const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
  const ageMs = Math.max(0, Date.now() - session.endTime);
  const recencyValue = Math.pow(2, -ageMs / HALF_LIFE_MS);
  // Recency contributes via two paths in the real fusion: an RRF rank
  // component and an exponential-decay boost. We bundle them into one
  // "recency" line so the explainer table mirrors the user's mental
  // model of "newer = higher".
  const decayContribution = rRrf + recencyValue * 0.3 * weights.recencyMultiplier * learned.recency;

  // ── workspace boost ───────────────────────────────────────────────────────
  const wsBoost = ctx.activeWorkspaceId && session.workspaceId === ctx.activeWorkspaceId ? 0.15 : 0;

  // ── match ratio ───────────────────────────────────────────────────────────
  let termMatchCount = 0;
  if (terms.size > 0) {
    const termsArr = [...terms];
    const sessText = [
      session.summary,
      ...session.keyFiles,
      ...session.keyTopics,
      ...session.decisions,
      ...session.problemsSolved,
      ...session.userTags,
    ]
      .join(' ')
      .toLowerCase();
    for (const t of termsArr) if (sessText.includes(t)) termMatchCount++;
  }
  const matchRatio = terms.size > 0 ? termMatchCount / terms.size : 0;
  const matchBoost = matchRatio * 0.25;

  // ── confidence ────────────────────────────────────────────────────────────
  const confValue = effectiveConfidence(session) ?? 0.5;
  const confBoost = (confValue - 0.5) * 0.1 * learned.confidence;

  // ── intent-driven boosts ──────────────────────────────────────────────────
  const decisionBoost =
    weights.decisionBoost > 0 && session.decisions.length > 0 ? weights.decisionBoost : 0;
  const problemBoost =
    weights.problemBoost > 0 && session.problemsSolved.length > 0 ? weights.problemBoost : 0;

  // ── supersession penalty ──────────────────────────────────────────────────
  const supersededPenalty = session.supersededBy ? -0.3 : 0;

  // ── reinforcement + feedback ──────────────────────────────────────────────
  let maxRetrieved = 1;
  for (const s of candidates) {
    const r = s.usage?.retrieved ?? 0;
    if (r > maxRetrieved) maxRetrieved = r;
  }
  const reinforcementNorm = Math.log(1 + maxRetrieved) || 1;
  const retrieved = session.usage?.retrieved ?? 0;
  const reinforcementValue = Math.log(1 + retrieved) / reinforcementNorm;
  const reinforcement = reinforcementValue * 0.1 * learned.reinforcement;

  const accepted = session.usage?.accepted ?? 0;
  const rejected = session.usage?.rejected ?? 0;
  const feedbackValue = accepted - rejected;
  const feedback = feedbackValue * 0.05 * learned.feedback;

  const contributions: ScoreContribution[] = [
    {
      label: 'keyword',
      value: keywordContribution,
      detail: `rank ${kRank + 1}/${candidates.length}${learned.keyword !== 1 ? `, learned ×${learned.keyword.toFixed(2)}` : ''}${weights.keywordWeight !== 1 ? `, intent ×${weights.keywordWeight.toFixed(2)}` : ''}`,
    },
    {
      label: 'recency',
      value: decayContribution,
      detail: `7-day half-life${weights.recencyMultiplier !== 1 ? `, intent ×${weights.recencyMultiplier.toFixed(1)}` : ''}${learned.recency !== 1 ? `, learned ×${learned.recency.toFixed(2)}` : ''}`,
    },
    {
      label: 'workspace',
      value: wsBoost,
      detail: wsBoost > 0 ? 'matches active workspace' : 'different workspace',
    },
    {
      label: 'match-ratio',
      value: matchBoost,
      detail: `${termMatchCount} of ${terms.size} query terms`,
    },
    {
      label: 'confidence',
      value: confBoost,
      detail: `effective ${confValue.toFixed(2)}${learned.confidence !== 1 ? `, learned ×${learned.confidence.toFixed(2)}` : ''}`,
    },
    {
      label: 'decision-boost',
      value: decisionBoost,
      detail: decisionBoost > 0 ? `intent=${intent}, has decisions` : '—',
    },
    {
      label: 'problem-boost',
      value: problemBoost,
      detail: problemBoost > 0 ? `intent=${intent}, has problems` : '—',
    },
    {
      label: 'reinforcement',
      value: reinforcement,
      detail: `${retrieved} retrievals${learned.reinforcement !== 1 ? `, learned ×${learned.reinforcement.toFixed(2)}` : ''}`,
    },
    {
      label: 'feedback',
      value: feedback,
      detail: `${accepted} accepts − ${rejected} rejects${learned.feedback !== 1 ? `, learned ×${learned.feedback.toFixed(2)}` : ''}`,
    },
    {
      label: 'superseded',
      value: supersededPenalty,
      detail:
        supersededPenalty < 0 ? `superseded by ${session.supersededBy!.substring(0, 8)}` : 'live',
    },
  ];

  const total = contributions.reduce((acc, c) => acc + c.value, 0);

  // Final rank within the pool — compute by scoring everyone once.
  const fullyScored = candidates
    .map((s) => ({
      id: s.id,
      score: scoreOne(s, terms, ctx, weights, learned, candidates, avgDocLen),
    }))
    .sort((a, b) => b.score - a.score);
  const rank = fullyScored.findIndex((x) => x.id === session.id) + 1;

  return {
    sessionId: session.id,
    query,
    intent,
    total,
    contributions,
    rank,
    candidateCount: candidates.length,
  };
}

/** Pre-computed singleton for the rank lookup so we don't recurse via explainScore. */
function scoreOne(
  s: CompressedSession,
  terms: Set<string>,
  ctx: ExplainContext,
  weights: ReturnType<typeof intentWeights>,
  learned: Record<SignalName, number>,
  candidates: CompressedSession[],
  avgDocLen: number,
): number {
  const kScores = candidates.map((c) => ({
    id: c.id,
    k: keywordScore(c, terms, ctx.activeWorkspaceId, avgDocLen),
  }));
  kScores.sort((a, b) => b.k - a.k);
  const kRank = kScores.findIndex((e) => e.id === s.id);
  const kRrf = kRank >= 0 ? 1 / (60 + kRank) : 1 / (60 + 60 * 10);
  const keywordC = kRrf * weights.keywordWeight * learned.keyword;
  const rSorted = [...candidates].sort((a, b) => b.endTime - a.endTime);
  const rRank = rSorted.findIndex((c) => c.id === s.id);
  const rRrf = rRank >= 0 ? 1 / (60 + rRank) : 1 / (60 + 60 * 10);
  const ageMs = Math.max(0, Date.now() - s.endTime);
  const decay =
    Math.pow(2, -ageMs / (7 * 24 * 60 * 60 * 1000)) *
    0.3 *
    weights.recencyMultiplier *
    learned.recency;
  const wsBoost = ctx.activeWorkspaceId && s.workspaceId === ctx.activeWorkspaceId ? 0.15 : 0;
  let termMatchCount = 0;
  if (terms.size > 0) {
    const text = [
      s.summary,
      ...s.keyFiles,
      ...s.keyTopics,
      ...s.decisions,
      ...s.problemsSolved,
      ...s.userTags,
    ]
      .join(' ')
      .toLowerCase();
    for (const t of terms) if (text.includes(t)) termMatchCount++;
  }
  const matchBoost = (terms.size > 0 ? termMatchCount / terms.size : 0) * 0.25;
  const confBoost = ((effectiveConfidence(s) ?? 0.5) - 0.5) * 0.1 * learned.confidence;
  const decisionBoost =
    weights.decisionBoost > 0 && s.decisions.length > 0 ? weights.decisionBoost : 0;
  const problemBoost =
    weights.problemBoost > 0 && s.problemsSolved.length > 0 ? weights.problemBoost : 0;
  const supersededPenalty = s.supersededBy ? -0.3 : 0;
  let maxR = 1;
  for (const c of candidates) {
    const r = c.usage?.retrieved ?? 0;
    if (r > maxR) maxR = r;
  }
  const reinforcement =
    (Math.log(1 + (s.usage?.retrieved ?? 0)) / (Math.log(1 + maxR) || 1)) *
    0.1 *
    learned.reinforcement;
  const feedback = ((s.usage?.accepted ?? 0) - (s.usage?.rejected ?? 0)) * 0.05 * learned.feedback;
  return (
    keywordC +
    rRrf +
    decay +
    wsBoost +
    matchBoost +
    confBoost +
    decisionBoost +
    problemBoost +
    supersededPenalty +
    reinforcement +
    feedback
  );
}

/**
 * Render a ScoreExplanation as chat-friendly markdown. Sorts contributions
 * by absolute magnitude so the dominant signals are at the top — easiest
 * for developers to spot the cause of a surprising rank.
 */
export function renderExplanation(e: ScoreExplanation): string {
  const lines: string[] = [];
  lines.push(`## 🔎 Why did \`${e.sessionId.substring(0, 8)}\` rank where it did?`);
  lines.push('');
  lines.push(`**Query:** \`${e.query}\` · **Intent:** \`${e.intent}\``);
  if (e.rank && e.candidateCount) {
    lines.push(`**Final rank:** ${e.rank} of ${e.candidateCount}`);
  }
  lines.push(`**Total score:** ${formatNum(e.total)}`);
  lines.push('');
  lines.push('| Signal | Contribution | Detail |');
  lines.push('| --- | ---:| --- |');
  const sorted = [...e.contributions].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  for (const c of sorted) {
    lines.push(`| ${c.label} | ${formatSignedNum(c.value)} | ${c.detail} |`);
  }
  return lines.join('\n');
}

function formatNum(n: number): string {
  return n.toFixed(3);
}
function formatSignedNum(n: number): string {
  const s = n.toFixed(3);
  return n > 0 ? `+${s}` : s;
}
