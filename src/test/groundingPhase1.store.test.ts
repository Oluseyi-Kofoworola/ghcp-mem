/**
 * Phase 1 grounding tests — ContextStore retrieval + renderer surfaces.
 *
 * Uses the default __mocks__/vscode shim (EventEmitter, InMemoryMemento, ...)
 * so we can construct a real ContextStore. Compressor tests live in the
 * sibling file groundingPhase1.test.ts (they shadow vscode for LM mocking).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMemento } from './__mocks__/vscode';
import { ContextStore } from '../contextStore';
import { CompressedSession, Evidence, computeContentHash } from '../types';
import { renderTrustBadge, renderClaimList } from '../contextProvider';

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
  if (overrides.embedding !== undefined) base.embedding = overrides.embedding;
  return base;
}

// ─── Soft union retrieval ───────────────────────────────────────────────────

test('ContextStore.search — soft union returns matches even when one term is rare', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(
    makeSession({
      summary: 'auth refactor session',
      keyTopics: ['authentication'],
    }),
  );
  // Old hard-intersection behaviour: this would return [] because the rare
  // term zeroes the set. Soft union should still surface the auth session.
  const results = store.search('auth supercalifragilistic', {}, 5);
  assert.equal(results.length, 1, 'rare-term miss must not zero recall');
});

test('ContextStore.search — match ratio rewards higher term coverage', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const now = Date.now();
  await store.addSession(
    makeSession({
      id: 'A',
      summary: 'auth jwt rework',
      keyTopics: ['authentication', 'jwt'],
      endTime: now,
    }),
  );
  await store.addSession(
    makeSession({
      id: 'B',
      summary: 'auth tweak only',
      keyTopics: ['authentication'],
      endTime: now,
    }),
  );
  const results = store.search('auth jwt', {}, 5);
  assert.equal(results[0].id, 'A', 'session matching more query terms must rank first');
});

test('ContextStore.search — confidence nudges ranking when other signals tie', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const now = Date.now();
  // Two sessions, identical on every retrieval signal except confidence.
  await store.addSession(
    makeSession({
      id: 'high',
      summary: 'auth refactor',
      keyTopics: ['authentication'],
      endTime: now,
      confidence: 0.95,
    }),
  );
  await store.addSession(
    makeSession({
      id: 'low',
      summary: 'auth refactor',
      keyTopics: ['authentication'],
      endTime: now,
      confidence: 0.1,
    }),
  );
  const results = store.search('auth', {}, 5);
  assert.equal(results[0].id, 'high', 'higher-confidence session must outrank lower');
});

// ─── Renderer surfaces ──────────────────────────────────────────────────────

test('renderTrustBadge — emoji mapping matches thresholds', () => {
  assert.equal(renderTrustBadge(makeSession({ confidence: 0.9 })), ' · 🟢 conf:0.90');
  assert.equal(renderTrustBadge(makeSession({ confidence: 0.6 })), ' · 🟡 conf:0.60');
  assert.equal(renderTrustBadge(makeSession({ confidence: 0.2 })), ' · 🔴 conf:0.20');
});

test('renderTrustBadge — legacy session without confidence renders empty (no badge)', () => {
  const legacy = makeSession();
  delete (legacy as any).confidence;
  assert.equal(renderTrustBadge(legacy), '');
});

test('renderClaimList — appends evidence file paths when present', () => {
  const ev: Evidence[][] = [
    [
      { kind: 'file_edit', filePath: 'src/a.ts' },
      { kind: 'file_edit', filePath: 'src/b.ts' },
    ],
  ];
  const out = renderClaimList(['real decision'], ev);
  assert.match(out, /real decision \[📎 src\/a\.ts, src\/b\.ts\]/);
});

test('renderClaimList — falls back to plain text without evidence', () => {
  assert.equal(renderClaimList(['legacy'], undefined), 'legacy');
});
