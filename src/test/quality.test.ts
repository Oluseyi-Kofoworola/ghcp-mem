import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSessionQuality } from '../quality';
import { CompressedSession, computeContentHash } from '../types';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const summary = overrides.summary ?? 'sess summary';
  const keyFiles = overrides.keyFiles ?? [];
  const keyTopics = overrides.keyTopics ?? [];
  const decisions = overrides.decisions ?? [];
  const problemsSolved = overrides.problemsSolved ?? [];
  return {
    id: 'q',
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: Date.now(),
    endTime: Date.now(),
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
    compressorMode: overrides.compressorMode,
    decisionEvidence: overrides.decisionEvidence,
    eventLogTruncated: overrides.eventLogTruncated,
  };
}

test('quality — empty/noise session scores low', () => {
  const r = scoreSessionQuality(makeSession({ summary: 'x' }));
  assert.ok(r.score < 0.3, `expected <0.3, got ${r.score}`);
});

test('quality — rich grounded session scores high', () => {
  const r = scoreSessionQuality(
    makeSession({
      summary: 'Refactored auth middleware to use the shared session validator across all routes.',
      observationType: 'refactor',
      decisions: ['use shared validator'],
      decisionEvidence: [[{ eventId: 'e1', kind: 'file_edit' } as any]],
      keyFiles: ['src/auth.ts'],
      keyTopics: ['auth'],
      rawEventCount: 12,
      compressorMode: 'lm',
    }),
  );
  assert.ok(r.score >= 0.8, `expected >=0.8, got ${r.score}`);
});

test('quality — ungrounded decisions do not earn the evidence signal', () => {
  const r = scoreSessionQuality(
    makeSession({
      summary: 'Made a change to the file',
      decisions: ['did a thing'],
      decisionEvidence: [[]],
      rawEventCount: 5,
    }),
  );
  assert.ok(!r.reasons.some((x) => x.includes('hasGroundedDecision')));
});
