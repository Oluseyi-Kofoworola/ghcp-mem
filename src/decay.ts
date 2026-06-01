/**
 * Time-based confidence decay.
 *
 * A session's stored `confidence` is set once at compression time and never
 * changes. But trust naturally erodes with time: a 6-month-old decision that
 * nobody has cited, accepted, or re-verified is materially less reliable
 * than a freshly captured one, even if both were originally well-grounded.
 *
 * This module provides `effectiveConfidence(session, now)` — a *display and
 * ranking* value derived from the stored confidence, the last interaction
 * timestamp, and the entity's age. Original confidence is preserved on disk
 * so we never destroy provenance; decay is recomputed on demand.
 *
 * Properties (verified by tests):
 *   - Pure function — no side effects, deterministic given a fixed `now`.
 *   - Bounded haircut: at most 30% reduction from the stored confidence.
 *   - Half-life of 60 days (configurable inline) — typical decision lifetimes
 *     in software projects span quarters, not days.
 *   - Activity boost: any explicit accept/recent retrieval resets the
 *     decay clock so memories the developer keeps using stay sharp.
 *   - Legacy safety: sessions without a confidence field return undefined
 *     rather than guessing — callers can treat as the neutral 0.5.
 */

import { CompressedSession } from './types';

/** Maximum fraction of the stored confidence we'll erase via decay. */
export const MAX_DECAY_HAIRCUT = 0.3;

/** Half-life of the decay curve (ms). */
export const DECAY_HALF_LIFE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

/**
 * Compute the time-decayed confidence for a session.
 *
 * Returns `undefined` when the session has no stored confidence — legacy
 * sessions skip decay entirely. Otherwise returns
 * `confidence * (1 - haircut)` where the haircut grows with the time
 * since the session was last meaningfully interacted with.
 *
 * "Last interaction" is the max of:
 *   - endTime (capture time)
 *   - usage.lastRetrievedAt
 *   - usage.lastInteractionAt (set by accept/reject)
 */
export function effectiveConfidence(
  s: CompressedSession,
  now: number = Date.now(),
): number | undefined {
  if (typeof s.confidence !== 'number') return undefined;
  const last = lastInteractionTimestamp(s);
  const ageMs = Math.max(0, now - last);
  // 1 - 2^(-age/halfLife) grows from 0 toward 1 with age; cap at MAX.
  const rawDecay = 1 - Math.pow(2, -ageMs / DECAY_HALF_LIFE_MS);
  const haircut = Math.min(MAX_DECAY_HAIRCUT, rawDecay * MAX_DECAY_HAIRCUT);
  const out = s.confidence * (1 - haircut);
  // Clamp to [0, 1] — confidence can never go negative.
  return Math.max(0, Math.min(1, out));
}

/**
 * Determine the most recent timestamp at which a session was meaningfully
 * touched: capture-time, retrieval, or explicit accept/reject feedback.
 * Pure helper, exposed for tests.
 */
export function lastInteractionTimestamp(s: CompressedSession): number {
  let last = s.endTime || 0;
  const u = s.usage;
  if (u?.lastRetrievedAt && u.lastRetrievedAt > last) last = u.lastRetrievedAt;
  if (u?.lastInteractionAt && u.lastInteractionAt > last) last = u.lastInteractionAt;
  return last;
}
