import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { buildSelfQueries, formatEvalReport, runEvalSuite } from '../eval';
import { ContextStore } from '../contextStore';
import { CompressedSession } from '../types';
import * as vscode from 'vscode';

function makeSession(over: Partial<CompressedSession>): CompressedSession {
  return {
    id: over.id ?? 'x',
    workspaceId: 'ws',
    workspaceName: 'demo',
    startTime: Date.now() - 100_000,
    endTime: Date.now() - 50_000,
    summary: 'summary',
    observationType: 'feature',
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
    ...over,
  };
}

test('buildSelfQueries: derives query strings from session topics', () => {
  const sessions = [
    makeSession({ id: 'a', keyTopics: ['retrieval ranking via RRF fusion'] }),
    makeSession({ id: 'b', keyTopics: [], problemsSolved: ['memory health scoring algorithm'] }),
    makeSession({ id: 'c', keyTopics: [], decisions: ['use embeddings api when available'] }),
    makeSession({ id: 'd' /* no useful text */ }),
  ];
  const qs = buildSelfQueries(sessions);
  // Three sessions have something usable; the 4th has nothing.
  assert.equal(qs.length, 3);
  assert.deepEqual(qs.map((q) => q.relevant).flat(), ['a', 'b', 'c']);
});

test('formatEvalReport: empty runs produces sane message', () => {
  const md = formatEvalReport({
    totalSessions: 0,
    totalQueries: 0,
    k: 5,
    runs: [],
    generatedAt: '2026-05-14T00:00:00Z',
  });
  assert.match(md, /Not enough sessions/);
});

test('runEvalSuite: bails when store has <3 sessions', async () => {
  (vscode.workspace as any).workspaceFolders = undefined;
  const store = new ContextStore(new (vscode as any).InMemoryMemento(), vscode.Uri.file('/tmp'));
  await store.addSession(makeSession({ id: 'only-one', keyTopics: ['just one'] }));
  const r = await runEvalSuite(store);
  assert.equal(r.totalSessions, 1);
  assert.equal(r.runs.length, 0);
});

test('runEvalSuite: runs all three configurations with enough sessions', async () => {
  (vscode.workspace as any).workspaceFolders = undefined;
  const store = new ContextStore(new (vscode as any).InMemoryMemento(), vscode.Uri.file('/tmp'));
  for (let i = 0; i < 5; i++) {
    await store.addSession(
      makeSession({
        id: `s${i}`,
        summary: `Session ${i} discussing topic ${i}`,
        keyTopics: [`topic-marker-${i}`],
      }),
    );
  }
  const r = await runEvalSuite(store);
  assert.equal(r.runs.length, 3);
  for (const run of r.runs) {
    assert.ok(run.recall >= 0 && run.recall <= 1);
    assert.ok(run.mrr >= 0 && run.mrr <= 1);
  }
  const md = formatEvalReport(r);
  assert.match(md, /Recall@k/);
  assert.match(md, /MRR/);
});
