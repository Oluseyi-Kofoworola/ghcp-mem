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
