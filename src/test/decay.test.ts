import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECAY_HALF_LIFE_MS,
  MAX_DECAY_HAIRCUT,
  effectiveConfidence,
  lastInteractionTimestamp,
} from '../decay';
import { CompressedSession } from '../types';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: 'sess',
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: 0,
    endTime: 0,
    summary: '',
    observationType: 'feature',
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
    ...overrides,
  };
}

test('effectiveConfidence — undefined when no stored confidence', () => {
  const s = makeSession({ endTime: 1_000_000 });
  assert.equal(effectiveConfidence(s, 1_000_000), undefined);
});

test('effectiveConfidence — at t=0 (no elapsed time) returns full confidence', () => {
  const s = makeSession({ confidence: 0.8, endTime: 1_000_000 });
  const eff = effectiveConfidence(s, 1_000_000);
  assert.ok(Math.abs(eff! - 0.8) < 1e-9, `expected 0.8, got ${eff}`);
});

test('effectiveConfidence — at 60d half-life, haircut is ~half of MAX', () => {
  const s = makeSession({ confidence: 1.0, endTime: 0 });
  const eff = effectiveConfidence(s, DECAY_HALF_LIFE_MS);
  // 1 - 2^(-1) = 0.5, multiplied by MAX_DECAY_HAIRCUT = 0.15.
  // So effective = 1 * (1 - 0.15) = 0.85.
  const expected = 1 - 0.5 * MAX_DECAY_HAIRCUT;
  assert.ok(Math.abs(eff! - expected) < 1e-6, `expected ${expected}, got ${eff}`);
});

test('effectiveConfidence — haircut is capped at 30%, even at extreme age', () => {
  const s = makeSession({ confidence: 1.0, endTime: 0 });
  // 10 half-lives — decay curve is essentially saturated at the cap.
  const eff = effectiveConfidence(s, 10 * DECAY_HALF_LIFE_MS);
  const minFloor = 1 - MAX_DECAY_HAIRCUT; // 0.7
  assert.ok(eff! >= minFloor - 1e-9, `expected >= ${minFloor}, got ${eff}`);
  assert.ok(eff! <= minFloor + 0.01, `expected ≈ ${minFloor}, got ${eff}`);
});

test('effectiveConfidence — recent retrieval resets the decay clock', () => {
  const now = 5 * DECAY_HALF_LIFE_MS;
  const stale = makeSession({ confidence: 1.0, endTime: 0 });
  const refreshed = makeSession({
    confidence: 1.0,
    endTime: 0,
    usage: { retrieved: 1, accepted: 0, rejected: 0, lastRetrievedAt: now - 1000 },
  });
  const staleEff = effectiveConfidence(stale, now)!;
  const freshEff = effectiveConfidence(refreshed, now)!;
  assert.ok(freshEff > staleEff, `refreshed (${freshEff}) should beat stale (${staleEff})`);
  // Refreshed: tiny elapsed time → effective confidence very close to 1.0.
  assert.ok(freshEff > 0.999);
});

test('lastInteractionTimestamp — picks the most recent of end/retrieved/interaction', () => {
  const s = makeSession({
    endTime: 100,
    usage: {
      retrieved: 1,
      accepted: 0,
      rejected: 0,
      lastRetrievedAt: 200,
      lastInteractionAt: 300,
    },
  });
  assert.equal(lastInteractionTimestamp(s), 300);
});

test('effectiveConfidence — output clamped to [0,1]', () => {
  // Synthetic case: stored confidence > 1 (legacy data) should still be clamped.
  const s = makeSession({ confidence: 1.5 as number, endTime: 0 });
  const eff = effectiveConfidence(s, DECAY_HALF_LIFE_MS);
  assert.ok(eff! <= 1);
  assert.ok(eff! >= 0);
});
