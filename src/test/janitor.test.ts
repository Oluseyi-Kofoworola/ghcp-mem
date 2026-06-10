import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryMemento } from './__mocks__/vscode';
import { ContextStore } from '../contextStore';
import { CompressedSession, computeContentHash } from '../types';
import { runJanitor } from '../janitor';

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
  await store.addSession(
    makeSession({ id: 'stale', summary: 'x', startTime: old, endTime: old }),
  );
  const report = await runJanitor(store, { qualityFloor: 0.3, pruneAfterDays: 14 });
  assert.equal(report.pruned, 1);
  assert.equal(store.getById('stale'), undefined);
});
