/**
 * Pure session-rendering helpers shared by the `@mem` command handlers.
 *
 * Extracted from contextProvider.ts (Phase 2 god-file decomposition) so the
 * three list/detail renderers and the confidence heuristic live in one small,
 * directly-unit-testable module instead of as private methods on the 3k-line
 * provider class. None of these touch instance state — they take a session and
 * a response stream and emit markdown.
 */

import * as vscode from 'vscode';
import { CompressedSession } from './types';
import { estimateSessionTokenSavings } from './savings';

/** Relative "Nm/h/d ago" rendering of a timestamp. */
export function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/**
 * Heuristic confidence label for a session, based on how many independent
 * signals (tags, decisions, problems, topics, files, typed observation) it
 * carries. Used to annotate list and detail views.
 */
export function memoryConfidence(s: CompressedSession): { label: string; reason: string } {
  const score =
    (s.userTags.length ? 2 : 0) +
    (s.decisions.length ? 2 : 0) +
    (s.problemsSolved.length ? 1 : 0) +
    (s.keyTopics.length ? 1 : 0) +
    (s.keyFiles.length ? 1 : 0) +
    (s.observationType !== 'unknown' ? 1 : 0);
  if (score >= 6)
    return { label: 'high confidence', reason: 'tagged, typed, and decision-bearing' };
  if (score >= 4) return { label: 'medium confidence', reason: 'multi-signal match' };
  return { label: 'low confidence', reason: 'lightly supported context' };
}

/** One-line index row (used by `/recent`, `/search`). */
export function renderIndexRow(s: CompressedSession, stream: vscode.ChatResponseStream): void {
  const date = new Date(s.startTime).toLocaleString();
  const tags = s.userTags.length ? ` · 🏷️ ${s.userTags.join(',')}` : '';
  const branch = s.branchName ? ` · \`${s.branchName}\`` : '';
  const confidence = memoryConfidence(s);
  stream.markdown(
    `- **[${s.observationType}]** \`${s.id.substring(0, 8)}\` · ${date}${branch}${tags} · ${confidence.label}  \n  ${s.summary.substring(0, 180)}\n`,
  );
}

/** Compact card (used by `/timeline`, `/search` detail). */
export function renderCompact(s: CompressedSession, stream: vscode.ChatResponseStream): void {
  const start = new Date(s.startTime).toLocaleString();
  const dur = Math.round((s.endTime - s.startTime) / 60000);
  const confidence = memoryConfidence(s);
  stream.markdown(
    `### [${s.observationType}] ${start} (${dur} min) · \`${s.id.substring(0, 8)}\` · ${confidence.label}\n\n${s.summary}\n\n`,
  );
  if (s.keyFiles.length)
    stream.markdown(
      `**Files:** ${s.keyFiles
        .slice(0, 5)
        .map((f) => `\`${f}\``)
        .join(', ')}\n\n`,
    );
  if (s.keyTopics.length) stream.markdown(`**Topics:** ${s.keyTopics.join(', ')}\n\n`);
}

/** Full structured detail view (used by `/detail`). */
export function renderFull(s: CompressedSession, stream: vscode.ChatResponseStream): void {
  const start = new Date(s.startTime).toLocaleString();
  const end = new Date(s.endTime).toLocaleString();
  const dur = Math.round((s.endTime - s.startTime) / 60000);
  stream.markdown(`## Session \`${s.id}\`\n\n`);
  stream.markdown(`- **Type:** ${s.observationType}\n`);
  stream.markdown(`- **Workspace:** ${s.workspaceName}\n`);
  if (s.branchName) stream.markdown(`- **Branch:** \`${s.branchName}\`\n`);
  stream.markdown(`- **Started:** ${start}\n- **Ended:** ${end} (${dur} min)\n`);
  stream.markdown(
    `- **Events captured:** ${s.rawEventCount} · **Redactions:** ${s.redactionCount}\n`,
  );
  const savings = estimateSessionTokenSavings(s);
  stream.markdown(
    `- **Estimated token savings:** ${savings.tokensSaved} tokens (${savings.rawTokens} raw → ${savings.compactTokens} compact, ${savings.compressionRatio}×)\n`,
  );
  if (s.userTags.length) stream.markdown(`- **User tags:** ${s.userTags.join(', ')}\n`);
  if (s.azureContext) {
    const ac = s.azureContext;
    const bits = [
      ac.subscriptionName && `sub=${ac.subscriptionName}`,
      ac.resourceGroup && `rg=${ac.resourceGroup}`,
      ac.defaultLocation && `loc=${ac.defaultLocation}`,
      ac.subsystems?.length && `subsystems=${ac.subsystems.join(',')}`,
    ]
      .filter(Boolean)
      .join(' · ');
    if (bits) stream.markdown(`- **Azure:** ${bits}\n`);
    if (ac.resourceIds?.length) {
      stream.markdown(
        `- **Resource IDs (${ac.resourceIds.length}):**\n${ac.resourceIds
          .slice(0, 10)
          .map((r) => `  - \`${r}\``)
          .join('\n')}\n`,
      );
    }
  }
  stream.markdown(`\n### Summary\n\n${s.summary}\n\n`);
  if (s.keyFiles.length)
    stream.markdown(`### Files\n${s.keyFiles.map((f) => `- \`${f}\``).join('\n')}\n\n`);
  if (s.keyTopics.length)
    stream.markdown(`### Topics\n${s.keyTopics.map((t) => `- ${t}`).join('\n')}\n\n`);
  if (s.decisions.length)
    stream.markdown(`### Decisions\n${s.decisions.map((d) => `- ${d}`).join('\n')}\n\n`);
  if (s.problemsSolved.length)
    stream.markdown(`### Problems Solved\n${s.problemsSolved.map((p) => `- ${p}`).join('\n')}\n\n`);
}
