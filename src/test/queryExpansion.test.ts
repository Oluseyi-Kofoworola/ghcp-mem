import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandQuery, InvertedIndex } from '../queryExpansion';

function makeIndex(entries: Record<string, string[]>): InvertedIndex {
  const idx: InvertedIndex = new Map();
  for (const [term, ids] of Object.entries(entries)) idx.set(term, new Set(ids));
  return idx;
}

test('expandQuery — empty query / empty index returns []', () => {
  assert.deepEqual(expandQuery(new Set(), new Map(), 5), []);
  assert.deepEqual(expandQuery(new Set(['x']), new Map(), 5), []);
  assert.deepEqual(expandQuery(new Set(['x']), makeIndex({ x: ['s1'] }), 0), []);
});

test('expandQuery — co-occurring terms in 2+ seed sessions become expansions', () => {
  // 3 sessions about postgres+pool+connection, plus 7 unrelated. Total = 10 so
  // pool (3/10 = 0.3) sits below the maxGlobalFrequency floor (default 0.5)
  // and survives. The query "postgres" surfaces pool + connection.
  const idx = makeIndex({
    postgres: ['s1', 's2', 's3'],
    pool: ['s1', 's2', 's3'],
    connection: ['s1', 's2', 's3'],
    unrelated: ['s4', 's5', 's6', 's7'],
  });
  const out = expandQuery(new Set(['postgres']), idx, 10);
  assert.ok(out.includes('pool'));
  assert.ok(out.includes('connection'));
  assert.ok(!out.includes('unrelated'));
  assert.ok(!out.includes('postgres'));
});

test('expandQuery — maxGlobalFrequency stopword filter excludes overly common terms', () => {
  // "the" appears in 4 of 4 sessions — 100% > 50% cap, so it must NOT be returned.
  const idx = makeIndex({
    auth: ['s1', 's2'],
    bcrypt: ['s1', 's2'],
    the: ['s1', 's2', 's3', 's4'],
    and: ['s1', 's2', 's3', 's4'],
    salt: ['s1', 's2'],
  });
  const out = expandQuery(new Set(['auth']), idx, 4);
  assert.ok(!out.includes('the'));
  assert.ok(!out.includes('and'));
  assert.ok(out.includes('bcrypt') || out.includes('salt'));
});

test('expandQuery — only-one-seed-session softens minCoOccurrence to 1', () => {
  const idx = makeIndex({
    postgres: ['s1'],
    pool: ['s1'],
    timeout: ['s1'],
    other: ['s2'],
  });
  const out = expandQuery(new Set(['postgres']), idx, 2);
  // With softened threshold of 1, terms co-occurring in the single seed should win.
  assert.ok(out.includes('pool'));
  assert.ok(out.includes('timeout'));
});

test('expandQuery — respects maxExpansions cap', () => {
  const idx = makeIndex({
    seed: ['s1', 's2'],
    a: ['s1', 's2'],
    b: ['s1', 's2'],
    c: ['s1', 's2'],
    d: ['s1', 's2'],
  });
  const out = expandQuery(new Set(['seed']), idx, 5, { maxExpansions: 2 });
  assert.equal(out.length, 2);
});

test('expandQuery — terms already in the query are never re-emitted', () => {
  const idx = makeIndex({
    auth: ['s1', 's2'],
    bcrypt: ['s1', 's2'],
  });
  const out = expandQuery(new Set(['auth', 'bcrypt']), idx, 2);
  assert.ok(!out.includes('auth'));
  assert.ok(!out.includes('bcrypt'));
});

test('expandQuery — terms below minCoOccurrence threshold are excluded', () => {
  // "tangential" only appears in one of the 3 seed sessions — below the
  // default min of 2. Use 10 total sessions so core/seed pass the global-
  // frequency cap (otherwise 3/4 = 0.75 > 0.5 would also exclude them).
  const idx = makeIndex({
    seed: ['s1', 's2', 's3'],
    core: ['s1', 's2', 's3'],
    tangential: ['s1'],
  });
  const out = expandQuery(new Set(['seed']), idx, 10);
  assert.ok(out.includes('core'));
  assert.ok(!out.includes('tangential'));
});
