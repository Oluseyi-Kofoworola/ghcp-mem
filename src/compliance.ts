/**
 * Compliance / audit report.
 *
 * Phase 7 enterprise-posture surface: in one shot, tell a developer (or
 * a security reviewer) exactly what state their local memory store is
 * in — how much is captured, how much is redacted, how much is verified
 * against the codebase, how the trust signals are distributed, and where
 * the risk-meaningful edges (low confidence, drifted, retracted, conflicts
 * pending) are concentrated.
 *
 * Built entirely from already-stored data — no side effects, no LM calls.
 * Pure module: no vscode imports so the CI gate, MCP server, and chat UI
 * can all consume it the same way.
 */

import { CompressedSession } from './types';
import { effectiveConfidence } from './decay';
import { detectConflicts } from './conflicts';

export interface ComplianceReport {
  generatedAt: string;
  totalSessions: number;
  activeSessions: number;
  retractedSessions: number;
  supersededSessions: number;
  correctionSessions: number;
  /** Sessions with at least one grounded decision (decisionEvidence non-empty). */
  groundedDecisionSessions: number;
  decisionsWithEvidenceCount: number;
  decisionsWithoutEvidenceCount: number;
  /** Percentage of decisions backed by evidence — the core grounding KPI. */
  evidenceCoveragePct: number;
  /** Sessions that carried a keyFileHashes snapshot for SHA-grounded validation. */
  sessionsWithKeyFileHashes: number;
  totalRedactions: number;
  /** Per-compressor-mode count (lm vs fallback). */
  compressorBreakdown: { lm: number; fallback: number; unknown: number };
  /** Sessions whose event log was truncated at compression — confidence haircut. */
  truncatedEventLogs: number;
  /** Mean stored confidence across sessions that carry it. */
  meanStoredConfidence: number | null;
  /** Mean *effective* confidence (decayed) — the value used by the ranker. */
  meanEffectiveConfidence: number | null;
  /** Counts in three confidence buckets — green ≥ 0.75, yellow ≥ 0.5, red < 0.5. */
  confidenceBuckets: { green: number; yellow: number; red: number; unscored: number };
  /** Sessions touched by the reinforcement loop. */
  sessionsWithFeedback: number;
  totalAccepts: number;
  totalRejects: number;
  /** Heuristic conflict warnings raised across the corpus. */
  pendingConflicts: number;
  /** Oldest captured session time (ISO) — for retention-policy review. */
  oldestSessionAt: string | null;
  /** Newest captured session time (ISO). */
  newestSessionAt: string | null;
  /** Custom entity terms currently configured for redaction. */
  customSensitiveEntityCount: number;
  customSensitiveEntityList: string[];
}

export interface ComplianceInputs {
  customSensitiveEntities?: string[];
}

/**
 * Build the report from a session set. Pure — pass the same set you want
 * audited (typically `store.getAllSessions()`) and an optional
 * `customSensitiveEntities` list pulled from VS Code config.
 */
export function buildComplianceReport(
  sessions: CompressedSession[],
  inputs: ComplianceInputs = {},
): ComplianceReport {
  const now = Date.now();

  let active = 0;
  let retracted = 0;
  let superseded = 0;
  let corrections = 0;
  let groundedDecisionSessions = 0;
  let decisionsWithEvidence = 0;
  let decisionsWithoutEvidence = 0;
  let sessionsWithKeyFileHashes = 0;
  let totalRedactions = 0;
  let truncated = 0;
  let lm = 0;
  let fallback = 0;
  let unknownMode = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;
  let effectiveSum = 0;
  let effectiveCount = 0;
  const buckets = { green: 0, yellow: 0, red: 0, unscored: 0 };
  let sessionsWithFeedback = 0;
  let accepts = 0;
  let rejects = 0;
  let oldest = Infinity;
  let newest = -Infinity;

  for (const s of sessions) {
    if (s.retracted) retracted++;
    else active++;
    if (s.supersededBy) superseded++;
    if (s.correctionOf) corrections++;

    const decisionsCount = s.decisions.length;
    const evidenceCount = (s.decisionEvidence ?? []).filter((ev) => ev.length > 0).length;
    decisionsWithEvidence += evidenceCount;
    decisionsWithoutEvidence += Math.max(0, decisionsCount - evidenceCount);
    if (evidenceCount > 0) groundedDecisionSessions++;
    if (s.keyFileHashes && Object.keys(s.keyFileHashes).length > 0) sessionsWithKeyFileHashes++;

    totalRedactions += s.redactionCount ?? 0;
    if (s.eventLogTruncated) truncated++;

    if (s.compressorMode === 'lm') lm++;
    else if (s.compressorMode === 'fallback') fallback++;
    else unknownMode++;

    if (typeof s.confidence === 'number') {
      confidenceSum += s.confidence;
      confidenceCount++;
      const eff = effectiveConfidence(s, now) ?? s.confidence;
      effectiveSum += eff;
      effectiveCount++;
      if (eff >= 0.75) buckets.green++;
      else if (eff >= 0.5) buckets.yellow++;
      else buckets.red++;
    } else {
      buckets.unscored++;
    }

    const u = s.usage;
    if (u && u.retrieved + u.accepted + u.rejected > 0) sessionsWithFeedback++;
    if (u) {
      accepts += u.accepted;
      rejects += u.rejected;
    }

    if (s.startTime < oldest) oldest = s.startTime;
    if (s.endTime > newest) newest = s.endTime;
  }

  // Recompute heuristic conflicts across the corpus (cheap — O(n²) decision
  // marker scan but bounded by store size).
  const sortedByEnd = [...sessions].sort((a, b) => a.endTime - b.endTime);
  let pendingConflicts = 0;
  for (let i = 1; i < sortedByEnd.length; i++) {
    pendingConflicts += detectConflicts(sortedByEnd[i], sortedByEnd.slice(0, i)).length;
  }

  const totalDecisions = decisionsWithEvidence + decisionsWithoutEvidence;
  const evidenceCoveragePct =
    totalDecisions === 0 ? 0 : Math.round((decisionsWithEvidence / totalDecisions) * 1000) / 10; // one decimal

  const entities = (inputs.customSensitiveEntities ?? [])
    .map((s) => (s ?? '').trim())
    .filter(Boolean);

  return {
    generatedAt: new Date(now).toISOString(),
    totalSessions: sessions.length,
    activeSessions: active,
    retractedSessions: retracted,
    supersededSessions: superseded,
    correctionSessions: corrections,
    groundedDecisionSessions,
    decisionsWithEvidenceCount: decisionsWithEvidence,
    decisionsWithoutEvidenceCount: decisionsWithoutEvidence,
    evidenceCoveragePct,
    sessionsWithKeyFileHashes,
    totalRedactions,
    compressorBreakdown: { lm, fallback, unknown: unknownMode },
    truncatedEventLogs: truncated,
    meanStoredConfidence:
      confidenceCount === 0 ? null : Math.round((confidenceSum / confidenceCount) * 100) / 100,
    meanEffectiveConfidence:
      effectiveCount === 0 ? null : Math.round((effectiveSum / effectiveCount) * 100) / 100,
    confidenceBuckets: buckets,
    sessionsWithFeedback,
    totalAccepts: accepts,
    totalRejects: rejects,
    pendingConflicts,
    oldestSessionAt: oldest === Infinity ? null : new Date(oldest).toISOString(),
    newestSessionAt: newest === -Infinity ? null : new Date(newest).toISOString(),
    customSensitiveEntityCount: entities.length,
    customSensitiveEntityList: entities,
  };
}

