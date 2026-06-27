import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryMemento } from './__mocks__/vscode';
import { ContextStore } from '../contextStore';
import { CompressedSession, computeContentHash } from '../types';
import { runJanitor } from '../janitor';
import { makePinnedLesson } from '../lessons';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const summary = overrides.summary ?? 'sess';
  const keyFiles = overrides.keyFiles ?? [];
  const keyTopics = overrides.keyTopics ?? [];
  const decisions = overrides.decisions ?? [];
  const problemsSolved = overrides.problemsSolved ?? [];
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: overrides.startTime ?? Date.now(),
    endTime: overrides.endTime ?? Date.now(),
    summary,
    observationType: overrides.observationType ?? 'unknown',
    keyFiles,
    keyTopics,
    decisions,
    problemsSolved,
    rawEventCount: overrides.rawEventCount ?? 0,
    userTags: [],
    redactionCount: 0,
    contentHash: computeContentHash({ summary, keyFiles, keyTopics, decisions, problemsSolved }),
    ...overrides,
  };
}

test('janitor — flags low-quality sessions and leaves rich ones', async () => {
  const store = new ContextStore(new InMemoryMemento() as any);
  await store.addSession(makeSession({ id: 'thin', summary: 'x' }));
  await store.addSession(
    makeSession({
      id: 'rich',
      summary: 'Refactored auth middleware to use shared session validator across all routes.',
      observationType: 'refactor',
      decisions: ['use shared validator'],
      decisionEvidence: [[{ eventId: 'e1', kind: 'file_edit' } as any]],
      keyFiles: ['src/a.ts'],
      keyTopics: ['auth'],
      rawEventCount: 10,
      compressorMode: 'lm',
    }),
  );
  const report = await runJanitor(store, { qualityFloor: 0.3, pruneAfterDays: 0 });
  assert.equal(report.rescored, 2);
  assert.equal(report.flagged, 1);
  assert.equal(report.pruned, 0);
  assert.equal(store.getById('thin')?.lowQuality, true);
  assert.ok(!store.getById('rich')?.lowQuality);
});

test('janitor — prunes long-stale low-quality sessions with no acceptance', async () => {
  const store = new ContextStore(new InMemoryMemento() as any);
  const old = Date.now() - 30 * 86_400_000;
  await store.addSession(makeSession({ id: 'stale', summary: 'x', startTime: old, endTime: old }));
  const report = await runJanitor(store, { qualityFloor: 0.3, pruneAfterDays: 14 });
  assert.equal(report.pruned, 1);
  assert.equal(store.getById('stale'), undefined);
});

// ── v1.11.0 lessons consolidation + qualityScore bulk-persist ────────────────

test('janitor — repeated decision across 2 sessions becomes 1 lesson', async () => {
  const store = new ContextStore(new InMemoryMemento() as any);
  const sharedDecision = 'always run prettier before committing to keep diffs minimal';
  await store.addSession(
    makeSession({
      id: 'a',
      summary: 'first prettier run',
      observationType: 'chore',
      decisions: [sharedDecision],
      keyFiles: ['src/a.ts'],
      keyTopics: ['format'],
      rawEventCount: 5,
      compressorMode: 'lm',
      confidence: 0.7,
    }),
  );
  await store.addSession(
    makeSession({
      id: 'b',
      summary: 'second prettier run',
      observationType: 'chore',
      decisions: [sharedDecision],
      keyFiles: ['src/b.ts'],
      keyTopics: ['format'],
      rawEventCount: 5,
      compressorMode: 'lm',
      confidence: 0.7,
    }),
  );
  const r1 = await runJanitor(store, { qualityFloor: 0.0, pruneAfterDays: 0 });
  assert.ok(r1.lessonsCreated >= 1, 'consolidated lesson should be created');
  const lessonsAfterFirst = store.getLessons();
  assert.ok(lessonsAfterFirst.length >= 1);

  // Re-run: should reinforce, not duplicate.
  const r2 = await runJanitor(store, { qualityFloor: 0.0, pruneAfterDays: 0 });
  assert.equal(r2.lessonsCreated, 0, 'second pass must not create duplicates');
  assert.equal(store.getLessons().length, lessonsAfterFirst.length);
});

test('janitor — pinned lesson survives consolidation cap', async () => {
  const store = new ContextStore(new InMemoryMemento() as any);
  // Pin a hand-authored lesson directly.
  const pinned = makePinnedLesson('Never commit secrets directly — always use a vault.');
  await store.addLesson(pinned);
  // Tight cap to provoke eviction pressure.
  const r = await runJanitor(store, {
    qualityFloor: 0.0,
    pruneAfterDays: 0,
    lessonMinSupport: 1,
  });
  assert.ok(r);
  const survivors = store.getLessons();
  assert.ok(
    survivors.some((l) => l.id === pinned.id),
    'pinned lesson must survive consolidation',
  );
});

test('janitor — drifted-but-unflipped qualityScore triggers exactly one flush', async () => {
  const store = new ContextStore(new InMemoryMemento() as any);
  // Seed two sessions and snapshot their scores. We then mutate the stored
  // qualityScore so the next runJanitor pass MUST persist the corrected value.
  await store.addSession(
    makeSession({
      id: 'q1',
      summary: 'a richly described feature with bcrypt and salt rotation',
      observationType: 'feature',
      decisions: ['rotate the salt every 30 days'],
      decisionEvidence: [[{ kind: 'file_edit', filePath: 'src/auth.ts' } as any]],
      keyFiles: ['src/auth.ts'],
      keyTopics: ['auth'],
      rawEventCount: 20,
      compressorMode: 'lm',
    }),
  );
  // Force a drift between the stored score and what scoreSessionQuality will
  // re-derive — but stay above the floor so no flag flip occurs.
  const s = store.getById('q1')!;
  s.qualityScore = (s.qualityScore ?? 0.9) - 0.01;

  let flushCalls = 0;
  const originalFlush = store.flush.bind(store);
  store.flush = async () => {
    flushCalls += 1;
    await originalFlush();
  };

  await runJanitor(store, { qualityFloor: 0.0, pruneAfterDays: 0 });
  assert.equal(flushCalls, 1, `expected exactly one flush call, got ${flushCalls}`);
});
