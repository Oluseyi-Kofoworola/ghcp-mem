import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryMemento } from './__mocks__/vscode';
import { ContextStore } from '../contextStore';
import { CompressedSession, computeContentHash } from '../types';
import { buildPack, parsePack, importPack, uninstallPack, listInstalledPacks, PACK_TAG_PREFIX } from '../packs';

function mk(o: Partial<CompressedSession> = {}): CompressedSession {
  const summary = o.summary ?? 's-' + Math.random();
  const keyFiles = o.keyFiles ?? ['a.ts'];
  const keyTopics = o.keyTopics ?? ['x'];
  const decisions = o.decisions ?? [];
  const problemsSolved = o.problemsSolved ?? [];
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: o.startTime ?? Date.now() - 1000,
    endTime: o.endTime ?? Date.now(),
    summary,
    observationType: o.observationType ?? 'feature',
    keyFiles,
    keyTopics,
    decisions,
    problemsSolved,
    rawEventCount: 1,
    userTags: o.userTags ?? [],
    redactionCount: 0,
    contentHash: computeContentHash({ summary, keyFiles, keyTopics, decisions, problemsSolved }),
  };
}

test('packs — buildPack tags every session with pack:<name>', async () => {
  const store = new ContextStore(new InMemoryMemento() as any);
  await store.addSession(mk({ summary: 'a' }));
  await store.addSession(mk({ summary: 'b' }));
  const pack = buildPack(store, { name: 'alpha' });
  assert.equal(pack.sessions.length, 2);
  for (const s of pack.sessions) {
    assert.ok(s.userTags.includes(`${PACK_TAG_PREFIX}alpha`));
  }
  assert.equal(pack.name, 'alpha');
  assert.equal(pack.schemaVersion, 1);
});

test('packs — buildPack respects filterTypes', async () => {
  const store = new ContextStore(new InMemoryMemento() as any);
  await store.addSession(mk({ summary: 'feat', observationType: 'feature' }));
  await store.addSession(mk({ summary: 'bug',  observationType: 'bugfix' }));
  const pack = buildPack(store, { name: 'feats-only', filterTypes: ['feature'] });
  assert.equal(pack.sessions.length, 1);
  assert.equal(pack.sessions[0].observationType, 'feature');
});

test('packs — parsePack rejects invalid JSON structure', () => {
  assert.throws(() => parsePack('{}'));
  assert.throws(() => parsePack(JSON.stringify({ name: 'x', sessions: [] })));
  assert.throws(() => parsePack(JSON.stringify({ schemaVersion: 1, name: 'x' })));
});

test('packs — parsePack rejects future schema versions', () => {
  const future = JSON.stringify({ schemaVersion: 99, name: 'x', sessions: [] });
  assert.throws(() => parsePack(future));
});

test('packs — importPack adds sessions with pack tag, skips existing ids', async () => {
  const store = new ContextStore(new InMemoryMemento() as any);
  await store.addSession(mk({ id: 'existing', summary: 'existing' }));

  const pack = {
    schemaVersion: 1,
    name: 'bravo',
    createdAt: Date.now(),
    sessions: [
      mk({ id: 'existing', summary: 'dup' }),
      mk({ id: 'new-1', summary: 'new session one' }),
      mk({ id: 'new-2', summary: 'new session two' }),
    ],
  };
  const res = await importPack(store, pack);
  assert.equal(res.imported, 2);
  assert.equal(res.skipped, 1);
  const all = store.getAllSessions();
  const tagged = all.filter(s => s.userTags.includes(`${PACK_TAG_PREFIX}bravo`));
  assert.equal(tagged.length, 2);
});

test('packs — uninstallPack removes only pack-tagged sessions', async () => {
  const store = new ContextStore(new InMemoryMemento() as any);
  await store.addSession(mk({ summary: 'untouched', userTags: ['mine'] }));
  const pack = {
    schemaVersion: 1,
    name: 'gamma',
    createdAt: Date.now(),
    sessions: [
      mk({ id: 'g1', summary: 'g-one' }),
      mk({ id: 'g2', summary: 'g-two' }),
    ],
  };
  await importPack(store, pack);
  assert.equal(store.getAllSessions().length, 3);
  const removed = await uninstallPack(store, 'gamma');
  assert.equal(removed, 2);
  assert.equal(store.getAllSessions().length, 1);
});

test('packs — listInstalledPacks groups by name with counts', async () => {
  const store = new ContextStore(new InMemoryMemento() as any);
  await importPack(store, {
    schemaVersion: 1, name: 'one', createdAt: Date.now(),
    sessions: [mk({ id: 'a' }), mk({ id: 'b' })],
  });
  await importPack(store, {
    schemaVersion: 1, name: 'two', createdAt: Date.now(),
    sessions: [mk({ id: 'c' })],
  });
  const installed = listInstalledPacks(store);
  assert.deepEqual(
    installed.map(p => ({ name: p.name, count: p.count })).sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: 'one', count: 2 }, { name: 'two', count: 1 }],
  );
});
