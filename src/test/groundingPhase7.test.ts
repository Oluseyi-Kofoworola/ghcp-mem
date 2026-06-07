/**
 * Phase 7 tests — MCP parity tools (declaration shape only — handler
 * behaviour for entity/snippets/conflicts/lineage/explain/graph is already
 * covered by their respective pure-function tests in Phase 3-6 suites) +
 * compliance/audit report numeric correctness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../mcpServer';
import { buildComplianceReport, renderComplianceReport } from '../compliance';
import { CompressedSession, Evidence, computeContentHash } from '../types';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const summary = overrides.summary ?? 's';
  const keyFiles = overrides.keyFiles ?? ['src/foo.ts'];
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
  if (overrides.compressorMode !== undefined) base.compressorMode = overrides.compressorMode;
  if (overrides.supersedes !== undefined) base.supersedes = overrides.supersedes;
  if (overrides.supersededBy !== undefined) base.supersededBy = overrides.supersededBy;
  if (overrides.correctionOf !== undefined) base.correctionOf = overrides.correctionOf;
  if (overrides.retracted !== undefined) base.retracted = overrides.retracted;
  if (overrides.decisionEvidence !== undefined) base.decisionEvidence = overrides.decisionEvidence;
  if (overrides.problemEvidence !== undefined) base.problemEvidence = overrides.problemEvidence;
  if (overrides.keyFileHashes !== undefined) base.keyFileHashes = overrides.keyFileHashes;
  if (overrides.eventLogTruncated !== undefined)
    base.eventLogTruncated = overrides.eventLogTruncated;
  if (overrides.usage !== undefined) base.usage = { ...overrides.usage };
  return base;
}

// ─── MCP catalog shape ───────────────────────────────────────────────────────

test('mcpServer — Phase 7 tools declare object inputSchemas', () => {
  const phase7 = [
    'baton_entity',
    'baton_snippets',
    'baton_conflicts',
    'baton_lineage',
    'baton_explain',
    'baton_graph',
  ];
  for (const name of phase7) {
    const tool = TOOLS.find((t) => t.name === name);
    assert.ok(tool, `tool ${name} must be declared in TOOLS`);
    assert.equal(tool!.inputSchema.type, 'object');
    assert.ok(
      typeof tool!.description === 'string' && tool!.description.length > 20,
      `tool ${name} must have a descriptive description (≥20 chars)`,
    );
  }
});

test('mcpServer — baton_entity requires `key`', () => {
  const t = TOOLS.find((t) => t.name === 'baton_entity')!;
  assert.deepEqual(t.inputSchema.required, ['key']);
});

test('mcpServer — baton_snippets requires `query`', () => {
  const t = TOOLS.find((t) => t.name === 'baton_snippets')!;
  assert.deepEqual(t.inputSchema.required, ['query']);
});

test('mcpServer — baton_explain requires `query` and `id`', () => {
  const t = TOOLS.find((t) => t.name === 'baton_explain')!;
  assert.deepEqual(t.inputSchema.required, ['query', 'id']);
});

// ─── Compliance report ──────────────────────────────────────────────────────

test('buildComplianceReport — empty store yields zero counts', () => {
  const r = buildComplianceReport([]);
  assert.equal(r.totalSessions, 0);
  assert.equal(r.activeSessions, 0);
  assert.equal(r.evidenceCoveragePct, 0);
  assert.equal(r.meanStoredConfidence, null);
  assert.equal(r.meanEffectiveConfidence, null);
});

test('buildComplianceReport — counts active vs retracted vs superseded sessions', () => {
  const sessions = [
    makeSession({ id: 'a' }),
    makeSession({ id: 'b', retracted: true }),
    makeSession({ id: 'c', supersededBy: 'a' }),
    makeSession({ id: 'd', correctionOf: 'a' }),
  ];
  const r = buildComplianceReport(sessions);
  assert.equal(r.totalSessions, 4);
  assert.equal(r.activeSessions, 3); // 4 total - 1 retracted
  assert.equal(r.retractedSessions, 1);
  assert.equal(r.supersededSessions, 1);
  assert.equal(r.correctionSessions, 1);
});

test('buildComplianceReport — evidence coverage is decisions-with-evidence / total decisions', () => {
  const ev: Evidence[][] = [[{ kind: 'file_edit', filePath: 'src/a.ts' }]];
  const sessions = [
    makeSession({ id: 'g', decisions: ['grounded'], decisionEvidence: ev }),
    makeSession({ id: 'u', decisions: ['ungrounded one', 'ungrounded two'] }),
  ];
  const r = buildComplianceReport(sessions);
  assert.equal(r.decisionsWithEvidenceCount, 1);
  assert.equal(r.decisionsWithoutEvidenceCount, 2);
  // 1 of 3 = 33.3%
  assert.ok(
    r.evidenceCoveragePct > 33 && r.evidenceCoveragePct < 34,
    `got ${r.evidenceCoveragePct}`,
  );
});

test('buildComplianceReport — compressorBreakdown reflects mode field', () => {
  const sessions = [
    makeSession({ id: 'a', compressorMode: 'lm' }),
    makeSession({ id: 'b', compressorMode: 'lm' }),
    makeSession({ id: 'c', compressorMode: 'fallback' }),
    makeSession({ id: 'd' }), // legacy: undefined mode
  ];
  const r = buildComplianceReport(sessions);
  assert.equal(r.compressorBreakdown.lm, 2);
  assert.equal(r.compressorBreakdown.fallback, 1);
  assert.equal(r.compressorBreakdown.unknown, 1);
});

test('buildComplianceReport — confidence buckets sort by effective confidence', () => {
  const fresh = Date.now();
  const sessions = [
    makeSession({ id: 'g1', confidence: 0.9, endTime: fresh }),
    makeSession({ id: 'g2', confidence: 0.8, endTime: fresh }),
    makeSession({ id: 'y', confidence: 0.6, endTime: fresh }),
    makeSession({ id: 'r', confidence: 0.2, endTime: fresh }),
    makeSession({ id: 'u' }), // no confidence → unscored
  ];
  const r = buildComplianceReport(sessions);
  assert.equal(r.confidenceBuckets.green, 2);
  assert.equal(r.confidenceBuckets.yellow, 1);
  assert.equal(r.confidenceBuckets.red, 1);
  assert.equal(r.confidenceBuckets.unscored, 1);
});

test('buildComplianceReport — counts reinforcement signal usage', () => {
  const sessions = [
    makeSession({ id: 'a', usage: { retrieved: 5, lastRetrievedAt: 0, accepted: 2, rejected: 1 } }),
    makeSession({ id: 'b', usage: { retrieved: 0, lastRetrievedAt: 0, accepted: 0, rejected: 0 } }),
    makeSession({ id: 'c' }),
  ];
  const r = buildComplianceReport(sessions);
  assert.equal(r.sessionsWithFeedback, 1);
  assert.equal(r.totalAccepts, 2);
  assert.equal(r.totalRejects, 1);
});

test('buildComplianceReport — custom entities propagate', () => {
  const r = buildComplianceReport([], {
    customSensitiveEntities: ['Project Hydra', '', '  ', 'AcmeCorp'],
  });
  assert.equal(r.customSensitiveEntityCount, 2);
  assert.deepEqual(r.customSensitiveEntityList, ['Project Hydra', 'AcmeCorp']);
});

test('buildComplianceReport — pendingConflicts reflects heuristic detection', () => {
  const sessions = [
    makeSession({
      id: 'old',
      summary: 'a',
      decisions: ['use cookies'],
      keyFiles: ['src/auth.ts'],
      keyTopics: ['authentication'],
      endTime: Date.now() - 60_000,
    }),
    makeSession({
      id: 'new',
      summary: 'b',
      decisions: ['use JWT instead of cookies'],
      keyFiles: ['src/auth.ts'],
      keyTopics: ['authentication'],
      endTime: Date.now(),
    }),
  ];
  const r = buildComplianceReport(sessions);
  assert.ok(r.pendingConflicts >= 1, `expected ≥1 conflict, got ${r.pendingConflicts}`);
});

test('renderComplianceReport — emits the major sections', () => {
  const r = buildComplianceReport([makeSession({ id: 'x', confidence: 0.8 })]);
  const md = renderComplianceReport(r);
  assert.match(md, /Compliance Report/);
  assert.match(md, /Store posture/);
  assert.match(md, /Grounding/);
  assert.match(md, /Trust distribution/);
  assert.match(md, /Reinforcement & conflicts/);
  assert.match(md, /Redaction/);
});
