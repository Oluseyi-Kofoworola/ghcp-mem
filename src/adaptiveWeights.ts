/**
 * Adaptive ranking weights — closes the reinforcement loop.
 *
 * Phase 2 added per-session telemetry: every search bumps `usage.retrieved`,
 * and the developer can mark a memory `accepted` or `rejected`. Phase 3 used
 * those counters as a simple linear boost. This module goes one step further:
 * it observes which RANKING SIGNALS correlate with positive feedback and
 * gently adjusts the weights so the ranker self-corrects to each developer's
 * actual workflow.
 *
 * Design constraints (all enforced by tests):
 *   - Bounded: each weight multiplier stays in [0.75, 1.25]. We never let
 *     learning blow up the ranker's behaviour by more than ±25%.
 *   - Conservative: we update at most 5% per learning round. Convergence is
 *     slow but stable; one bad week of feedback can't wreck the index.
 *   - Cold-start safe: with fewer than MIN_SAMPLES feedback events, the
 *     weights stay at 1.0 and the system behaves identically to the static
 *     ranker. No bootstrap surprises.
 *   - Pure module: the math lives here as `recomputeWeights`; persistence is
 *     the caller's problem (ContextStore stores them in globalState).
 *
 * What "signal" means: a numeric value the ranker uses (keyword score,
 * recency-derived freshness, decayed confidence, reinforcement counters,
 * accept/reject feedback ratio). For each signal we keep:
 *   - the running average value of that signal across ACCEPTED sessions
 *   - the running average value across REJECTED sessions
 * If accepted >> rejected for a given signal, the signal is meaningful and
 * we increase its weight. Vice-versa.
 *
 * Why averages instead of full regression? Two reasons:
 *   1. Sessions get bursty feedback — a tiny rejection sample can swing a
 *      regression wildly. Averages are noisier-to-converge but harder to
 *      destabilise.
 *   2. The math runs in the extension host on every accept/reject. We need
 *      O(1) work per event. Averages give that; regression doesn't.
 */

/** Names of the signals we track and adapt. Order must stay stable. */
export type SignalName = 'keyword' | 'recency' | 'confidence' | 'reinforcement' | 'feedback';

export const SIGNALS: SignalName[] = [
  'keyword',
  'recency',
  'confidence',
  'reinforcement',
  'feedback',
];

/** Hard bounds on each learned multiplier — never less than 0.75 or more than 1.25 of default. */
export const MIN_WEIGHT = 0.75;
export const MAX_WEIGHT = 1.25;

/** Per-round adjustment cap (5%). Combined with MIN_SAMPLES this keeps drift slow. */
export const MAX_STEP = 0.05;

/** Minimum feedback events before learning kicks in. */
export const MIN_SAMPLES = 10;

/** Identity weights — the system behaves like the static ranker when these are returned. */
export function defaultWeights(): Record<SignalName, number> {
  const out: Record<SignalName, number> = {} as any;
  for (const s of SIGNALS) out[s] = 1.0;
  return out;
}

/**
 * A single recorded outcome: the per-signal values seen at retrieval time
 * and the feedback direction. `feedback = +1` for accepted, `-1` for rejected.
 *
 * We deliberately do NOT store the session ID — telemetry is fully aggregated
 * once recorded, so even an attacker reading the learned state cannot reverse
 * it back into "you found these specific sessions useful".
 */
export interface FeedbackSample {
  values: Record<SignalName, number>;
  feedback: 1 | -1;
}

/** Persisted shape kept in globalState. */
export interface AdaptiveWeightsState {
  weights: Record<SignalName, number>;
  /** Running tallies, used by `recomputeWeights` to derive new multipliers. */
  acceptedSum: Record<SignalName, number>;
  rejectedSum: Record<SignalName, number>;
  acceptedCount: number;
  rejectedCount: number;
  lastUpdatedAt: number;
}

/** Build a fresh, neutral state. */
export function emptyState(): AdaptiveWeightsState {
  const zeros: Record<SignalName, number> = {} as any;
  for (const s of SIGNALS) zeros[s] = 0;
  return {
    weights: defaultWeights(),
    acceptedSum: { ...zeros },
    rejectedSum: { ...zeros },
    acceptedCount: 0,
    rejectedCount: 0,
    lastUpdatedAt: 0,
  };
}

/** Add one feedback sample to the tallies in place. */
export function recordSample(state: AdaptiveWeightsState, sample: FeedbackSample): void {
  const bucket = sample.feedback === 1 ? state.acceptedSum : state.rejectedSum;
  for (const s of SIGNALS) bucket[s] += sample.values[s] ?? 0;
  if (sample.feedback === 1) state.acceptedCount += 1;
  else state.rejectedCount += 1;
}

/**
 * Recompute the weight multipliers from the running tallies.
 *
 * Strategy: for each signal, compare its average value across accepted
 * sessions to its average across rejected sessions. If accepted >>
 * rejected, the signal is doing its job — bump its weight by up to
 * MAX_STEP. If rejected >> accepted, cut its weight by up to MAX_STEP.
 * If totals are below MIN_SAMPLES, keep defaults.
 *
 * Returns a fresh weights object; does not mutate `state`.
 */
export function recomputeWeights(state: AdaptiveWeightsState): Record<SignalName, number> {
  const total = state.acceptedCount + state.rejectedCount;
  if (total < MIN_SAMPLES) return defaultWeights();

  // Need at least one of each to compute a meaningful delta.
  if (state.acceptedCount === 0 || state.rejectedCount === 0) return defaultWeights();

  const next: Record<SignalName, number> = { ...state.weights };
  for (const s of SIGNALS) {
    const acceptedAvg = state.acceptedSum[s] / state.acceptedCount;
    const rejectedAvg = state.rejectedSum[s] / state.rejectedCount;
    // Delta normalised by max absolute average so different-scale signals
    // (e.g. tiny RRF rrf-scores vs integer reinforcement counts) move at
    // comparable per-round speeds.
    const maxAbs = Math.max(Math.abs(acceptedAvg), Math.abs(rejectedAvg), 0.001);
    const delta = (acceptedAvg - rejectedAvg) / maxAbs; // ∈ [-1, +1]
    const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, delta * MAX_STEP));
    const proposed = (next[s] ?? 1.0) + step;
    next[s] = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, proposed));
  }
  return next;
}

/**
 * Merge a freshly-recomputed weights map into the state, stamping the
 * lastUpdatedAt timestamp. Pure helper to keep persistence-vs-math
 * boundaries clean for tests.
 */
export function applyRecomputedWeights(
  state: AdaptiveWeightsState,
  weights: Record<SignalName, number>,
): AdaptiveWeightsState {
  return {
    ...state,
    weights,
    lastUpdatedAt: Date.now(),
  };
}
