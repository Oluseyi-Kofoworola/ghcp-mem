/**
 * Heuristic conflict detection.
 *
 * Goal: flag the moment a newly-captured session emits a decision that
 * appears to contradict an older one — without making a costly LM call on
 * every write. We do this with two cheap signals:
 *
 *   1. Contradiction MARKERS in the new decision text:
 *        "instead of", "no longer", "switched from", "deprecated",
 *        "replaced", "abandoned", "rolling back", "reverted from", "moved away from"
 *      These are the natural English ways developers describe a U-turn.
 *      Hits indicate the new decision is explicitly overturning prior state.
 *
 *   2. SHARED-CONTEXT candidates: older sessions that share at least one
 *      key file OR keyTopic with the new session AND were emitted before
 *      it AND carry at least one decision of their own. These are the
 *      sessions that COULD be the thing the new decision is overturning.
 *
 * When both signals are present we record a `ConflictWarning` keyed by
 * the new session ID. The store exposes these warnings via the
 * `/conflicts` chat command and a `pendingConflictsCount` accessor so
 * the inspector panel can badge them.
 *
 * We deliberately do NOT auto-supersede — the heuristic is good enough
 * to draw attention to the conflict, but the user makes the call via
 * `@baton /supersede <newer> <older>`. False positives are cheap (a hint
 * the user dismisses) while a false auto-supersession would be expensive
 * (corrupts the audit trail).
 *
 * Pure module: no vscode/lm imports, safe for the MCP server.
 */

import { CompressedSession } from './types';

/** English contradiction markers we scan decision text for. Case-insensitive. */
export const CONTRADICTION_MARKERS: string[] = [
  'instead of',
  'no longer',
  'switched from',
  'deprecated',
  'replaced',
  'abandoned',
  'rolling back',
  'rolled back',
  'reverted from',
  'moved away from',
  'no longer using',
  'walked back',
];

/**
 * Pre-compiled global regex matching ANY marker. Word-bounded approximation:
 * markers must appear as standalone phrases, not as substrings of unrelated
 * words. Returns the matched marker (lowercased) when present.
 */
const MARKER_RE = new RegExp(
  '\\b(' + CONTRADICTION_MARKERS.map((m) => m.replace(/ /g, '\\s+')).join('|') + ')\\b',
  'i',
);

/** Test whether a decision text contains a contradiction marker. */
export function hasContradictionMarker(text: string): string | undefined {
  const m = text.match(MARKER_RE);
  return m ? m[1].toLowerCase().replace(/\s+/g, ' ') : undefined;
}

export interface ConflictWarning {
  /** ID of the newly-captured session whose decision flagged the conflict. */
  newSessionId: string;
  /** The decision text (already redacted) that triggered the warning. */
  decisionText: string;
  /** The contradiction marker that matched. */
  marker: string;
  /** Candidate older sessions that may be the target of the supersession. */
  candidates: Array<{
    sessionId: string;
    summary: string;
    sharedFiles: string[];
    sharedTopics: string[];
    endTime: number;
  }>;
  /** Wall-clock ms when the conflict was detected (= session capture time). */
  detectedAt: number;
  /**
   * Set to true once the user has actioned the warning (via `/supersede`
   * or `/dismiss-conflict`). Acknowledged warnings stop showing in
   * `/conflicts` but remain in the audit log.
   */
  acknowledged?: boolean;
  /** Reason string, set on acknowledgement. */
  acknowledgedReason?: string;
}

/**
 * Run conflict detection for a single new session against the existing
 * corpus. Returns the warnings to record (zero or more).
 *
 * The new session itself MUST NOT be in `existing`. Caller is responsible
 * for excluding it (typical pattern: detect BEFORE persisting).
 */
export function detectConflicts(
  newSession: CompressedSession,
  existing: CompressedSession[],
): ConflictWarning[] {
  const warnings: ConflictWarning[] = [];
  if (newSession.retracted) return warnings;
  if (newSession.decisions.length === 0) return warnings;

  const newFiles = new Set(newSession.keyFiles.map((f) => f.toLowerCase()));
  const newTopics = new Set(newSession.keyTopics.map((t) => t.toLowerCase()));

  for (const decision of newSession.decisions) {
    const marker = hasContradictionMarker(decision);
    if (!marker) continue;

    // Find candidate older sessions sharing files or topics, with their
    // own decisions, and predating the new one.
    const candidates: ConflictWarning['candidates'] = [];
    for (const other of existing) {
      if (other.id === newSession.id) continue;
      if (other.retracted) continue;
      if (other.endTime >= newSession.endTime) continue;
      if (other.decisions.length === 0) continue;
      const sharedFiles = other.keyFiles.filter((f) => newFiles.has(f.toLowerCase()));
      const sharedTopics = other.keyTopics.filter((t) => newTopics.has(t.toLowerCase()));
      if (sharedFiles.length === 0 && sharedTopics.length === 0) continue;
      candidates.push({
        sessionId: other.id,
        summary: other.summary,
        sharedFiles,
        sharedTopics,
        endTime: other.endTime,
      });
    }
    if (candidates.length === 0) continue;

    // Rank candidates by (sharedFiles + sharedTopics) DESC, then recency.
    candidates.sort(
      (a, b) =>
        b.sharedFiles.length +
          b.sharedTopics.length -
          (a.sharedFiles.length + a.sharedTopics.length) || b.endTime - a.endTime,
    );

    warnings.push({
      newSessionId: newSession.id,
      decisionText: decision,
      marker,
      candidates: candidates.slice(0, 5),
      detectedAt: newSession.endTime,
    });
  }
  return warnings;
}

/**
 * Render a single warning as chat-friendly markdown.
 *
 * Shape:
 *   ⚠️ Possible conflict — decision text
 *   Marker: "instead of"
 *   Candidates: ...
 *   Resolve: `@baton /supersede <new> <candidate>`
 */
export function renderConflictWarning(w: ConflictWarning): string {
  const lines: string[] = [];
  lines.push(`### ⚠️ Possible conflict in \`${w.newSessionId.substring(0, 8)}\``);
  lines.push(`> ${w.decisionText}`);
  lines.push(
    `**Marker:** \`${w.marker}\` · **Detected:** ${new Date(w.detectedAt).toLocaleString()}`,
  );
  lines.push('');
  lines.push(`**Candidates likely being overturned:**`);
  for (const c of w.candidates) {
    const shared = [
      c.sharedFiles.length ? `${c.sharedFiles.length} file(s)` : '',
      c.sharedTopics.length ? `${c.sharedTopics.length} topic(s)` : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`- \`${c.sessionId.substring(0, 8)}\` — ${c.summary} _(shares ${shared})_`);
    lines.push(
      `  > Resolve: \`@baton /supersede ${w.newSessionId.substring(0, 8)} ${c.sessionId.substring(0, 8)}\``,
    );
  }
  lines.push('');
  return lines.join('\n');
}
