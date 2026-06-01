/**
 * Phase 2 Slice A tests — query intent, expansion, supersession/retraction
 * lifecycle, telemetry counters, search effects, splitIdAndText helper.
 *
 * Uses the default __mocks__/vscode shim (EventEmitter etc.) so ContextStore
 * tests work alongside the pure-function tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMemento } from './__mocks__/vscode';
import { ContextStore } from '../contextStore';
import { CompressedSession, computeContentHash } from '../types';
import { classifyIntent, intentWeights } from '../queryIntent';
import { expandQuery } from '../queryExpansion';
import { splitIdAndText } from '../contextProvider';
import { findEnclosingSymbol } from '../sessionCapture';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const summary = overrides.summary ?? 's';
  const keyFiles = overrides.keyFiles ?? ['a.ts'];
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
  if (overrides.supersededBy !== undefined) base.supersededBy = overrides.supersededBy;
  if (overrides.supersedes !== undefined) base.supersedes = overrides.supersedes;
  if (overrides.retracted !== undefined) base.retracted = overrides.retracted;
  if (overrides.usage !== undefined) base.usage = { ...overrides.usage };
  return base;
}

// ─── queryIntent ─────────────────────────────────────────────────────────────

test('classifyIntent — decision queries', () => {
  assert.equal(classifyIntent('why did we choose Postgres'), 'decision');
  assert.equal(classifyIntent('what did we decide about auth'), 'decision');
  assert.equal(classifyIntent('rationale for using JWT'), 'decision');
});

test('classifyIntent — problem queries', () => {
  assert.equal(classifyIntent('have we hit this stack trace before'), 'problem');
  assert.equal(classifyIntent('how did we fix the regression'), 'problem');
  assert.equal(classifyIntent('exception in payment service'), 'problem');
});

test('classifyIntent — recent queries', () => {
  assert.equal(classifyIntent('what was I working on'), 'recent');
  assert.equal(classifyIntent('what am i doing yesterday'), 'recent');
  assert.equal(classifyIntent('latest session'), 'recent');
});

test('classifyIntent — entity queries (short, identifier-shaped)', () => {
  assert.equal(classifyIntent('hashPassword'), 'entity');
  assert.equal(classifyIntent('src/auth.ts'), 'entity');
  assert.equal(classifyIntent('user_service'), 'entity');
});

test('classifyIntent — general fallback for long prose', () => {
  assert.equal(classifyIntent('something about caching layer in the API'), 'general');
  assert.equal(classifyIntent(''), 'general');
});

test('intentWeights — recent intent amplifies recency 3×', () => {
  const w = intentWeights('recent');
  assert.equal(w.recencyMultiplier, 3.0);
  assert.equal(w.keywordWeight, 0.5);
});

test('intentWeights — decision intent boosts decision-bearing sessions', () => {
  const w = intentWeights('decision');
  assert.ok(w.decisionBoost > 0);
  assert.equal(w.problemBoost, 0);
});

// ─── queryExpansion ──────────────────────────────────────────────────────────

test('expandQuery — picks terms that co-occur with the query terms', () => {
  // Make the corpus large enough that strong co-occurrence doesn't trip
  // the maxGlobalFrequency stopword filter (default cap 50%).
  const sessionIds = Array.from({ length: 10 }, (_, i) => `s${i + 1}`);
  const authSet = new Set(['s1', 's2', 's3']); // 30% of corpus
  const jwtSet = new Set(['s1', 's2', 's3']); // always co-occurs with auth
  const bcryptSet = new Set(['s1', 's2']); // mostly co-occurs
  const uiSet = new Set(['s9']); // unrelated
  const index = new Map<string, Set<string>>([
    ['auth', authSet],
    ['jwt', jwtSet],
    ['bcrypt', bcryptSet],
    ['ui', uiSet],
  ]);
  const expansions = expandQuery(new Set(['auth']), index, sessionIds.length);
  assert.ok(expansions.includes('jwt'), 'jwt must be expanded');
  assert.ok(expansions.includes('bcrypt'), 'bcrypt must be expanded');
  assert.ok(!expansions.includes('ui'), 'ui must NOT be expanded');
  assert.ok(!expansions.includes('auth'), 'original query term must not leak into expansions');
});

test('expandQuery — drops candidates above the global-frequency cap', () => {
  const index = new Map<string, Set<string>>([
    ['auth', new Set(['s1', 's2'])],
    // "session" appears in every single doc — too generic, must be filtered.
    ['session', new Set(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'])],
  ]);
  const expansions = expandQuery(new Set(['auth']), index, 10, { maxGlobalFrequency: 0.5 });
  assert.ok(!expansions.includes('session'), 'stopword-ish global terms must not expand');
});

test('expandQuery — empty when index lacks the query terms', () => {
  const index = new Map<string, Set<string>>([['unrelated', new Set(['x'])]]);
  assert.deepEqual(expandQuery(new Set(['auth']), index, 1), []);
});

test('expandQuery — empty for empty term set', () => {
  const index = new Map<string, Set<string>>([['auth', new Set(['x'])]]);
  assert.deepEqual(expandQuery(new Set(), index, 1), []);
});

// ─── findEnclosingSymbol ─────────────────────────────────────────────────────

test('findEnclosingSymbol — returns deepest enclosing symbol name', () => {
  // Mimic vscode.DocumentSymbol shape — we only need range + name + children.
  const symbols = [
    {
      name: 'AuthService',
      range: { start: { line: 0 }, end: { line: 50 } },
      children: [
        {
          name: 'hashPassword',
          range: { start: { line: 10 }, end: { line: 20 } },
          children: [],
        },
      ],
    },
  ] as any;
  const targetRange = { start: { line: 15 }, end: { line: 15 } } as any;
  assert.equal(findEnclosingSymbol(symbols, targetRange), 'hashPassword');
});

test('findEnclosingSymbol — returns undefined when target falls outside any symbol', () => {
  const symbols = [
    {
      name: 'X',
      range: { start: { line: 0 }, end: { line: 5 } },
      children: [],
    },
  ] as any;
  const target = { start: { line: 50 }, end: { line: 50 } } as any;
  assert.equal(findEnclosingSymbol(symbols, target), undefined);
});

// ─── ContextStore supersession + retraction + correction ────────────────────

test('ContextStore.setSupersedes — links both rows', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(makeSession({ id: 'old', summary: 'old decision' }));
  await store.addSession(makeSession({ id: 'new', summary: 'new decision' }));
  const ok = await store.setSupersedes('new', 'old');
  assert.equal(ok, true);
  assert.equal(store.getById('new')!.supersedes, 'old');
  assert.equal(store.getById('old')!.supersededBy, 'new');
});

test('ContextStore.setSupersedes — refuses self-reference', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(makeSession({ id: 'x', summary: 'unique x' }));
  assert.equal(await store.setSupersedes('x', 'x'), false);
});

test('ContextStore.setRetracted + undoRetract', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(makeSession({ id: 'a', summary: 'broken decision' }));
  assert.equal(await store.setRetracted('a', 'was wrong'), true);
  assert.equal(store.getById('a')!.retracted, true);
  assert.equal(store.getById('a')!.retractedReason, 'was wrong');
  await store.undoRetract('a');
  assert.equal(store.getById('a')!.retracted, false);
});

test('ContextStore.addCorrection — chains correctionOf + supersession', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  // Distinct summaries so contentHash dedup doesn't merge them.
  await store.addSession(makeSession({ id: 'orig', summary: 'original decision text' }));
  await store.addSession(makeSession({ id: 'fix', summary: 'corrected decision text' }));
  assert.equal(await store.addCorrection('orig', 'fix'), true);
  assert.equal(store.getById('fix')!.correctionOf, 'orig');
  assert.equal(store.getById('orig')!.supersededBy, 'fix');
  assert.equal(store.getById('fix')!.supersedes, 'orig');
});

// ─── search effects: retraction, supersession, reinforcement ────────────────

test('ContextStore.search — excludes retracted sessions', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(
    makeSession({ id: 'keep', summary: 'auth notes', keyTopics: ['authentication'] }),
  );
  await store.addSession(
    makeSession({
      id: 'drop',
      summary: 'auth notes',
      keyTopics: ['authentication'],
      retracted: true,
    }),
  );
  const results = store.search('auth', {}, 5);
  assert.deepEqual(results.map((s) => s.id).sort(), ['keep']);
});

test('ContextStore.search — supersession penalty pushes superseded sessions below their replacement', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const now = Date.now();
  // The older "main" session has more keyword density (would normally rank
  // higher on BM25), but its supersession penalty must keep it below the
  // newer/lighter session.
  await store.addSession(
    makeSession({
      id: 'old',
      summary: 'auth auth auth jwt jwt jwt',
      keyTopics: ['authentication', 'jwt'],
      endTime: now - 10_000,
      supersededBy: 'new',
    }),
  );
  await store.addSession(
    makeSession({
      id: 'new',
      summary: 'auth jwt',
      keyTopics: ['authentication'],
      endTime: now,
    }),
  );
  const results = store.search('auth jwt', {}, 5);
  assert.equal(results[0].id, 'new', 'newer (non-superseded) session must rank first');
});

test('ContextStore.search — bumps usage.retrieved counters on the returned set', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(makeSession({ id: 's1', summary: 'rare topic widget' }));
  store.search('widget', {}, 5);
  await store.flushTelemetry();
  assert.equal(store.getById('s1')!.usage?.retrieved, 1);
});

test('ContextStore.recordAcceptance / recordRejection — counters update + persist', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(makeSession({ id: 's1' }));
  await store.recordAcceptance('s1');
  await store.recordAcceptance('s1');
  await store.recordRejection('s1');
  const u = store.getById('s1')!.usage!;
  assert.equal(u.accepted, 2);
  assert.equal(u.rejected, 1);
});

test('ContextStore.search — accept feedback rank-boost beats reject', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const now = Date.now();
  await store.addSession(
    makeSession({
      id: 'accepted',
      summary: 'auth refactor',
      keyTopics: ['authentication'],
      endTime: now,
      usage: { retrieved: 0, lastRetrievedAt: 0, accepted: 5, rejected: 0 },
    }),
  );
  await store.addSession(
    makeSession({
      id: 'rejected',
      summary: 'auth refactor',
      keyTopics: ['authentication'],
      endTime: now,
      usage: { retrieved: 0, lastRetrievedAt: 0, accepted: 0, rejected: 5 },
    }),
  );
  const results = store.search('auth', {}, 5);
  assert.equal(results[0].id, 'accepted', 'accept-heavy session must outrank reject-heavy session');
});

test('getStartupCandidates — skips retracted and superseded sessions', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(makeSession({ id: 'live', summary: 'live' }));
  await store.addSession(makeSession({ id: 'old', summary: 'old', supersededBy: 'live' }));
  await store.addSession(makeSession({ id: 'gone', summary: 'gone', retracted: true }));
  const ids = store.getStartupCandidates(10).map((s) => s.id);
  assert.deepEqual(ids, ['live']);
});

// ─── splitIdAndText helper ──────────────────────────────────────────────────

test('splitIdAndText — splits id from text payload', () => {
  assert.deepEqual(splitIdAndText('abc123 the actual rationale was X'), {
    idPrefix: 'abc123',
    text: 'the actual rationale was X',
  });
});

test('splitIdAndText — id-only input yields empty text', () => {
  assert.deepEqual(splitIdAndText('abc123'), { idPrefix: 'abc123', text: '' });
});

test('splitIdAndText — empty input', () => {
  assert.deepEqual(splitIdAndText(''), { idPrefix: '', text: '' });
});
