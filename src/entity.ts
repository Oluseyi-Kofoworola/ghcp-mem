/**
 * Entity aggregation layer.
 *
 * An "entity" here is a file path or LSP symbol identifier (e.g.
 * `src/auth.ts` or `src/auth.ts#hashPassword`). Aggregating sessions
 * that touch the same entity gives developers a one-shot view of every
 * decision, problem, and contributor for a particular slice of code —
 * without having to scan dozens of session cards.
 *
 * The entity layer is a derived view, NOT a separate storage table:
 *   - No schema migration: builds from existing CompressedSessions.
 *   - No invalidation pain: always recomputed on demand.
 *   - Cheap: O(n) over the candidate session set, then O(decisions) for
 *     the rollup. Well within retrieval-budget territory.
 *
 * Used by:
 *   - `@mem /entity <key>` chat command (renders a focused summary)
 *   - Multi-hop retrieval (lifts entity context onto top search results)
 */

import { CompressedSession, Evidence } from './types';

/** Which kind of identifier the entity key represents. */
export type EntityKind = 'file' | 'symbol';

/** A single decision/problem rolled up with its source session for citation. */
export interface EntityClaim {
  text: string;
  sessionId: string;
  /** Workspace-relative timestamp of the session that emitted this claim. */
  emittedAt: number;
  evidence?: Evidence[];
}

/**
 * Aggregated view of every session that touched a single file or symbol.
 *
 * Returned by `buildEntityRecord`. Renderers consume this and present a
 * compact "everything we know about X" summary.
 */
export interface EntityRecord {
  key: string;
  kind: EntityKind;
  sessionCount: number;
  firstSeenAt: number;
  lastTouchedAt: number;
  /** Map of observationType -> session count for that type. */
  observationTypes: Record<string, number>;
  decisions: EntityClaim[];
  problems: EntityClaim[];
  /** Top topics that co-occur with this entity, ranked by frequency. */
  topTopics: string[];
  /** Sessions that touched this entity, newest first. */
  sessions: Array<{
    id: string;
    summary: string;
    endTime: number;
    confidence?: number;
    retracted?: boolean;
    supersededBy?: string;
  }>;
  /**
   * Supersession lineage for the entity's most recent non-retracted
   * decision-bearing session, expressed as session IDs in
   * oldest → newest order. Empty array when no lineage exists.
   */
  decisionLineage: string[];
  /** True when no live (non-retracted, non-superseded) session remains. */
  allSupersededOrRetracted: boolean;
}

/**
 * Determine whether a session touches the given entity key.
 *
 * For `kind: 'file'`: matches any keyFile that ends with the key (so callers
 * can pass either a workspace-relative path or just a basename and still hit).
 *
 * For `kind: 'symbol'`: matches when ANY decisionEvidence/problemEvidence
 * entry carries a matching `symbolId`. Symbols never match by key file alone
 * because key files are too coarse.
 */
export function sessionTouchesEntity(s: CompressedSession, key: string, kind: EntityKind): boolean {
  if (!key) return false;
  if (kind === 'file') {
    const normalized = key.replace(/\\/g, '/').toLowerCase();
    return s.keyFiles.some(
      (f) =>
        f.replace(/\\/g, '/').toLowerCase() === normalized ||
        f
          .replace(/\\/g, '/')
          .toLowerCase()
          .endsWith('/' + normalized) ||
        f.replace(/\\/g, '/').toLowerCase().endsWith(normalized),
    );
  }
  // symbol
  const target = key.toLowerCase();
  const allEvidence: Evidence[][] = [...(s.decisionEvidence ?? []), ...(s.problemEvidence ?? [])];
  return allEvidence.some((evList) =>
    evList.some((ev) => (ev.symbolId ?? '').toLowerCase() === target),
  );
}

/**
 * Build an EntityRecord for the given key. Returns undefined when no
 * stored session touches the entity (so callers can render a polite
 * "no memory of X" message rather than an empty card).
 */
export function buildEntityRecord(
  key: string,
  allSessions: CompressedSession[],
  opts: { kind?: EntityKind } = {},
): EntityRecord | undefined {
  // Infer kind from the key shape when not provided: anything with '#' is
  // a symbol ID, otherwise treat as a file path.
  const kind: EntityKind = opts.kind ?? (key.includes('#') ? 'symbol' : 'file');

  const matches = allSessions.filter((s) => sessionTouchesEntity(s, key, kind));
  if (matches.length === 0) return undefined;

  const decisions: EntityClaim[] = [];
  const problems: EntityClaim[] = [];
  const topicCounts = new Map<string, number>();
  const observationTypes: Record<string, number> = {};

  let firstSeenAt = Infinity;
  let lastTouchedAt = -Infinity;

  for (const s of matches) {
    if (s.startTime < firstSeenAt) firstSeenAt = s.startTime;
    if (s.endTime > lastTouchedAt) lastTouchedAt = s.endTime;
    observationTypes[s.observationType] = (observationTypes[s.observationType] ?? 0) + 1;
    for (const t of s.keyTopics) {
      topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
    }
    s.decisions.forEach((text, i) => {
      decisions.push({
        text,
        sessionId: s.id,
        emittedAt: s.endTime,
        evidence: s.decisionEvidence?.[i],
      });
    });
    s.problemsSolved.forEach((text, i) => {
      problems.push({
        text,
        sessionId: s.id,
        emittedAt: s.endTime,
        evidence: s.problemEvidence?.[i],
      });
    });
  }

  // Sort decisions newest-first so the most recent rationale is the head.
  decisions.sort((a, b) => b.emittedAt - a.emittedAt);
  problems.sort((a, b) => b.emittedAt - a.emittedAt);

  // Top 6 topics by frequency, stable tie-break by name for determinism.
  const topTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([t]) => t);

  // Compute the lineage of the newest live decision-bearing session.
  const sessionsByIdLocal = new Map<string, CompressedSession>();
  for (const s of allSessions) sessionsByIdLocal.set(s.id, s);
  const liveDecisionBearing = [...matches]
    .filter((s) => !s.retracted && !s.supersededBy && s.decisions.length > 0)
    .sort((a, b) => b.endTime - a.endTime)[0];
  const decisionLineage = liveDecisionBearing
    ? walkSupersedesChain(liveDecisionBearing.id, sessionsByIdLocal).map((s) => s.id)
    : [];

  const allSupersededOrRetracted = matches.every((s) => s.retracted || !!s.supersededBy);

  const sessionsSummary = matches
    .slice()
    .sort((a, b) => b.endTime - a.endTime)
    .map((s) => ({
      id: s.id,
      summary: s.summary,
      endTime: s.endTime,
      confidence: s.confidence,
      retracted: s.retracted,
      supersededBy: s.supersededBy,
    }));

  return {
    key,
    kind,
    sessionCount: matches.length,
    firstSeenAt: firstSeenAt === Infinity ? 0 : firstSeenAt,
    lastTouchedAt: lastTouchedAt === -Infinity ? 0 : lastTouchedAt,
    observationTypes,
    decisions: decisions.slice(0, 8),
    problems: problems.slice(0, 8),
    topTopics,
    sessions: sessionsSummary,
    decisionLineage,
    allSupersededOrRetracted,
  };
}

