import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHealth, fillGlyph } from '../health';
import { CompressedSession, computeContentHash } from '../types';

function mk(o: Partial<CompressedSession> = {}): CompressedSession {
  const summary = o.summary ?? 'demo';
  const keyFiles = o.keyFiles ?? ['a.ts'];
  const keyTopics = o.keyTopics ?? ['t'];
  const decisions = o.decisions ?? [];
  const problemsSolved = o.problemsSolved ?? [];
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: o.startTime ?? Date.now() - 1000,
    endTime: o.endTime ?? Date.now(),
    summary,
    observationType: o.observationType ?? 'unknown',
    keyFiles,
    keyTopics,
    decisions,
    problemsSolved,
    rawEventCount: 1,
    userTags: o.userTags ?? [],
    redactionCount: o.redactionCount ?? 0,
    contentHash:
      o.contentHash ??
      computeContentHash({ summary, keyFiles, keyTopics, decisions, problemsSolved }),
    azureContext: o.azureContext,
  };
}

test('computeHealth — empty store yields score 0 and max headroom', () => {
  const h = computeHealth([]);
  assert.equal(h.score, 0);
  assert.equal(h.totalSessions, 0);
  assert.equal(h.retentionHeadroomPct, 100);
});

test('computeHealth — typed+tagged+clean sessions score high', () => {
  const sessions: CompressedSession[] = [
    mk({ observationType: 'feature', userTags: ['alpha'], redactionCount: 0 }),
    mk({ observationType: 'bugfix', userTags: ['alpha'], redactionCount: 0 }),
    mk({ observationType: 'infra', userTags: ['alpha'], redactionCount: 0 }),
  ];
  const h = computeHealth(sessions);
  assert.ok(h.score >= 70, `expected score >=70, got ${h.score}`);
  assert.equal(h.typedPct, 100);
  assert.equal(h.taggedPct, 100);
  assert.equal(h.redactionCoveragePct, 0);
});

test('computeHealth — high secret incidence adds advisory note', () => {
  const sessions: CompressedSession[] = [
    mk({ observationType: 'feature', userTags: ['alpha'], redactionCount: 2 }),
    mk({ observationType: 'bugfix', userTags: ['alpha'], redactionCount: 1 }),
    mk({ observationType: 'infra', userTags: ['alpha'], redactionCount: 4 }),
  ];
  const h = computeHealth(sessions);
  assert.equal(h.redactionCoveragePct, 100);
  assert.ok(h.notes.some((n) => n.includes('High secret incidence')));
});

test('computeHealth — unknown+untagged sessions score low', () => {
  const sessions: CompressedSession[] = [
    mk({ observationType: 'unknown', userTags: [] }),
    mk({ observationType: 'unknown', userTags: [] }),
  ];
  const h = computeHealth(sessions);
  assert.ok(h.typedPct === 0);
  assert.ok(h.taggedPct === 0);
  assert.ok(h.notes.length > 0);
});

test('computeHealth — azure sessions counted', () => {
  const sessions: CompressedSession[] = [
    mk({ azureContext: { subscriptionName: 'sub', subsystems: ['azd'] } as any }),
    mk({ userTags: ['azure'] }),
    mk({}),
  ];
  const h = computeHealth(sessions);
  assert.equal(h.azureSessionCount, 2);
});

test('fillGlyph — produces 5-char indicator scaled to capacity', () => {
  assert.equal(fillGlyph(0, 10), '○○○○○');
  assert.equal(fillGlyph(10, 10), '●●●●●');
  assert.equal(fillGlyph(5, 10), '●●●○○'); // 0.5 * 5 = 2.5 → round to 3
});
