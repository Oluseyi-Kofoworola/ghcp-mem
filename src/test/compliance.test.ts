import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComplianceReport, renderComplianceReport } from '../compliance';
import { CompressedSession } from '../types';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const base: CompressedSession = {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: overrides.startTime ?? 1_700_000_000_000,
    endTime: overrides.endTime ?? 1_700_000_100_000,
    summary: 'summary',
    observationType: 'feature',
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
  };
  return { ...base, ...overrides };
}

test('buildComplianceReport — empty corpus yields zeroed report with null bounds', () => {
  const r = buildComplianceReport([]);
  assert.equal(r.totalSessions, 0);
  assert.equal(r.activeSessions, 0);
  assert.equal(r.evidenceCoveragePct, 0);
  assert.equal(r.meanStoredConfidence, null);
  assert.equal(r.meanEffectiveConfidence, null);
  assert.equal(r.oldestSessionAt, null);
  assert.equal(r.newestSessionAt, null);
  assert.equal(r.pendingConflicts, 0);
});

test('buildComplianceReport — mixed corpus counts active/retracted/superseded correctly', () => {
  const sessions: CompressedSession[] = [
    makeSession({ id: 'a', retracted: true }),
    makeSession({ id: 'b', supersededBy: 'c' }),
    makeSession({ id: 'c', correctionOf: 'b' }),
    makeSession({ id: 'd' }),
  ];
  const r = buildComplianceReport(sessions);
  assert.equal(r.totalSessions, 4);
  assert.equal(r.retractedSessions, 1);
  assert.equal(r.activeSessions, 3);
  assert.equal(r.supersededSessions, 1);
  assert.equal(r.correctionSessions, 1);
});

test('buildComplianceReport — evidence coverage percentage uses one decimal', () => {
  const s1 = makeSession({
    id: 's1',
    decisions: ['d1', 'd2', 'd3'],
    decisionEvidence: [[{ kind: 'file_edit', filePath: 'x.ts' }], [], []],
  });
  const s2 = makeSession({
    id: 's2',
    decisions: ['d1'],
    decisionEvidence: [[{ kind: 'file_edit', filePath: 'y.ts' }]],
  });
  const r = buildComplianceReport([s1, s2]);
  assert.equal(r.decisionsWithEvidenceCount, 2);
  assert.equal(r.decisionsWithoutEvidenceCount, 2);
  assert.equal(r.evidenceCoveragePct, 50);
  assert.equal(r.groundedDecisionSessions, 2);
});

test('buildComplianceReport — confidence bucketing: green/yellow/red/unscored', () => {
  const now = Date.now();
  const sessions: CompressedSession[] = [
    makeSession({ id: 'green', confidence: 0.9, endTime: now }),
    makeSession({ id: 'yellow', confidence: 0.6, endTime: now }),
    makeSession({ id: 'red', confidence: 0.3, endTime: now }),
    makeSession({ id: 'unscored' }),
  ];
  const r = buildComplianceReport(sessions);
  assert.equal(r.confidenceBuckets.green, 1);
  assert.equal(r.confidenceBuckets.yellow, 1);
  assert.equal(r.confidenceBuckets.red, 1);
  assert.equal(r.confidenceBuckets.unscored, 1);
  assert.equal(r.meanStoredConfidence, 0.6);
});

test('buildComplianceReport — compressor breakdown sums correctly', () => {
  const sessions: CompressedSession[] = [
    makeSession({ compressorMode: 'lm' }),
    makeSession({ compressorMode: 'lm' }),
    makeSession({ compressorMode: 'fallback' }),
    makeSession({}),
  ];
  const r = buildComplianceReport(sessions);
  assert.equal(r.compressorBreakdown.lm, 2);
  assert.equal(r.compressorBreakdown.fallback, 1);
  assert.equal(r.compressorBreakdown.unknown, 1);
});

test('buildComplianceReport — feedback aggregation and oldest/newest bounds', () => {
  const sessions: CompressedSession[] = [
    makeSession({
      startTime: 100,
      endTime: 200,
      usage: { retrieved: 5, accepted: 3, rejected: 1, lastRetrievedAt: 200 },
    }),
    makeSession({
      startTime: 50,
      endTime: 300,
      usage: { retrieved: 1, accepted: 0, rejected: 2, lastRetrievedAt: 300 },
    }),
  ];
  const r = buildComplianceReport(sessions);
  assert.equal(r.totalAccepts, 3);
  assert.equal(r.totalRejects, 3);
  assert.equal(r.sessionsWithFeedback, 2);
  assert.equal(r.oldestSessionAt, new Date(50).toISOString());
  assert.equal(r.newestSessionAt, new Date(300).toISOString());
});

test('buildComplianceReport — custom sensitive entities passed through', () => {
  const r = buildComplianceReport([], {
    customSensitiveEntities: ['AcmeCorp', ' Hydra ', '', 'Spire'],
  });
  assert.equal(r.customSensitiveEntityCount, 3);
  assert.deepEqual(r.customSensitiveEntityList, ['AcmeCorp', 'Hydra', 'Spire']);
});

test('renderComplianceReport — produces a markdown block with key headings', () => {
  const r = buildComplianceReport([makeSession({ confidence: 0.8 })]);
  const md = renderComplianceReport(r);
  assert.ok(md.includes('## 🛡 GHCP-MEM Compliance Report'));
  assert.ok(md.includes('### Store posture'));
  assert.ok(md.includes('### Grounding'));
  assert.ok(md.includes('### Trust distribution'));
  assert.ok(md.includes('### Reinforcement & conflicts'));
});
