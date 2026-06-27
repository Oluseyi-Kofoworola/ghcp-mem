/**
 * Cross-session causal graph.
 *
 * Sessions don't live in isolation — a bugfix today often resolves an
 * issue introduced by a feature merged last month, and a refactor next
 * week may break a contract laid down in this session's tests. The
 * causal graph surfaces these implicit relationships so retrieval can
 * carry a narrative chain rather than a flat list.
 *
 * We compute edges from existing capture data — no extra schema, no
 * write-time annotation. Two heuristics drive the edges:
 *
 *   1. SHARED-FILE proximity: sessions A and B share ≥1 key file AND
 *      A.endTime < B.startTime AND |A.endTime − B.endTime| < WINDOW_MS
 *      → A is a predecessor of B (i.e. B's work continued from A).
 *
 *   2. BUGFIX-AFTER-FEATURE causation: when B's observationType is
 *      'bugfix' and A's is 'feature' (or 'refactor') with shared files
 *      and A precedes B inside the window, the edge is labelled
 *      `introduced_issue_fixed_by`. This is the most common
 *      cause-and-effect relationship developers actually care about.
 *
 * Pure module: no vscode imports, no LM calls, deterministic.
 */

import { CompressedSession } from './types';

/** How far back to look for causal predecessors (default: 30 days). */
export const CAUSAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How far forward to look for causal successors. */
export const CAUSAL_SUCCESSOR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type CausalEdgeLabel =
  | 'continues_work_from'
  | 'introduced_issue_fixed_by'
  | 'extends' // refactor of a feature
  | 'tests' // test session targeting a feature/refactor
  | 'related';

export interface CausalEdge {
  /** Session this edge connects to (predecessor for `predecessors[]`, successor for `successors[]`). */
  sessionId: string;
  summary: string;
  endTime: number;
  observationType: string;
  sharedFiles: string[];
  label: CausalEdgeLabel;
  /** Time gap in ms between the two sessions (always positive). */
  gapMs: number;
}

export interface CausalNeighbors {
  centerId: string;
  predecessors: CausalEdge[];
  successors: CausalEdge[];
}

/**
 * Find the causal predecessors and successors of the session with `id`.
 * Returns at most `limit` neighbours per side (newest predecessors first,
 * oldest successors first — so the lists read chronologically when
 * concatenated as `predecessors + center + successors`).
 */
export function getCausalNeighbors(
  id: string,
  allSessions: CompressedSession[],
  limit = 5,
): CausalNeighbors | undefined {
  const center = allSessions.find((s) => s.id === id);
  if (!center) return undefined;

  const centerFiles = new Set(center.keyFiles.map((f) => f.toLowerCase()));
  if (centerFiles.size === 0) {
    return { centerId: id, predecessors: [], successors: [] };
  }

  const predecessors: CausalEdge[] = [];
  const successors: CausalEdge[] = [];
  for (const other of allSessions) {
    if (other.id === center.id) continue;
    if (other.retracted) continue;
    const shared = other.keyFiles.filter((f) => centerFiles.has(f.toLowerCase()));
    if (shared.length === 0) continue;

    // Predecessor: ended before center started, within window.
    if (other.endTime < center.startTime) {
      const gapMs = center.startTime - other.endTime;
      if (gapMs > CAUSAL_WINDOW_MS) continue;
      predecessors.push({
        sessionId: other.id,
        summary: other.summary,
        endTime: other.endTime,
        observationType: other.observationType,
        sharedFiles: shared,
        label: labelEdge(other, center),
        gapMs,
      });
      continue;
    }
    // Successor: started after center ended, within window.
    if (other.startTime > center.endTime) {
      const gapMs = other.startTime - center.endTime;
      if (gapMs > CAUSAL_SUCCESSOR_WINDOW_MS) continue;
      successors.push({
        sessionId: other.id,
        summary: other.summary,
        endTime: other.endTime,
        observationType: other.observationType,
        sharedFiles: shared,
        label: labelEdge(center, other),
        gapMs,
      });
    }
  }

  // Predecessors: newest first (smallest gap to center).
  predecessors.sort((a, b) => a.gapMs - b.gapMs);
  // Successors: oldest first (smallest gap to center, then chronological).
  successors.sort((a, b) => a.gapMs - b.gapMs);

  return {
    centerId: id,
    predecessors: predecessors.slice(0, limit),
    successors: successors.slice(0, limit),
  };
}

/**
 * Pick a semantic label for the edge from `earlier` → `later`.
 *
 *   feature/refactor → bugfix    : 'introduced_issue_fixed_by'
 *   feature          → refactor  : 'extends'
 *   feature/refactor → test      : 'tests'
 *   everything else              : 'continues_work_from'
 */
export function labelEdge(earlier: CompressedSession, later: CompressedSession): CausalEdgeLabel {
  const e = earlier.observationType;
  const l = later.observationType;
  if (l === 'bugfix' && (e === 'feature' || e === 'refactor')) return 'introduced_issue_fixed_by';
  if (l === 'refactor' && e === 'feature') return 'extends';
  if (l === 'test' && (e === 'feature' || e === 'refactor')) return 'tests';
  return 'continues_work_from';
}

/**
 * Render a CausalNeighbors record as chat-friendly markdown.
 */
export function renderCausalNeighbors(n: CausalNeighbors): string {
  const lines: string[] = [];
  lines.push(`## 🧭 Lineage for \`${n.centerId.substring(0, 8)}\``);
  lines.push('');
  if (n.predecessors.length === 0 && n.successors.length === 0) {
    lines.push(
      `_No causal neighbours found (no other session within ±30 days shares a key file)._`,
    );
    return lines.join('\n');
  }
  if (n.predecessors.length) {
    lines.push(`### ⬅ Predecessors (${n.predecessors.length})`);
    for (const p of n.predecessors) {
      const days = Math.round(p.gapMs / (24 * 60 * 60 * 1000));
      const files = p.sharedFiles.slice(0, 2).join(', ');
      lines.push(
        `- \`${p.sessionId.substring(0, 8)}\` · ${p.observationType} · ${days}d earlier · _${prettyLabel(p.label)}_`,
      );
      lines.push(`  > ${p.summary}`);
      lines.push(
        `  > 📎 shared: ${files}${p.sharedFiles.length > 2 ? ` (+${p.sharedFiles.length - 2})` : ''}`,
      );
    }
    lines.push('');
  }
  if (n.successors.length) {
    lines.push(`### ➡ Successors (${n.successors.length})`);
    for (const s of n.successors) {
      const days = Math.round(s.gapMs / (24 * 60 * 60 * 1000));
      const files = s.sharedFiles.slice(0, 2).join(', ');
      lines.push(
        `- \`${s.sessionId.substring(0, 8)}\` · ${s.observationType} · ${days}d later · _${prettyLabel(s.label)}_`,
      );
      lines.push(`  > ${s.summary}`);
      lines.push(
        `  > 📎 shared: ${files}${s.sharedFiles.length > 2 ? ` (+${s.sharedFiles.length - 2})` : ''}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

function prettyLabel(label: CausalEdgeLabel): string {
  switch (label) {
    case 'introduced_issue_fixed_by':
      return 'introduced an issue fixed by';
    case 'extends':
      return 'extended by';
    case 'tests':
      return 'covered by tests in';
    case 'continues_work_from':
      return 'work continued';
    default:
      return label;
  }
}
