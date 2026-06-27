/**
 * Query intent classifier — a tiny rule-based bucketer that lets retrieval
 * reweight signals based on what the developer is actually asking for.
 *
 * Intent labels:
 *   decision — "why did we ...", "what did we decide ...", "rationale for ..."
 *   problem  — "have we hit ... before", "did we fix ...", "error ..."
 *   entity   — "what is X", "how does Y work", queries dominated by an identifier
 *   recent   — "what was I working on", "yesterday", "this week"
 *   general  — fallback: tags, file paths, free text
 *
 * Used by ContextStore.search to reweight RRF signals (e.g. recent → triple
 * recency weight, decision → boost sessions with non-empty `decisions`).
 *
 * Pure-function module, no vscode imports — safe to consume from the MCP
 * server and shared with the in-process store.
 */

export type QueryIntent = 'decision' | 'problem' | 'entity' | 'recent' | 'general';

const DECISION_PATTERNS: RegExp[] = [
  /\bwhy did (we|i|you)\b/i,
  /\bwhat did (we|i|you) (decide|pick|choose|settle on)\b/i,
  /\b(rationale|reasoning)\b/i,
  /\b(decision|design choice|architecture decision|adr)\b/i,
  /\bwhich (option|approach) did\b/i,
];

const PROBLEM_PATTERNS: RegExp[] = [
  /\b(have|did) (we|i|you) (hit|fix|see) (this|that|a similar)\b/i,
  /\bbroke(n)?\b/i,
  /\b(stack ?trace|exception|error|bug|crash|regression)\b/i,
  /\bhow did (we|i|you) (fix|solve|resolve|work around)\b/i,
];

const RECENT_PATTERNS: RegExp[] = [
  /\bwhat (am|was) i (working on|doing)\b/i,
  /\b(yesterday|today|this (week|morning|afternoon))\b/i,
  /\b(latest|most recent|last) (session|change|commit)\b/i,
  /\bwhere did i (leave off|stop)\b/i,
];

/**
 * Lightweight identifier-shape detector. Treats CamelCase, camelCase,
 * snake_case, and file-path-like tokens as evidence of an entity-focused
 * query.
 */
const IDENTIFIER_RE =
  /\b([a-zA-Z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+|[a-z]+[_][a-z0-9_]+|[\w./-]*\.[a-z]{1,4})\b/;

export function classifyIntent(query: string): QueryIntent {
  const q = (query ?? '').trim();
  if (!q) return 'general';
  for (const re of DECISION_PATTERNS) if (re.test(q)) return 'decision';
  for (const re of PROBLEM_PATTERNS) if (re.test(q)) return 'problem';
  for (const re of RECENT_PATTERNS) if (re.test(q)) return 'recent';

  // Identifier-shaped queries: only classify as entity when the
  // identifier dominates the query (not buried in a longer prose sentence).
  if (IDENTIFIER_RE.test(q) && q.split(/\s+/).length <= 4) return 'entity';

  return 'general';
}

/**
 * Per-intent ranking multipliers consumed by ContextStore.search.
 * Each value modulates one component of the fused score.
 *
 *   recencyMultiplier — multiplies the exponential-decay component
 *   decisionBoost     — additive boost when session.decisions is non-empty
 *   problemBoost      — additive boost when session.problemsSolved is non-empty
 *   keywordWeight     — multiplies the BM25 contribution (entity queries
 *                       benefit from sharper keyword matching)
 */
export interface IntentWeights {
  recencyMultiplier: number;
  decisionBoost: number;
  problemBoost: number;
  keywordWeight: number;
}

export function intentWeights(intent: QueryIntent): IntentWeights {
  switch (intent) {
    case 'decision':
      return { recencyMultiplier: 1.0, decisionBoost: 0.25, problemBoost: 0, keywordWeight: 1.0 };
    case 'problem':
      return { recencyMultiplier: 1.0, decisionBoost: 0, problemBoost: 0.25, keywordWeight: 1.0 };
    case 'entity':
      return { recencyMultiplier: 0.7, decisionBoost: 0, problemBoost: 0, keywordWeight: 1.25 };
    case 'recent':
      return { recencyMultiplier: 3.0, decisionBoost: 0, problemBoost: 0, keywordWeight: 0.5 };
    case 'general':
    default:
      return { recencyMultiplier: 1.0, decisionBoost: 0, problemBoost: 0, keywordWeight: 1.0 };
  }
}
