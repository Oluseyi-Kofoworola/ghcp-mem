/* eslint-disable no-console */
// End-to-end runtime smoke test (run with `node scripts/smoke.js`).
// Verifies that the compiled JS for the new modules actually loads and
// produces the expected behaviour against a real in-memory ContextStore.

const path = require('path');
const Module = require('module');

// Point any `require('vscode')` calls at the test mock that ships with the
// compiled test output. This lets us drive the real production modules
// (out/...) using the same fakes the unit suite uses.
const mockPath = path.resolve(__dirname, '..', 'out-test', 'src', 'test', '__mocks__', 'vscode.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return mockPath;
  return origResolve.call(this, request, ...rest);
};

const vscode = require(mockPath);
const { ContextStore } = require('../out-test/src/contextStore.js');
const {
  exportSessionMarkdown,
  exportSessionsMarkdown,
} = require('../out-test/src/markdownExport.js');
const { normalizeRemoteUrl } = require('../out-test/src/repoScope.js');
const { validateSession } = require('../out-test/src/validator.js');
const { runEvalSuite, formatEvalReport, buildSelfQueries } = require('../out-test/src/eval.js');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  } else {
    console.log('  ok:', msg);
  }
}

async function main() {
  console.log('=== smoke: repoScope.normalizeRemoteUrl ===');
  assert(
    normalizeRemoteUrl('git@github.com:foo/bar.git') === 'github.com/foo/bar',
    'ssh url normalized',
  );
  assert(
    normalizeRemoteUrl('https://github.com/foo/bar.git') === 'github.com/foo/bar',
    'https url normalized',
  );
  assert(normalizeRemoteUrl('') === '', 'empty handled');

  console.log('=== smoke: validator (no workspace -> freshness 1) ===');
  vscode.workspace.workspaceFolders = undefined;
  const session = {
    id: 'abc',
    workspaceId: 'ws',
    workspaceName: 'demo',
    startTime: Date.now() - 60_000,
    endTime: Date.now(),
    summary: 'demo session',
    observationType: 'feature',
    keyFiles: ['src/extension.ts', 'src/missing.ts'],
    keyTopics: ['retrieval'],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 1,
    userTags: [],
    redactionCount: 0,
  };
  const v = await validateSession(session);
  assert(typeof v.freshness === 'number', 'freshness is numeric');
  assert(v.freshness >= 0 && v.freshness <= 1, 'freshness in [0,1]');

  console.log('=== smoke: markdownExport determinism ===');
  const md1 = exportSessionMarkdown(session);
  const md2 = exportSessionMarkdown(session);
  assert(md1 === md2, 'markdown output is byte-identical across calls');
  assert(md1.includes('demo session'), 'markdown includes summary');
  assert(md1.includes('src/extension.ts'), 'markdown lists keyFile');

  const bulk = exportSessionsMarkdown([session, { ...session, id: 'def', summary: 'second' }]);
  assert(
    bulk.includes('demo session') && bulk.includes('second'),
    'bulk export contains both sessions',
  );

  console.log('=== smoke: ContextStore + eval suite ===');
  const memento = new vscode.InMemoryMemento();
  const storage = vscode.Uri.file('/tmp/ghcp-smoke');
  const store = new ContextStore(memento, storage);
  for (let i = 0; i < 5; i++) {
    await store.addSession({
      ...session,
      id: `s${i}`,
      summary: `Session ${i} discussing topic ${i}`,
      keyTopics: [`topic-marker-${i}`],
    });
  }
  assert(store.getAllSessions().length === 5, '5 sessions stored');

  const queries = buildSelfQueries(store.getAllSessions());
  assert(queries.length === 5, '5 self-queries derived');

  const report = await runEvalSuite(store);
  assert(report.runs.length === 3, 'eval ran all 3 configurations');
  for (const run of report.runs) {
    assert(run.recall >= 0 && run.recall <= 1, `${run.label} recall in range`);
    assert(run.mrr >= 0 && run.mrr <= 1, `${run.label} mrr in range`);
  }
  const reportMd = formatEvalReport(report);
  assert(reportMd.includes('Recall@k'), 'report markdown rendered');

  console.log('\nSMOKE OK');
}

main().catch((e) => {
  console.error('SMOKE CRASHED:', e);
  process.exit(2);
});
