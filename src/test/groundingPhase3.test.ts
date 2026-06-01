/**
 * Phase 3 Slice A tests — entity aggregation, multi-hop lineage walking,
 * confidence decay, nDCG@K + gold-corpus eval.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMemento } from './__mocks__/vscode';
import { ContextStore } from '../contextStore';
import { CompressedSession, Evidence, computeContentHash } from '../types';
import {
  buildEntityRecord,
  renderEntityMarkdown,
  walkSupersedesChain,
  sessionTouchesEntity,
} from '../entity';
import {
  effectiveConfidence,
  lastInteractionTimestamp,
  DECAY_HALF_LIFE_MS,
  MAX_DECAY_HAIRCUT,
} from '../decay';
import { ndcgAtK, runGoldEval } from '../eval';

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
  if (overrides.decisionEvidence !== undefined) base.decisionEvidence = overrides.decisionEvidence;
  if (overrides.problemEvidence !== undefined) base.problemEvidence = overrides.problemEvidence;
  if (overrides.usage !== undefined) base.usage = { ...overrides.usage };
  return base;
}

// ─── Entity layer ────────────────────────────────────────────────────────────

test('sessionTouchesEntity — file kind matches exact or suffix path', () => {
  const s = makeSession({ keyFiles: ['src/auth/service.ts'] });
  assert.equal(sessionTouchesEntity(s, 'src/auth/service.ts', 'file'), true);
  assert.equal(sessionTouchesEntity(s, 'auth/service.ts', 'file'), true);
  assert.equal(sessionTouchesEntity(s, 'service.ts', 'file'), true);
  assert.equal(sessionTouchesEntity(s, 'totally/other.ts', 'file'), false);
});

test('sessionTouchesEntity — symbol kind matches via evidence symbolId', () => {
  const ev: Evidence[][] = [
    [{ kind: 'file_edit', filePath: 'src/auth.ts', symbolId: 'src/auth.ts#hashPassword' }],
  ];
  const s = makeSession({ decisionEvidence: ev, decisions: ['bcrypt cost 12'] });
  assert.equal(sessionTouchesEntity(s, 'src/auth.ts#hashPassword', 'symbol'), true);
  assert.equal(sessionTouchesEntity(s, 'src/auth.ts#otherFn', 'symbol'), false);
});

test('buildEntityRecord — aggregates decisions, problems, topics across sessions', () => {
  const now = Date.now();
  const sessions = [
    makeSession({
      id: 's1',
      summary: 'auth jwt rework',
      keyFiles: ['src/auth.ts'],
      keyTopics: ['authentication', 'jwt'],
      decisions: ['use JWT'],
      problemsSolved: [],
      endTime: now - 100_000,
    }),
    makeSession({
      id: 's2',
      summary: 'bcrypt cost bump',
      keyFiles: ['src/auth.ts'],
      keyTopics: ['authentication', 'security'],
      decisions: ['bcrypt cost 12'],
      problemsSolved: ['weak hash'],
      endTime: now,
    }),
    makeSession({
      id: 'other',
      summary: 'ui tweak',
      keyFiles: ['src/widget.tsx'],
      keyTopics: ['ui'],
    }),
  ];
  const rec = buildEntityRecord('src/auth.ts', sessions);
  assert.ok(rec);
  assert.equal(rec!.kind, 'file');
  assert.equal(rec!.sessionCount, 2);
  assert.deepEqual(
    rec!.decisions.map((d) => d.text),
    ['bcrypt cost 12', 'use JWT'],
    'newest decision first',
  );
  assert.ok(rec!.topTopics.includes('authentication'));
  assert.ok(!rec!.topTopics.includes('ui'), 'unrelated topics must not leak');
});

test('buildEntityRecord — auto-detects symbol kind when key contains #', () => {
  const ev: Evidence[][] = [
    [{ kind: 'file_edit', filePath: 'src/auth.ts', symbolId: 'src/auth.ts#hashPassword' }],
  ];
  const sessions = [makeSession({ id: 's1', decisionEvidence: ev, decisions: ['bcrypt 12'] })];
  const rec = buildEntityRecord('src/auth.ts#hashPassword', sessions);
  assert.ok(rec);
  assert.equal(rec!.kind, 'symbol');
});

test('buildEntityRecord — returns undefined for unknown keys', () => {
  const rec = buildEntityRecord('nope.ts', [makeSession({ keyFiles: ['src/foo.ts'] })]);
  assert.equal(rec, undefined);
});

test('buildEntityRecord — flags all-superseded/retracted entities', () => {
  const sessions = [
    makeSession({ id: 'a', keyFiles: ['x.ts'], supersededBy: 'b' }),
    makeSession({ id: 'b', keyFiles: ['x.ts'], retracted: true }),
  ];
  const rec = buildEntityRecord('x.ts', sessions);
  assert.ok(rec);
  assert.equal(rec!.allSupersededOrRetracted, true);
});

test('renderEntityMarkdown — emits headers and decisions', () => {
  const sessions = [
    makeSession({
      id: 's1',
      keyFiles: ['src/a.ts'],
      decisions: ['use bcrypt'],
      keyTopics: ['security'],
    }),
  ];
  const md = renderEntityMarkdown(buildEntityRecord('src/a.ts', sessions)!);
  assert.match(md, /Entity:.*src\/a\.ts/);
  assert.match(md, /use bcrypt/);
  assert.match(md, /security/);
});

// ─── walkSupersedesChain ─────────────────────────────────────────────────────

test('walkSupersedesChain — returns oldest → newest order', () => {
  const map = new Map<string, CompressedSession>();
  const a = makeSession({ id: 'a', supersededBy: 'b' });
  const b = makeSession({ id: 'b', supersedes: 'a', supersededBy: 'c' });
  const c = makeSession({ id: 'c', supersedes: 'b' });
  map.set('a', a);
  map.set('b', b);
  map.set('c', c);
  assert.deepEqual(
    walkSupersedesChain('c', map).map((s) => s.id),
    ['a', 'b', 'c'],
  );
});

test('walkSupersedesChain — breaks cycles defensively', () => {
  const map = new Map<string, CompressedSession>();
  const a = makeSession({ id: 'a', supersedes: 'b' });
  const b = makeSession({ id: 'b', supersedes: 'a' });
  map.set('a', a);
  map.set('b', b);
  const chain = walkSupersedesChain('a', map).map((s) => s.id);
  assert.ok(chain.length <= 2, 'must not infinite-loop on cycles');
});

// ─── ContextStore.enrichWithMultiHop ─────────────────────────────────────────

test('ContextStore.enrichWithMultiHop — attaches lineage + related entities', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const ev: Evidence[][] = [
    [{ kind: 'file_edit', filePath: 'src/auth.ts', symbolId: 'src/auth.ts#hashPassword' }],
  ];
  await store.addSession(
    makeSession({ id: 'old', summary: 'old auth decision', supersededBy: 'new' }),
  );
  await store.addSession(
    makeSession({
      id: 'new',
      summary: 'new auth decision',
      supersedes: 'old',
      decisionEvidence: ev,
      decisions: ['bcrypt cost 12'],
    }),
  );
  const enriched = store.enrichWithMultiHop([store.getById('new')!]);
  assert.equal(enriched.length, 1);
  assert.deepEqual(
    enriched[0].lineage.map((s) => s.id),
    ['old', 'new'],
  );
  assert.ok(enriched[0].relatedSymbols.includes('src/auth.ts#hashPassword'));
  assert.ok(enriched[0].relatedFiles.includes('src/auth.ts'));
});

// ─── Confidence decay ───────────────────────────────────────────────────────

test('effectiveConfidence — fresh session returns near-stored confidence', () => {
  const s = makeSession({ confidence: 0.9, endTime: Date.now() });
  const eff = effectiveConfidence(s);
  assert.ok(eff !== undefined);
  assert.ok(Math.abs(eff! - 0.9) < 0.01, `expected ≈0.9, got ${eff}`);
});

test('effectiveConfidence — old session caps haircut at MAX_DECAY_HAIRCUT', () => {
  const veryOld = Date.now() - DECAY_HALF_LIFE_MS * 50; // ~8 years
  const s = makeSession({ confidence: 1.0, endTime: veryOld });
  const eff = effectiveConfidence(s)!;
  // Floor for confidence=1.0 is 1.0 * (1 - MAX_DECAY_HAIRCUT) = 0.7
  assert.ok(
    eff >= 1.0 * (1 - MAX_DECAY_HAIRCUT) - 0.001,
    `eff ${eff} should be ≥ ${1.0 * (1 - MAX_DECAY_HAIRCUT)}`,
  );
  assert.ok(eff <= 1.0, 'must not exceed stored confidence');
});

test('effectiveConfidence — recent retrieval resets decay clock', () => {
  const oldEndTime = Date.now() - DECAY_HALF_LIFE_MS * 10;
  const staleS = makeSession({ confidence: 1.0, endTime: oldEndTime });
  const refreshedS = makeSession({
    confidence: 1.0,
    endTime: oldEndTime,
    usage: { retrieved: 5, lastRetrievedAt: Date.now() - 1000, accepted: 0, rejected: 0 },
  });
  const stale = effectiveConfidence(staleS)!;
  const refreshed = effectiveConfidence(refreshedS)!;
  assert.ok(refreshed > stale, `refreshed (${refreshed}) should outrank stale (${stale})`);
});

test('effectiveConfidence — legacy session without confidence returns undefined', () => {
  const s = makeSession();
  delete (s as any).confidence;
  assert.equal(effectiveConfidence(s), undefined);
});

test('lastInteractionTimestamp — takes max of endTime + usage timestamps', () => {
  const baseEnd = Date.now() - 100_000;
  const interactionTime = Date.now() - 1000;
  const s = makeSession({
    endTime: baseEnd,
    usage: {
      retrieved: 1,
      lastRetrievedAt: 0,
      accepted: 1,
      rejected: 0,
      lastInteractionAt: interactionTime,
    },
  });
  assert.equal(lastInteractionTimestamp(s), interactionTime);
});

// ─── nDCG@K ──────────────────────────────────────────────────────────────────

test('ndcgAtK — relevant in position 1 yields nDCG = 1.0', () => {
  const top = [makeSession({ id: 'hit' })];
  assert.equal(ndcgAtK(top, new Set(['hit']), 5), 1);
});

test('ndcgAtK — relevant deeper in list yields lower nDCG', () => {
  const top = [makeSession({ id: 'a' }), makeSession({ id: 'b' }), makeSession({ id: 'hit' })];
  const score = ndcgAtK(top, new Set(['hit']), 5);
  assert.ok(score > 0 && score < 1, `expected 0<nDCG<1, got ${score}`);
});

test('ndcgAtK — empty relevant set returns 0', () => {
  const top = [makeSession({ id: 'hit' })];
  assert.equal(ndcgAtK(top, new Set(), 5), 0);
});

test('ndcgAtK — relevant beyond k returns 0', () => {
  const top = Array.from({ length: 10 }, (_, i) => makeSession({ id: `s${i}` }));
  assert.equal(ndcgAtK(top, new Set(['s7']), 5), 0);
});

// ─── runGoldEval ─────────────────────────────────────────────────────────────

test('runGoldEval — produces three runs with finite metrics on a seeded store', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(
    makeSession({ id: 's1', summary: 'auth refactor', keyTopics: ['authentication'] }),
  );
  await store.addSession(
    makeSession({ id: 's2', summary: 'payments rework', keyTopics: ['payments'] }),
  );
  const report = await runGoldEval(store, [
    { q: 'authentication', relevant: ['s1'] },
    { q: 'payments', relevant: ['s2'] },
  ]);
  assert.equal(report.runs.length, 3, 'three configs reported');
  for (const r of report.runs) {
    assert.ok(Number.isFinite(r.recall) && r.recall >= 0 && r.recall <= 1);
    assert.ok(Number.isFinite(r.mrr) && r.mrr >= 0 && r.mrr <= 1);
    assert.ok(Number.isFinite(r.ndcg) && r.ndcg >= 0 && r.ndcg <= 1);
  }
});

test('runGoldEval — empty query set returns no runs', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const report = await runGoldEval(store, []);
  assert.deepEqual(report.runs, []);
});
