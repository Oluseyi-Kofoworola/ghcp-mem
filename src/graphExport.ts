/**
 * Mermaid decision-graph export.
 *
 * Phase 6 visualisation win: renders the full cross-session decision
 * graph as a Mermaid flowchart that can be pasted directly into
 * GitHub PRs, ADRs, READMEs, or Notion docs.
 *
 * Three edge types are emitted:
 *   solid arrow  (-->)   : supersession (A is overturned by B)
 *   dashed arrow (-.->)  : correction   (A is corrected by B)
 *   dotted arrow (==>)   : causal       (bugfix B fixes issue introduced by A)
 *
 * Nodes are styled by observation type so the diagram reads at a glance:
 *   feature/refactor → green; bugfix → red; deployment → blue; etc.
 *
 * Pure module: no vscode imports, deterministic output, safe to call from
 * the MCP server or CI.
 */

import { CompressedSession } from './types';
import { getCausalNeighbors, CausalEdgeLabel } from './causalGraph';

/**
 * Colour palette per observation type. Hex codes chosen for WCAG-AA
 * contrast on both Mermaid's default light and dark themes. The palette
 * mirrors `timelinePanel.ts:TYPE_COLORS` so the inspector and the exported
 * diagram share a visual language.
 */
const TYPE_FILL: Record<string, string> = {
  feature: '#1a4731',
  bugfix: '#4a1717',
  refactor: '#0d2e5c',
  docs: '#2c1e5c',
  test: '#3d2600',
  chore: '#2a2a2a',
  research: '#3a2700',
  config: '#002244',
  security: '#4a2900',
  deployment: '#1a3320',
  infra: '#2d1f3d',
  unknown: '#1c1c1c',
};

/**
 * Quote a Mermaid node label so embedded special chars don't break the
 * parser. Replaces `"` with `'`, strips backticks/braces, truncates.
 */
function quoteLabel(text: string): string {
  return (text ?? '').replace(/"/g, "'").replace(/[`{}]/g, '').replace(/\n/g, ' ').slice(0, 80);
}

/**
 * Generate a Mermaid `flowchart TB` rendering of the decision graph.
 *
 * Strategy:
 *  1. One node per session, ID = short session ID, label = `[type] short
 *     summary`. Style by observation type for at-a-glance scanning.
 *  2. Supersession edges from older → newer (solid).
 *  3. Correction edges from corrected → corrector (dashed).
 *  4. Causal edges (bugfix-after-feature only, the highest-signal subset
 *     of causal links) using the existing `getCausalNeighbors` helper.
 *
 * Retracted sessions are still rendered (the audit trail matters) but
 * dimmed via a dotted node border.
 */
export function buildMermaidGraph(sessions: CompressedSession[]): string {
  if (sessions.length === 0) return 'flowchart TB\n  empty([No sessions to graph])';

  const lines: string[] = ['flowchart TB'];
  const sessionsById = new Map<string, CompressedSession>();
  for (const s of sessions) sessionsById.set(s.id, s);

  // ── nodes ──────────────────────────────────────────────────────────────
  for (const s of sessions) {
    const id = nodeId(s.id);
    const labelType = s.observationType;
    const summary = quoteLabel(s.summary);
    const retractedFlag = s.retracted ? ' 🚫' : '';
    const trustFlag = typeof s.confidence === 'number' && s.confidence < 0.5 ? ' ⚠️' : '';
    lines.push(`  ${id}["[${labelType}] ${summary}${retractedFlag}${trustFlag}"]`);
  }

  // ── supersession edges (solid) ─────────────────────────────────────────
  for (const s of sessions) {
    if (!s.supersededBy) continue;
    const target = sessionsById.get(s.supersededBy);
    if (!target) continue;
    // Don't double-draw if the target is a correction (handled separately).
    if (target.correctionOf === s.id) continue;
    lines.push(`  ${nodeId(s.id)} -->|supersedes| ${nodeId(target.id)}`);
  }

  // ── correction edges (dashed) ──────────────────────────────────────────
  for (const s of sessions) {
    if (!s.correctionOf) continue;
    const original = sessionsById.get(s.correctionOf);
    if (!original) continue;
    lines.push(`  ${nodeId(original.id)} -.->|corrected by| ${nodeId(s.id)}`);
  }

  // ── causal edges (dotted, bugfix-after-feature only) ───────────────────
  // Only emit the strongest causal links so the graph stays readable.
  // We iterate sessions; for each bugfix we look up its predecessors and
  // emit an edge from any feature/refactor predecessor.
  for (const s of sessions) {
    if (s.observationType !== 'bugfix') continue;
    const n = getCausalNeighbors(s.id, sessions);
    if (!n) continue;
    for (const p of n.predecessors) {
      if (p.label === ('introduced_issue_fixed_by' as CausalEdgeLabel)) {
        lines.push(`  ${nodeId(p.sessionId)} ==>|fixed by| ${nodeId(s.id)}`);
      }
    }
  }

  // ── styling ────────────────────────────────────────────────────────────
  for (const s of sessions) {
    const fill = TYPE_FILL[s.observationType] ?? TYPE_FILL.unknown;
    const stroke = s.retracted ? '#888,stroke-dasharray:5 5' : '#aaa';
    lines.push(`  style ${nodeId(s.id)} fill:${fill},stroke:${stroke},color:#fff`);
  }

  return lines.join('\n');
}

/**
 * Convert a UUID session ID into a Mermaid-safe node identifier.
 * Mermaid IDs must match `[a-zA-Z][\w_-]*`; UUIDs are fine if we drop the
 * dashes and prefix with 's'. Keep the first 8 chars to keep the diagram
 * source readable.
 */
function nodeId(sessionId: string): string {
  const short = sessionId.replace(/-/g, '').slice(0, 8);
  return `s${short}`;
}
