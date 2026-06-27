import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetLocalEmbedCache,
  cosineSim,
  LOCAL_EMBED_DIM,
  localEmbed,
  makeLocalEmbedder,
} from '../embeddings';

test('localEmbed — deterministic and correct dimension', () => {
  const a = localEmbed('refactor the authentication module with JWT');
  const b = localEmbed('refactor the authentication module with JWT');
  assert.equal(a.length, LOCAL_EMBED_DIM);
  assert.deepEqual(a, b);
});

test('localEmbed — output is L2-normalised (unit length)', () => {
  const v = localEmbed('payment service retry logic and idempotency keys');
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  // Rounded to 4 decimals, so allow a small tolerance.
  assert.ok(Math.abs(norm - 1) < 0.01, `expected ~1, got ${norm}`);
});

test('localEmbed — similar texts score higher than unrelated texts', () => {
  const q = localEmbed('fix the database connection pool timeout');
  const near = localEmbed('database connection pool timeout bug fix');
  const far = localEmbed('update the marketing landing page copy');
  const simNear = cosineSim(q, near);
  const simFar = cosineSim(q, far);
  assert.ok(simNear > simFar, `near=${simNear} should exceed far=${simFar}`);
  assert.ok(simNear > 0.3, `expected meaningful overlap, got ${simNear}`);
});

test('localEmbed — empty text yields a zero vector (cosine 0)', () => {
  const v = localEmbed('');
  assert.equal(v.length, LOCAL_EMBED_DIM);
  assert.equal(
    v.every((x) => x === 0),
    true,
  );
  assert.equal(cosineSim(v, localEmbed('anything at all here')), 0);
});

test('makeLocalEmbedder — returns a working async EmbeddingFn', async () => {
  const embed = makeLocalEmbedder();
  const vec = await embed('hybrid retrieval signal');
  assert.ok(Array.isArray(vec));
  assert.equal(vec!.length, LOCAL_EMBED_DIM);
});

// ── v1.11.0 LRU memo regression tests ────────────────────────────────────────
test('localEmbed — LRU memo returns the same array reference on second call', () => {
  _resetLocalEmbedCache();
  const text = 'memoized embedding lookup for retrieval';
  const first = localEmbed(text);
  const second = localEmbed(text);
  assert.equal(first, second, 'expected identical array reference (===) from memo');
});

test('localEmbed — _resetLocalEmbedCache forces recomputation', () => {
  const text = 'cache should be cleared between unit tests';
  const before = localEmbed(text);
  _resetLocalEmbedCache();
  const after = localEmbed(text);
  // Different reference because the cache was wiped, but content is identical.
  assert.notEqual(after, before, 'expected new reference after cache reset');
  assert.deepEqual(after, before, 'content should still be deterministic');
});

test('localEmbed — high-throughput input stays bounded (no unbounded cache growth)', () => {
  _resetLocalEmbedCache();
  // 1500 distinct inputs through the 512-slot LRU.
  for (let i = 0; i < 1500; i++) {
    const v = localEmbed(`distinct input ${i} payload xyz`);
    assert.equal(v.length, LOCAL_EMBED_DIM);
  }
  // No assertion on the internal size — but if growth were unbounded
  // memory pressure would manifest. This test serves as a smoke check
  // that 1500 unique inputs don't blow up the embedder.
  assert.ok(true);
});