/**
 * Walk the supersedes chain starting from `id` back to the original. Returns
 * sessions in oldest → newest order so a renderer can show the lineage as
 * "A → B → C → (current)".
 *
 * Defensive against cycles: walks at most 64 hops, breaks on revisited IDs.
 *
 * Exported separately so the multi-hop retrieval helper can reuse it on
 * arbitrary session IDs without going through buildEntityRecord.
 */
export function walkSupersedesChain(
  id: string,
  sessionsById: Map<string, CompressedSession>,
): CompressedSession[] {
  const chain: CompressedSession[] = [];
  const seen = new Set<string>();
  let cursor = sessionsById.get(id);
  // Walk backwards via `supersedes`.
  while (cursor && !seen.has(cursor.id) && chain.length < 64) {
    chain.unshift(cursor);
    seen.add(cursor.id);
    if (!cursor.supersedes) break;
    cursor = sessionsById.get(cursor.supersedes);
  }
  return chain;
}

/**
 * Render an EntityRecord as markdown for chat/inspector display.
 *
 * Layout:
 *   ## 📦 Entity: <key>
 *   stats line · type breakdown
 *   ### 🟢 Current decision lineage (when present)
 *   ### Decisions / Problems / Topics
 *   ### Recent sessions
 */
export function renderEntityMarkdown(rec: EntityRecord): string {
  const lines: string[] = [];
  const kindIcon = rec.kind === 'symbol' ? '🔣' : '📄';
  lines.push(`## ${kindIcon} Entity: \`${rec.key}\``);
  lines.push('');
  lines.push(
    `**Sessions:** ${rec.sessionCount} · **First seen:** ${new Date(rec.firstSeenAt).toLocaleDateString()} · **Last touched:** ${new Date(rec.lastTouchedAt).toLocaleDateString()}`,
  );
  const typeBreakdown = Object.entries(rec.observationTypes)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}:${n}`)
    .join(' · ');
  if (typeBreakdown) lines.push(`**Activity:** ${typeBreakdown}`);
  if (rec.allSupersededOrRetracted) {
    lines.push('');
    lines.push(
      '> ⚠️ Every session for this entity is retracted or superseded — treat memory as stale.',
    );
  }
  lines.push('');

  if (rec.decisionLineage.length > 1) {
    const links = rec.decisionLineage.map((id) => `\`${id.substring(0, 8)}\``).join(' → ');
    lines.push(`### 🧭 Decision lineage`);
    lines.push(links + '  *(oldest → current)*');
    lines.push('');
  }

  if (rec.decisions.length) {
    lines.push(`### 🧠 Decisions (${rec.decisions.length})`);
    for (const d of rec.decisions) {
      const files = (d.evidence ?? [])
        .map((e) => e.filePath)
        .filter((f): f is string => !!f)
        .slice(0, 2);
      const fileTail = files.length ? ` [📎 ${files.join(', ')}]` : '';
      lines.push(`- ${d.text} _(from \`${d.sessionId.substring(0, 8)}\`)_${fileTail}`);
    }
    lines.push('');
  }

  if (rec.problems.length) {
    lines.push(`### 🛠 Problems Solved (${rec.problems.length})`);
    for (const p of rec.problems) {
      lines.push(`- ${p.text} _(from \`${p.sessionId.substring(0, 8)}\`)_`);
    }
    lines.push('');
  }

  if (rec.topTopics.length) {
    lines.push(`### 🏷 Topics`);
    lines.push(rec.topTopics.map((t) => `\`${t}\``).join(' · '));
    lines.push('');
  }

  if (rec.sessions.length) {
    lines.push(`### 📜 Recent sessions`);
    for (const s of rec.sessions.slice(0, 5)) {
      const ts = new Date(s.endTime).toLocaleString();
      const conf = typeof s.confidence === 'number' ? ` · conf ${s.confidence.toFixed(2)}` : '';
      const tags = [
        s.retracted ? '🚫 retracted' : '',
        s.supersededBy ? `⤴ superseded by \`${s.supersededBy.substring(0, 8)}\`` : '',
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(`- \`${s.id.substring(0, 8)}\` · ${ts}${conf}${tags ? ' · ' + tags : ''}`);
      lines.push(`  > ${s.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
