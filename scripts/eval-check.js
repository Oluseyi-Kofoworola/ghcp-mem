#!/usr/bin/env node
/**
 * Eval regression gate.
 *
 * Seeds a deterministic synthetic corpus into an in-memory ContextStore,
 * builds self-queries (the same way the in-extension eval command does),
 * then asserts recall@5 / MRR / nDCG@5 meet the floor in
 * scripts/eval-baseline.json (within tolerancePct slack).
 *
 * Designed to fail CI if a ranker change silently regresses retrieval.
 *
 * Optional: pass `--gold <path>` to use a hand-curated gold corpus file
 * (see scripts/eval-gold.json for the schema). The gate then evaluates
 * against the gold set instead of synthetic self-queries.
 *
 * Usage:
 *   node scripts/eval-check.js
 *   node scripts/eval-check.js --gold scripts/eval-gold.json
 */
const path = require('path');
const fs = require('fs');

const baseline = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'eval-baseline.json'), 'utf8'));
const tolerance = (baseline.tolerancePct ?? 5) / 100;

const { ContextStore } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'contextStore.js'),
);
const { computeContentHash } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'types.js'),
);
const { runEvalSuite, runGoldEval } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'eval.js'),
);
const { InMemoryMemento } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'test', '__mocks__', 'vscode.js'),
);

// Optional --gold <path> flag for hand-curated corpus mode.
const goldFlagIdx = process.argv.indexOf('--gold');
const goldPath = goldFlagIdx !== -1 ? process.argv[goldFlagIdx + 1] : undefined;

// Deterministic seed corpus: 12 sessions with distinct topics so each query
// has exactly one "relevant" session — keyword search must rank it first.
const CORPUS = [
  {
    topic: 'reciprocal-rank-fusion',
    file: 'contextStore.ts',
    summary: 'Implemented RRF k=60 ranker for hybrid keyword+recency',
  },
  {
    topic: 'azure-storage-connection-string',
    file: 'redactor.ts',
    summary: 'Added Azure storage conn string redaction rule',
  },
  {
    topic: 'jwt-bearer-token-redaction',
    file: 'redactor.ts',
    summary: 'JWT and Bearer token redaction patterns',
  },
  {
    topic: 'mcp-stdio-server',
    file: 'mcpServer.ts',
    summary: 'Implemented stdio MCP server with 4 tools',
  },
  {
    topic: 'session-tree-pinned-tier',
    file: 'sessionsView.ts',
    summary: 'Added pinned tier above date groups in tree view',
  },
  {
    topic: 'walkthrough-onboarding',
    file: 'package.json',
    summary: 'Added VS Code walkthroughs contribution for first-run UX',
  },
  {
    topic: 'github-compatible-mode',
    file: 'types.ts',
    summary: 'Mirror Copilot 28-day retention and repo scoping',
  },
  {
    topic: 'repo-scope-mtime-invalidation',
    file: 'repoScope.ts',
    summary: 'Cache invalidated by .git/config mtime',
  },
  {
    topic: 'markdown-export-diff-friendly',
    file: 'markdownExport.ts',
    summary: 'Diff-friendly session markdown export',
  },
  {
    topic: 'inverted-index-search',
    file: 'contextStore.ts',
    summary: 'Inverted index over tokens for O(1) candidate retrieval',
  },
  {
    topic: 'embedding-cosine-similarity',
    file: 'embeddings.ts',
    summary: 'Cosine sim over local embeddings as RRF input',
  },
  {
    topic: 'health-score-redaction-coverage',
    file: 'health.ts',
    summary: 'Memory health score with redaction coverage and retention headroom',
  },
];

(async () => {
  const mem = new InMemoryMemento();
  const store = new ContextStore(mem);

  for (let i = 0; i < CORPUS.length; i++) {
    const c = CORPUS[i];
    const session = {
      id: `eval-${i.toString().padStart(4, '0')}`,
      workspaceId: 'ws',
      workspaceName: 'ws',
      startTime: Date.now() - (CORPUS.length - i) * 60_000,
      endTime: Date.now() - (CORPUS.length - i) * 60_000 + 1000,
      summary: c.summary,
      observationType: 'feature',
      keyFiles: [`src/${c.file}`],
      keyTopics: [c.topic],
      decisions: [],
      problemsSolved: [],
      rawEventCount: 5,
      userTags: [],
      redactionCount: 0,
      contentHash: computeContentHash({
        summary: c.summary,
        keyFiles: [`src/${c.file}`],
        keyTopics: [c.topic],
        decisions: [],
        problemsSolved: [],
      }),
    };
    store.db.sessions.push(session);
  }
  await store.rebuildIndexAsync();

  const report = goldPath
    ? await runGoldEval(store, JSON.parse(fs.readFileSync(path.resolve(goldPath), 'utf8')).queries)
    : await runEvalSuite(store);
  if (!report.runs.length) {
    console.error('FAIL: eval produced no runs');
    process.exit(1);
  }

  let failed = false;
  for (const run of report.runs) {
    const floor = baseline.floors[run.label];
    if (!floor) {
      console.log(`  (no baseline for "${run.label}", skipping)`);
      continue;
    }
    const recallMin = floor.recall * (1 - tolerance);
    const mrrMin = floor.mrr * (1 - tolerance);
    const ndcgMin = (floor.ndcg ?? 0) * (1 - tolerance);
    const recallOk = run.recall >= recallMin;
    const mrrOk = run.mrr >= mrrMin;
    const ndcgOk = floor.ndcg === undefined || run.ndcg >= ndcgMin;
    const ok = recallOk && mrrOk && ndcgOk;
    const tag = ok ? 'OK  ' : 'FAIL';
    console.log(
      `  [${tag}] ${run.label}: recall@${run.k}=${run.recall.toFixed(3)} (floor ${recallMin.toFixed(3)}) · MRR=${run.mrr.toFixed(3)} (floor ${mrrMin.toFixed(3)}) · nDCG@${run.k}=${run.ndcg.toFixed(3)}${floor.ndcg !== undefined ? ` (floor ${ndcgMin.toFixed(3)})` : ''}`,
    );
    if (!ok) failed = true;
  }
  if (failed) {
    console.error(
      'Eval regression detected. Investigate ranker changes or update scripts/eval-baseline.json after deliberate improvements.',
    );
    process.exit(1);
  }
  console.log('Eval gate passed.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
