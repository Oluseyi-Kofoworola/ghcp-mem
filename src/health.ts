import { CompressedSession, getConfig } from './types';

export interface HealthScore {
  /** 0-100 composite score. */
  score: number;
  redactionCoveragePct: number;
  /**
   * Fraction of sessions that are exact-content duplicates (0 = no dups = healthy).
   * Stored as a ratio 0–1 so callers can multiply by 100 for display.
   */
  dedupRatio: number;
  taggedPct: number;
  retentionHeadroomPct: number;
  azureSessionCount: number;
  typedPct: number;
  totalSessions: number;
  /** Fill glyph like ●●●○○ scaled to maxStoredSessions. */
  densityGlyph: string;
  notes: string[];
}

/**
 * Compute a health score summarising memory quality.
 *
 * Composite weighting:
 *   - secretHygienePct      (20%) — inverse of secret incidence (fewer redaction hits => healthier)
 *   - typedPct              (15%) — proportion of sessions with a non-unknown observationType
 *   - taggedPct             (10%) — proportion with at least one userTag
 *   - dedupRatio            (20%) — 1 - (unique contentHash / total). Higher is better (more dedup = healthier).
 *                                   Actually we want LOW dup rate = healthy, so we invert: dedupHealth = 1 - duplicatesPct
 *   - retentionHeadroomPct  (20%) — 1 - (stored / maxStoredSessions). Higher = more room left.
 *   - freshness             (15%) — fraction of sessions in the last 30 days.
 */
export function computeHealth(sessions: CompressedSession[]): HealthScore {
  const config = getConfig();
  const total = sessions.length;
  const notes: string[] = [];

  if (total === 0) {
    return {
      score: 0,
      redactionCoveragePct: 0,
      dedupRatio: 0,
      taggedPct: 0,
      retentionHeadroomPct: 100,
      azureSessionCount: 0,
      typedPct: 0,
      totalSessions: 0,
      densityGlyph: fillGlyph(0, config.maxStoredSessions || 1),
      notes: ['No sessions stored yet.'],
    };
  }

  const redacted = sessions.filter((s) => (s.redactionCount ?? 0) > 0).length;
  const typed = sessions.filter((s) => s.observationType !== 'unknown').length;
  const tagged = sessions.filter((s) => (s.userTags ?? []).length > 0).length;
  const azure = sessions.filter(
    (s) => !!s.azureContext || (s.userTags ?? []).includes('azure'),
  ).length;

  const redactionCoveragePct = pct(redacted, total);
  // We still expose redactionCoveragePct for transparency, but for health we
  // score inverse incidence so "fewer leaked secrets observed" is better.
  const secretHygienePct = 100 - redactionCoveragePct;
  const typedPct = pct(typed, total);
  const taggedPct = pct(tagged, total);

  // Dedup health: proportion of DISTINCT content hashes. Missing hash counts as unique (worst case).
  const hashes = new Set<string>();
  for (const s of sessions) hashes.add(s.contentHash ?? s.id);
  // dedupRatio: proportion of sessions that are exact-content duplicates.
  // 0 = no duplicates = healthiest. 1 = everything is a duplicate.
  const dedupRatio = Math.round((1 - hashes.size / total) * 100) / 100;

  const retentionHeadroomPct = Math.max(
    0,
    Math.min(100, 100 - Math.round((total / Math.max(1, config.maxStoredSessions || 50)) * 100)),
  );

  const now = Date.now();
  const THIRTY_D = 30 * 24 * 60 * 60 * 1000;
  const recent = sessions.filter((s) => now - s.endTime < THIRTY_D).length;
  const freshnessPct = pct(recent, total);

  // Weights sum to 100.
  const score = Math.round(
    secretHygienePct * 0.2 +
      typedPct * 0.15 +
      taggedPct * 0.1 +
      100 * (1 - (total - hashes.size) / total) * 0.2 + // "no dup" health
      retentionHeadroomPct * 0.2 +
      freshnessPct * 0.15,
  );

  if (redactionCoveragePct > 40)
    notes.push(
      'High secret incidence detected in captured events — consider expanding excludeGlobs/private tags.',
    );
  if (typedPct < 60)
    notes.push('Many sessions are type:unknown — LM classifier may be skipped or offline.');
  if (retentionHeadroomPct < 20)
    notes.push('Nearing maxStoredSessions — consider raising or tagging for retention.');
  if (dedupRatio > 0.15)
    notes.push(
      `${Math.round(dedupRatio * 100)}% of sessions were dedup-merged — consider larger compression windows.`,
    );
  if (recent === 0) notes.push('No sessions in the last 30 days.');

  return {
    score: Math.max(0, Math.min(100, score)),
    redactionCoveragePct,
    dedupRatio,
    taggedPct,
    retentionHeadroomPct,
    azureSessionCount: azure,
    typedPct,
    totalSessions: total,
    densityGlyph: fillGlyph(total, config.maxStoredSessions || 50),
    notes,
  };
}

function pct(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((num / denom) * 100);
}

/** ●●●○○ style filled/empty glyph representing fraction filled (5 segments). */
export function fillGlyph(used: number, capacity: number, segments = 5): string {
  const frac = Math.max(0, Math.min(1, used / Math.max(1, capacity)));
  const filled = Math.round(frac * segments);
  return '●'.repeat(filled) + '○'.repeat(segments - filled);
}

export function formatHealthMarkdown(h: HealthScore): string {
  const lines: string[] = [
    `# GHCP-MEM Health: ${h.score}/100  ${h.densityGlyph}`,
    '',
    `- **Total sessions:** ${h.totalSessions}`,
    `- **Redaction coverage:** ${h.redactionCoveragePct}%`,
    `- **Typed (non-unknown):** ${h.typedPct}%`,
    `- **Tagged:** ${h.taggedPct}%`,
    `- **Dedup merge rate:** ${Math.round(h.dedupRatio * 100)}%`,
    `- **Retention headroom:** ${h.retentionHeadroomPct}%`,
    `- **Azure-enriched sessions:** ${h.azureSessionCount}`,
  ];
  if (h.notes.length) {
    lines.push('', '## Notes');
    for (const n of h.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}
