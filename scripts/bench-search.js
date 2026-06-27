#!/usr/bin/env node
/**
 * Search-latency micro-benchmark.
 *
 * Seeds N synthetic compressed sessions into an in-memory ContextStore, then
 * runs M queries and reports p50/p95/p99 latency.
 *
 * Run after compiling tests:
 *   npm run typecheck && tsc -p ./tsconfig.test.json && node scripts/setup-test-env.js
 *   node scripts/bench-search.js [sessions=1000] [queries=200]
 *
 * Designed to catch search-path perf regressions (e.g. accidentally O(N²)
 * filter loops, blown-out RRF maps, etc.).
 */
const path = require('path');
const N = parseInt(process.argv[2], 10) || 1000;
const Q = parseInt(process.argv[3], 10) || 200;

// Resolve the compiled mock vscode module that `out-test/setup-test-env.js`
// planted in out-test/node_modules/vscode.
require('module').Module._initPaths();
process.env.NODE_PATH = path.resolve(__dirname, '..', 'out-test', 'node_modules');
require('module').Module._initPaths();

const { ContextStore } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'contextStore.js'),
);
const { computeContentHash } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'types.js'),
);
const { InMemoryMemento } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'test', '__mocks__', 'vscode.js'),
);

const TOPICS = [
  'auth',
  'azure',
  'refactor',
  'redis',
  'cache',
  'mcp',
  'embedding',
  'rrf',
  'sidebar',
  'walkthrough',
  'redaction',
  'health',
];
const TYPES = ['feature', 'bugfix', 'refactor', 'docs', 'config', 'experiment'];

function randInt(n) {
  return Math.floor(Math.random() * n);
}
function pick(arr) {
  return arr[randInt(arr.length)];
}

function makeSession(i) {
  const topics = [pick(TOPICS), pick(TOPICS)];
  const summary = `session ${i} ${pick(TOPICS)} ${pick(TOPICS)} ${pick(TYPES)} ${i}`;
  const keyFiles = [`src/${pick(TOPICS)}.ts`, `src/${pick(TOPICS)}.ts`];
  const decisions = i % 4 === 0 ? [`decision-${i}`] : [];
  return {
    id: `bench-${i.toString().padStart(8, '0')}`,
    workspaceId: `ws-${i % 5}`,
    workspaceName: `ws${i % 5}`,
    startTime: Date.now() - i * 60_000,
    endTime: Date.now() - i * 60_000 + 1000,
    summary,
    observationType: pick(TYPES),
    keyFiles,
    keyTopics: topics,
    decisions,
    problemsSolved: [],
    rawEventCount: 5,
    userTags: i % 7 === 0 ? ['pinned'] : [],
    redactionCount: 0,
    contentHash: computeContentHash({
      summary,
      keyFiles,
      keyTopics: topics,
      decisions,
      problemsSolved: [],
    }),
  };
}

(async () => {
  const mem = new InMemoryMemento();
  const store = new ContextStore(mem);

  console.log(`Seeding ${N} sessions…`);
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    // Bypass addSession's retention/persist path for speed — index directly.
    store.db.sessions.push(makeSession(i));
  }
  // Force-rebuild index after bulk push so search works.
  await store.rebuildIndexAsync();
  const seedMs = Date.now() - t0;
  console.log(`  seeded in ${seedMs} ms`);

  console.log(`Running ${Q} queries…`);
  const latencies = [];
  for (let i = 0; i < Q; i++) {
    const q = `${pick(TOPICS)} ${pick(TOPICS)}`;
    const t = process.hrtime.bigint();
    const r = store.search(q, {}, 10);
    const us = Number(process.hrtime.bigint() - t) / 1000;
    latencies.push(us);
    if (!Array.isArray(r)) throw new Error('search must return array');
  }
  latencies.sort((a, b) => a - b);
  const pct = (p) =>
    latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
  console.log(`  p50: ${pct(50).toFixed(0)} µs`);
  console.log(`  p95: ${pct(95).toFixed(0)} µs`);
  console.log(`  p99: ${pct(99).toFixed(0)} µs`);
  console.log(`  max: ${latencies[latencies.length - 1].toFixed(0)} µs`);

  // Hard ceiling: p95 should be well under 50 ms for 1000-session pool.
  const ceilingMs = 50;
  if (pct(95) / 1000 > ceilingMs) {
    console.error(`FAIL: p95 ${(pct(95) / 1000).toFixed(1)} ms exceeds ${ceilingMs} ms ceiling`);
    process.exit(1);
  }
  console.log('OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
