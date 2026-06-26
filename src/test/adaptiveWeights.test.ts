import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_WEIGHT,
  MIN_SAMPLES,
  MIN_WEIGHT,
  SIGNALS,
  SignalName,
  applyRecomputedWeights,
  defaultWeights,
  emptyState,
  recomputeWeights,
  recordSample,
} from '../adaptiveWeights';

function signalValues(values: Partial<Record<SignalName, number>>): Record<SignalName, number> {
  const out: Record<SignalName, number> = {} as any;
  for (const s of SIGNALS) out[s] = values[s] ?? 0;
  return out;
}

test('defaultWeights — every named signal starts at 1.0', () => {
  const w = defaultWeights();
  for (const s of SIGNALS) assert.equal(w[s], 1.0);
});

test('recordSample — accepted vs rejected accumulate into separate buckets', () => {
  const st = emptyState();
  recordSample(st, { values: signalValues({ keyword: 0.5 }), feedback: 1 });
  recordSample(st, { values: signalValues({ keyword: 0.1 }), feedback: -1 });
  assert.equal(st.acceptedCount, 1);
  assert.equal(st.rejectedCount, 1);
  assert.equal(st.acceptedSum.keyword, 0.5);
  assert.equal(st.rejectedSum.keyword, 0.1);
});

test('recomputeWeights — under MIN_SAMPLES the system stays at defaults', () => {
  const st = emptyState();
  // Only a handful of feedback events.
  for (let i = 0; i < Math.max(0, MIN_SAMPLES - 1); i++) {
    recordSample(st, { values: signalValues({ keyword: 1 }), feedback: 1 });
  }
  assert.deepEqual(recomputeWeights(st), defaultWeights());
});

test('recomputeWeights — when only one feedback class observed, returns defaults', () => {
  const st = emptyState();
  for (let i = 0; i < MIN_SAMPLES; i++) {
    recordSample(st, { values: signalValues({ keyword: 1 }), feedback: 1 });
  }
  // No rejections — recompute must stay at default to avoid runaway learning.
  assert.deepEqual(recomputeWeights(st), defaultWeights());
});

test('recomputeWeights — accept events on a signal boost its weight above 1.0', () => {
  const st = emptyState();
  // Strong positive signal for "keyword", neutral for everything else.
  for (let i = 0; i < 6; i++) {
    recordSample(st, { values: signalValues({ keyword: 1 }), feedback: 1 });
  }
  for (let i = 0; i < 6; i++) {
    recordSample(st, { values: signalValues({ keyword: 0 }), feedback: -1 });
  }
  const w = recomputeWeights(st);
  assert.ok(w.keyword > 1.0, `expected keyword weight > 1.0, got ${w.keyword}`);
});

test('recomputeWeights — reject events on a signal decrease its weight below 1.0', () => {
  const st = emptyState();
  // Rejected samples consistently carry a high "keyword" value: signal is misleading.
  for (let i = 0; i < 6; i++) {
    recordSample(st, { values: signalValues({ keyword: 0 }), feedback: 1 });
  }
  for (let i = 0; i < 6; i++) {
    recordSample(st, { values: signalValues({ keyword: 1 }), feedback: -1 });
  }
  const w = recomputeWeights(st);
  assert.ok(w.keyword < 1.0, `expected keyword weight < 1.0, got ${w.keyword}`);
});

test('recomputeWeights — every weight stays clamped within [MIN_WEIGHT, MAX_WEIGHT]', () => {
  const st = emptyState();
  // Extreme one-sided sample to try to break the clamp.
  for (let i = 0; i < 100; i++) {
    recordSample(st, { values: signalValues({ keyword: 1000 }), feedback: 1 });
    recordSample(st, { values: signalValues({ keyword: 0 }), feedback: -1 });
  }
  const w = recomputeWeights(st);
  for (const s of SIGNALS) {
    assert.ok(w[s] >= MIN_WEIGHT, `${s} below MIN_WEIGHT: ${w[s]}`);
    assert.ok(w[s] <= MAX_WEIGHT, `${s} above MAX_WEIGHT: ${w[s]}`);
  }
});

test('applyRecomputedWeights — returns a new state with stamped lastUpdatedAt', () => {
  const st = emptyState();
  const newWeights = { ...defaultWeights(), keyword: 1.2 };
  const next = applyRecomputedWeights(st, newWeights);
  assert.equal(next.weights.keyword, 1.2);
  assert.ok(next.lastUpdatedAt > 0);
  // Original state is not mutated.
  assert.equal(st.weights.keyword, 1.0);
});
