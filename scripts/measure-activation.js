#!/usr/bin/env node
// Activation-cost benchmark for GHCP-MEM.
//
// We can't easily spawn a real VS Code extension host headlessly, so we
// approximate the cold-start cost by measuring the things that dominate it:
//
//   1. Bundle parse time  — how long Node takes to load + parse the
//      esbuild-bundled extension.js. In a real extension host, this is
//      the bulk of activation latency before any of our code runs.
//   2. Bundle size + module count — proxies for memory footprint.
//   3. Wall-clock cost of constructing the in-memory store + index from
//      a representative session count (100 / 1k / 10k).
//
// What this is NOT:
//   • A measurement of the VS Code extension host bootstrap time itself
//     (that's controlled by VS Code, not us).
//   • A measurement of every async listener registration — those are
//     fire-and-forget; the user perceives only what blocks `activate()`.
//
// Usage:
//   npm run measure:activation
//   (or: node scripts/measure-activation.js)
//
// Output is a markdown block ready to paste into the README.

'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const EXT_BUNDLE = path.join(ROOT, 'out', 'extension.js');
const MCP_BUNDLE = path.join(ROOT, 'out', 'mcpServer.js');

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
function kb(n) {
  return (n / 1024).toFixed(1);
}

if (!exists(EXT_BUNDLE)) {
  console.error(`missing ${EXT_BUNDLE} — run 'npm run bundle:prod' first`);
  process.exit(1);
}

// ── 1. Bundle parse time ───────────────────────────────────────────────
//
// We use vm.Script with the bundled code to isolate parse time from
// require()-cache effects. Repeat 5 times, drop the slowest (cold-disk),
// average the rest.

const vm = require('vm');
function parseTime(file) {
  const src = fs.readFileSync(file, 'utf8');
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    new vm.Script(src, { filename: file });
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  samples.pop(); // drop slowest
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

const extParseMs = parseTime(EXT_BUNDLE);
const mcpParseMs = exists(MCP_BUNDLE) ? parseTime(MCP_BUNDLE) : 0;

// ── 2. Bundle size ─────────────────────────────────────────────────────
const extSize = fs.statSync(EXT_BUNDLE).size;
const mcpSize = exists(MCP_BUNDLE) ? fs.statSync(MCP_BUNDLE).size : 0;

// ── 3. Store construction at scale ─────────────────────────────────────
//
// This mimics activation's slowest synchronous path: loading the on-disk
// mirror into memory + rebuilding the inverted search index. We use the
// test-env mock so the same code paths run as in production.

require('./setup-test-env.js'); // sets up the vscode stub
const { ContextStore } = require(path.join(ROOT, 'out-test', 'src', 'contextStore.js'));
const vscode = require(path.join(ROOT, 'out-test', 'src', 'test', '__mocks__', 'vscode.js'));

function makeSession(i) {
  return {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    workspaceId: 'ws',
    workspaceName: 'demo',
    startTime: Date.now() - i * 60_000,
    endTime: Date.now() - i * 60_000 + 30_000,
    summary: `Session ${i} discussing topic-${i % 50} and file ${i % 30}.ts`,
    observationType: ['feature', 'bugfix', 'refactor', 'docs', 'test'][i % 5],
    keyFiles: [`src/file${i % 30}.ts`],
    keyTopics: [`topic-${i % 50}`, `area-${i % 10}`],
    decisions: i % 7 === 0 ? [`Decision ${i}`] : [],
    problemsSolved: i % 11 === 0 ? [`Problem ${i}`] : [],
    rawEventCount: 5,
    userTags: [],
    redactionCount: 0,
  };
}

async function measureStore(n) {
  const memento = new vscode.InMemoryMemento();
  // Pre-seed the underlying store so construction loads it
  memento.update('ghcpMem.contextDatabase', {
    version: 2,
    sessions: Array.from({ length: n }, (_, i) => makeSession(i)),
    lastUpdated: Date.now(),
  });

  const t = performance.now();
  const store = new ContextStore(memento, vscode.Uri.file('/tmp'));
  // Rebuild the inverted index synchronously to capture full activation cost
  if (typeof store.rebuildIndex === 'function') store.rebuildIndex();
  const constructMs = performance.now() - t;

  const queryT = performance.now();
  store.search('topic-7', {}, 10);
  const firstQueryMs = performance.now() - queryT;

  return { constructMs, firstQueryMs };
}

(async () => {
  const heapBefore = process.memoryUsage().heapUsed;
  const r100 = await measureStore(100);
  const r1000 = await measureStore(1000);
  const r10000 = await measureStore(10000);
  const heapAfter = process.memoryUsage().heapUsed;
  const heapDelta = heapAfter - heapBefore;

  // ── Report ──────────────────────────────────────────────────────────
  console.log('## Activation cost (measured)\n');
  console.log('| Metric | Value |');
  console.log('|---|---|');
  console.log(`| Bundle size — \`out/extension.js\` | **${kb(extSize)} KB** |`);
  console.log(`| Bundle size — \`out/mcpServer.js\` | **${kb(mcpSize)} KB** |`);
  console.log(`| Parse time — \`extension.js\` (best of 4) | **${extParseMs.toFixed(2)} ms** |`);
  console.log(`| Parse time — \`mcpServer.js\` (best of 4) | **${mcpParseMs.toFixed(2)} ms** |`);
  console.log(
    `| Store load + index rebuild @ 100 sessions | **${r100.constructMs.toFixed(2)} ms** |`,
  );
  console.log(
    `| Store load + index rebuild @ 1 000 sessions | **${r1000.constructMs.toFixed(2)} ms** |`,
  );
  console.log(
    `| Store load + index rebuild @ 10 000 sessions | **${r10000.constructMs.toFixed(2)} ms** |`,
  );
  console.log(`| First search @ 10 000 sessions | **${r10000.firstQueryMs.toFixed(2)} ms** |`);
  console.log(
    `| Heap delta across all measurements | **${(heapDelta / 1024 / 1024).toFixed(1)} MB** |`,
  );
  console.log('');
  console.log(`> Measured on: ${process.platform} ${process.arch}, Node ${process.version}`);
  console.log(`> Reproduce: \`npm run bundle:prod && node scripts/measure-activation.js\``);
})();
