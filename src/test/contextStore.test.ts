import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryMemento } from './__mocks__/vscode';
import { ContextStore } from '../contextStore';
import { CompressedSession, computeContentHash } from '../types';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const summary = overrides.summary ?? 'sess summary';
  const keyFiles = overrides.keyFiles ?? ['a.ts'];
  const keyTopics = overrides.keyTopics ?? ['refactor'];
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
    contentHash: overrides.contentHash ?? computeContentHash({ summary, keyFiles, keyTopics, decisions, problemsSolved }),
  };
  return base;
}

test('ContextStore — addSession stores a new session', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(makeSession({ summary: 'first' }));
  assert.equal(store.getAllSessions().length, 1);
});

test('ContextStore — dedup on identical contentHash', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const s1 = makeSession({ summary: 'same payload' });
  const s2 = makeSession({ summary: 'same payload', id: 'different-id' });
  await store.addSession(s1);
  await store.addSession(s2);
  // Dedup: both have same contentHash => only one stored
  assert.equal(store.getAllSessions().length, 1);
});

test('ContextStore — two sessions with different summaries coexist', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(makeSession({ summary: 'alpha' }));
  await store.addSession(makeSession({ summary: 'beta' }));
  assert.equal(store.getAllSessions().length, 2);
});

test('ContextStore — search returns relevant sessions', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(makeSession({ summary: 'auth refactor', keyTopics: ['authentication'] }));
  await store.addSession(makeSession({ summary: 'ui tweaks', keyTopics: ['colors'] }));
  const hits = store.search('authentication', {}, 10);
  assert.ok(hits.length >= 1);
  assert.match(hits[0].summary, /auth/);
});

test('ContextStore — search filter by type', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(makeSession({ summary: 'fix one', observationType: 'bugfix', keyTopics: ['x'] }));
  await store.addSession(makeSession({ summary: 'add one', observationType: 'feature', keyTopics: ['y'] }));
  const bugHits = store.search('', { type: 'bugfix' }, 10);
  assert.equal(bugHits.every(s => s.observationType === 'bugfix'), true);
});

test('ContextStore — RRF prefers recent+matching over old-only', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const oldTs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const newTs = Date.now();
  await store.addSession(makeSession({ id: 'old', summary: 'rate limiter logic', keyTopics: ['rate'], startTime: oldTs, endTime: oldTs }));
  await store.addSession(makeSession({ id: 'new', summary: 'rate limiter logic', keyTopics: ['rate'], startTime: newTs, endTime: newTs, keyFiles: ['x.ts'] }));
  const hits = store.search('rate', {}, 5);
  assert.equal(hits[0].id, 'new');
});

test('ContextStore — getStartupCandidates prefers sessions with decisions over plain ones at same recency', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const now = Date.now();
  // Two equally-recent sessions; one has decisions, one is plain.
  await store.addSession(makeSession({
    id: '11111111-1111-4111-8111-111111111111',
    summary: 'plain session', startTime: now, endTime: now,
    decisions: [], problemsSolved: [], userTags: [],
  }));
  await store.addSession(makeSession({
    id: '22222222-2222-4222-8222-222222222222',
    summary: 'session with decisions', startTime: now, endTime: now,
    decisions: ['picked X over Y'], problemsSolved: [],
  }));
  const picks = store.getStartupCandidates(1);
  assert.equal(picks.length, 1);
  assert.match(picks[0].summary, /decisions/);
});

test('ContextStore — getStartupCandidates lets a pinned older session beat a recent unknown-type one', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const now = Date.now();
  const oldTs = now - 3 * 86_400_000; // 3 days old — recency still > 0
  // Pinned, 3 days old. Should score ~10 (tag) + recency(~6) ≈ 16.
  await store.addSession(makeSession({
    id: '33333333-3333-4333-8333-333333333333',
    summary: 'pinned older', startTime: oldTs, endTime: oldTs,
    observationType: 'feature', userTags: ['pin'],
  }));
  // Recent but unknown-type with no metadata. Recency ~10, importance 0 = ~10.
  await store.addSession(makeSession({
    id: '44444444-4444-4444-8444-444444444444',
    summary: 'recent empty', startTime: now, endTime: now,
    observationType: 'unknown', userTags: [], decisions: [], problemsSolved: [],
  }));
  const picks = store.getStartupCandidates(1);
  assert.equal(picks.length, 1);
  assert.match(picks[0].summary, /pinned/);
});

test('ContextStore — getStartupCandidates returns oldest-first chronological order', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const t0 = Date.now() - 2 * 86_400_000;
  const t1 = Date.now() - 1 * 86_400_000;
  const t2 = Date.now();
  await store.addSession(makeSession({
    id: '55555555-5555-4555-8555-555555555555',
    summary: 'middle', startTime: t1, endTime: t1, decisions: ['d'],
  }));
  await store.addSession(makeSession({
    id: '66666666-6666-4666-8666-666666666666',
    summary: 'newest', startTime: t2, endTime: t2, decisions: ['d'],
  }));
  await store.addSession(makeSession({
    id: '77777777-7777-4777-8777-777777777777',
    summary: 'oldest', startTime: t0, endTime: t0, decisions: ['d'],
  }));
  const picks = store.getStartupCandidates(3);
  assert.equal(picks.length, 3);
  assert.equal(picks[0].summary, 'oldest');
  assert.equal(picks[1].summary, 'middle');
  assert.equal(picks[2].summary, 'newest');
});

test('ContextStore — getStartupCandidates returns [] when no sessions', () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  assert.deepEqual(store.getStartupCandidates(3), []);
});