/**
 * Render the report as a chat-friendly markdown block.
 */
export function renderComplianceReport(r: ComplianceReport): string {
  const lines: string[] = [];
  lines.push(`## 🛡 Baton Compliance Report`);
  lines.push(`_Generated: ${r.generatedAt}_`);
  lines.push('');

  lines.push(`### Store posture`);
  lines.push(
    `- **Total sessions:** ${r.totalSessions} (${r.activeSessions} active, ${r.retractedSessions} retracted, ${r.supersededSessions} superseded, ${r.correctionSessions} correction-rooted)`,
  );
  if (r.oldestSessionAt)
    lines.push(`- **Time range:** ${r.oldestSessionAt} → ${r.newestSessionAt}`);
  lines.push(
    `- **Custom sensitive entities configured:** ${r.customSensitiveEntityCount}${r.customSensitiveEntityCount ? ` (${r.customSensitiveEntityList.map((e) => `\`${e}\``).join(', ')})` : ''}`,
  );
  lines.push('');

  lines.push(`### Grounding`);
  lines.push(
    `- **Evidence coverage:** ${r.evidenceCoveragePct}% of decisions cite at least one piece of evidence (${r.decisionsWithEvidenceCount}/${r.decisionsWithEvidenceCount + r.decisionsWithoutEvidenceCount})`,
  );
  lines.push(`- **Sessions with SHA-anchored key files:** ${r.sessionsWithKeyFileHashes}`);
  lines.push(
    `- **Compressor mode:** ${r.compressorBreakdown.lm} LM · ${r.compressorBreakdown.fallback} fallback · ${r.compressorBreakdown.unknown} legacy`,
  );
  lines.push(`- **Truncated event logs:** ${r.truncatedEventLogs}`);
  lines.push('');

  lines.push(`### Trust distribution`);
  if (r.meanStoredConfidence !== null) {
    lines.push(
      `- **Mean stored / effective confidence:** ${r.meanStoredConfidence.toFixed(2)} / ${r.meanEffectiveConfidence?.toFixed(2)}`,
    );
  }
  lines.push(
    `- **Buckets:** 🟢 ${r.confidenceBuckets.green} · 🟡 ${r.confidenceBuckets.yellow} · 🔴 ${r.confidenceBuckets.red} · ◌ ${r.confidenceBuckets.unscored} unscored`,
  );
  lines.push('');

  lines.push(`### Reinforcement & conflicts`);
  lines.push(`- **Sessions with reinforcement signal:** ${r.sessionsWithFeedback}`);
  lines.push(`- **Total accepts / rejects:** ${r.totalAccepts} 👍 / ${r.totalRejects} 👎`);
  lines.push(
    `- **Heuristic conflicts pending review:** ${r.pendingConflicts}${r.pendingConflicts ? ' — run `@mem /conflicts`' : ''}`,
  );
  lines.push('');

  lines.push(`### Redaction`);
  lines.push(`- **Total redactions applied:** ${r.totalRedactions}`);
  lines.push('');

  return lines.join('\n');
}
