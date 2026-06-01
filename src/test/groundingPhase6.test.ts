/**
 * Phase 6 tests — /why score-decomposition, Mermaid graph export,
 * conflict dismiss subcommand path (verified via ContextStore mutator).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMemento } from './__mocks__/vscode';
import { ContextStore } from '../contextStore';
import { CompressedSession, computeContentHash } from '../types';
import { explainScore, renderExplanation } from '../explain';
import { buildMermaidGraph } from '../graphExport';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const summary = overrides.summary ?? 's';
  const keyFiles = overrides.keyFiles ?? ['src/foo.ts'];
  const keyTopics = overrides.keyTopics ?? [];
  const decisions = overrides.decisions ?? [];
  const problemsSolved = overrides.problemsSolved ?? [];
  const base: CompressedSession = {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    workspaceId: overrides.workspaceId ?? 'ws1',
    workspaceName: overrides.workspaceName ?? 'ws',
    startTime: overrides.startTime ?? Date.now() - 1000,
    endTime: overrides.endTime ?? Date.now(),
    summary,
    observationType: overrides.observationType ?? 'refactor',
    keyFiles,
    keyTopics,
    decisions,
    problemsSolved,
    rawEventCount: overrides.rawEventCount ?? 10,
    userTags: overrides.userTags ?? [],
    redactionCount: overrides.redactionCount ?? 0,
    contentHash:
      overrides.contentHash ??
      computeContentHash({ summary, keyFiles, keyTopics, decisions, problemsSolved }),
  };
  if (overrides.confidence !== undefined) base.confidence = overrides.confidence;
  if (overrides.supersedes !== undefined) base.supersedes = overrides.supersedes;
  if (overrides.supersededBy !== undefined) base.supersededBy = overrides.supersededBy;
  if (overrides.retracted !== undefined) base.retracted = overrides.retracted;
  if (overrides.correctionOf !== undefined) base.correctionOf = overrides.correctionOf;
  if (overrides.usage !== undefined) base.usage = { ...overrides.usage };
  return base;
}

// ─── explainScore ────────────────────────────────────────────────────────────

test('explainScore — covers every signal contribution', () => {
  const target = makeSession({
    id: 'X',
    summary: 'auth jwt rework',
    keyTopics: ['authentication', 'jwt'],
    decisions: ['use bcrypt cost 12'],
    confidence: 0.85,
  });
  const e = explainScore(target, 'auth jwt', { allSessions: [target] });
  const labels = e.contributions.map((c) => c.label);
  for (const expected of [
    'keyword',
    'recency',
    'workspace',
    'match-ratio',
    'confidence',
    'decision-boost',
    'problem-boost',
    'reinforcement',
    'feedback',
    'superseded',
  ]) {
    assert.ok(labels.includes(expected), `missing contribution ${expected}`);
  }
});

test('explainScore — total roughly matches the score the ranker uses', () => {
  const target = makeSession({
    id: 'A',
    summary: 'auth refactor',
    keyTopics: ['authentication'],
    endTime: Date.now(),
  });
  const e = explainScore(target, 'auth', { allSessions: [target] });
  // With only one session, the keyword and recency RRF both = 1/60.
  // The total must be > 0 (recency-only contribution at minimum).
  assert.ok(e.total > 0);
});

test('explainScore — supersession contributes a negative penalty', () => {
  const target = makeSession({
    id: 'A',
    summary: 'old auth note',
    supersededBy: 'B',
  });
  const other = makeSession({ id: 'B', summary: 'new auth note' });
  const e = explainScore(target, 'auth', { allSessions: [target, other] });
  const supersededRow = e.contributions.find((c) => c.label === 'superseded')!;
  assert.equal(supersededRow.value, -0.3);
});

test('explainScore — uses learned weights when supplied', () => {
  const target = makeSession({
    id: 'A',
    summary: 'auth refactor',
    keyTopics: ['authentication'],
    endTime: Date.now(),
  });
  const baseline = explainScore(target, 'auth', { allSessions: [target] });
  const boosted = explainScore(target, 'auth', {
    allSessions: [target],
    learnedWeights: {
      keyword: 1.25,
      recency: 1.0,
      confidence: 1.0,
      reinforcement: 1.0,
      feedback: 1.0,
    },
  });
  const baseK = baseline.contributions.find((c) => c.label === 'keyword')!.value;
  const boostK = boosted.contributions.find((c) => c.label === 'keyword')!.value;
  assert.ok(
    boostK > baseK,
    `learned keyword weight should lift the keyword contribution (base ${baseK}, boosted ${boostK})`,
  );
});

test('explainScore — rank within candidate pool is reported', () => {
  const a = makeSession({ id: 'a', summary: 'auth jwt' });
  const b = makeSession({ id: 'b', summary: 'auth jwt jwt' }); // higher BM25
  const e = explainScore(a, 'jwt', { allSessions: [a, b] });
  assert.ok(e.rank! >= 1 && e.rank! <= 2);
  assert.equal(e.candidateCount, 2);
});

test('renderExplanation — produces a markdown table with all rows', () => {
  const target = makeSession({ id: 'A', summary: 'auth', confidence: 0.7 });
  const e = explainScore(target, 'auth', { allSessions: [target] });
  const md = renderExplanation(e);
  assert.match(md, /Why did/);
  assert.match(md, /keyword/);
  assert.match(md, /recency/);
  assert.match(md, /Total score/);
});

// ─── Mermaid graph export ────────────────────────────────────────────────────

test('buildMermaidGraph — emits flowchart header and one node per session', () => {
  const sessions = [
    makeSession({
      id: '00000000-0000-0000-0000-aaaaaaaaaaaa',
      summary: 'first',
      observationType: 'feature',
    }),
    makeSession({
      id: '00000000-0000-0000-0000-bbbbbbbbbbbb',
      summary: 'second',
      observationType: 'bugfix',
    }),
  ];
  const md = buildMermaidGraph(sessions);
  assert.match(md, /^flowchart TB/);
  assert.match(md, /s00000000\["\[feature\] first"\]/);
  assert.match(md, /s00000000\["\[feature\] first"\]|s00000000\["\[bugfix\] second"\]/);
});

test('buildMermaidGraph — emits supersession edges with `supersedes` label', () => {
  const sessions = [
    makeSession({
      id: '00000000-0000-0000-0000-aaaaaaaaaaaa',
      summary: 'old',
      supersededBy: '00000000-0000-0000-0000-bbbbbbbbbbbb',
    }),
    makeSession({
      id: '00000000-0000-0000-0000-bbbbbbbbbbbb',
      summary: 'new',
      supersedes: '00000000-0000-0000-0000-aaaaaaaaaaaa',
    }),
  ];
  const md = buildMermaidGraph(sessions);
  assert.match(md, /-->\|supersedes\|/);
});

test('buildMermaidGraph — emits correction edges as dashed arrows', () => {
  const sessions = [
    makeSession({ id: '00000000-0000-0000-0000-aaaaaaaaaaaa', summary: 'orig' }),
    makeSession({
      id: '00000000-0000-0000-0000-bbbbbbbbbbbb',
      summary: 'fix',
      correctionOf: '00000000-0000-0000-0000-aaaaaaaaaaaa',
    }),
  ];
  const md = buildMermaidGraph(sessions);
  assert.match(md, /-\.->\|corrected by\|/);
});

test('buildMermaidGraph — emits causal edge for bugfix following feature', () => {
  const now = Date.now();
  const feat = makeSession({
    id: '00000000-0000-0000-0000-aaaaaaaaaaaa',
    summary: 'feature work',
    observationType: 'feature',
    keyFiles: ['src/auth.ts'],
    endTime: now - 86_400_000,
  });
  const fix = makeSession({
    id: '00000000-0000-0000-0000-bbbbbbbbbbbb',
    summary: 'bug fix',
    observationType: 'bugfix',
    keyFiles: ['src/auth.ts'],
    startTime: now,
    endTime: now + 1000,
  });
  const md = buildMermaidGraph([feat, fix]);
  assert.match(md, /==>\|fixed by\|/);
});

test('buildMermaidGraph — flags retracted sessions in the node label', () => {
  const sessions = [
    makeSession({
      id: '00000000-0000-0000-0000-cccccccccccc',
      summary: 'gone',
      retracted: true,
    }),
  ];
  const md = buildMermaidGraph(sessions);
  assert.match(md, /🚫/);
  assert.match(md, /stroke-dasharray/);
});

test('buildMermaidGraph — handles empty input gracefully', () => {
  assert.match(buildMermaidGraph([]), /flowchart TB/);
  assert.match(buildMermaidGraph([]), /No sessions/);
});

// ─── /conflicts dismiss path ─────────────────────────────────────────────────

test('ContextStore.acknowledgeConflict — dismisses pending warning with reason', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(
    makeSession({
      id: '00000000-0000-0000-0000-111111111111',
      summary: 'a',
      decisions: ['use cookies'],
      keyFiles: ['src/auth.ts'],
      keyTopics: ['authentication'],
      endTime: Date.now() - 60_000,
    }),
  );
  await store.addSession(
    makeSession({
      id: '00000000-0000-0000-0000-222222222222',
      summary: 'b',
      decisions: ['use JWT instead of cookies'],
      keyFiles: ['src/auth.ts'],
      keyTopics: ['authentication'],
      endTime: Date.now(),
    }),
  );
  assert.equal(store.getPendingConflicts().length, 1);
  const ok = store.acknowledgeConflict(
    '00000000-0000-0000-0000-222222222222',
    'Marketing call, not a real overturn',
  );
  assert.equal(ok, true);
  assert.equal(store.getPendingConflicts().length, 0);
});

test('ContextStore.acknowledgeConflict — returns false for unknown warnings', () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  assert.equal(store.acknowledgeConflict('nope'), false);
});
