/**
 * `@mem` trust + correction commands — verification, corrections, supersede /
 * retract / noise lifecycle, accept/reject reinforcement, conflict listing,
 * ranking explanations, and the manual janitor re-score pass.
 *
 * Extracted from contextProvider.ts (Phase 2 god-file decomposition).
 */
import * as vscode from 'vscode';
import { CommandContext } from './context';
import { getConfig, CompressedSession, computeContentHash } from '../types';
import { redact } from '../redactor';
import { getRepoScope } from '../repoScope';
import { validateSession } from '../validator';
import { renderConflictWarning } from '../conflicts';
import { explainScore, renderExplanation } from '../explain';
import { splitIdAndText } from '../contextProviderFormat';

export async function verify(
  ctx: CommandContext,
  idPrefix: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const session = idPrefix ? ctx.store.getById(idPrefix.trim()) : ctx.store.getRecentSessions(1)[0];
  if (!session) {
    stream.markdown(`No session found${idPrefix ? ` for ID "${idPrefix}"` : ''}.\n`);
    return;
  }
  const result = await validateSession(session);
  stream.markdown(`## 🔍 Verification — \`${session.id.substring(0, 8)}\`\n\n`);
  stream.markdown(`**Summary:** ${session.summary}\n\n`);
  if (typeof session.confidence === 'number') {
    const emoji = session.confidence >= 0.75 ? '🟢' : session.confidence >= 0.5 ? '🟡' : '🔴';
    stream.markdown(
      `**Confidence (at capture):** ${emoji} ${session.confidence.toFixed(2)} (${session.compressorMode ?? '?'} mode)\n\n`,
    );
  }
  if (result.emptyKeyFiles) {
    stream.markdown(`_No key files to verify._\n`);
    return;
  }
  stream.markdown(`**Grounded freshness:** ${(result.groundedFreshness * 100).toFixed(0)}%\n\n`);
  const groups = {
    verified: result.verifiedFiles,
    drifted: result.driftedFiles,
    missing: result.missing,
  };
  const neutral = Object.entries(result.verification)
    .filter(([, v]) => v === 'neutral')
    .map(([k]) => k);

  if (groups.verified.length) {
    stream.markdown(`### ✅ Verified (${groups.verified.length})\n`);
    for (const f of groups.verified)
      stream.markdown(`- \`${f}\` — content matches capture-time hash\n`);
    stream.markdown('\n');
  }
  if (groups.drifted.length) {
    stream.markdown(`### 🟡 Drifted (${groups.drifted.length})\n`);
    for (const f of groups.drifted)
      stream.markdown(`- \`${f}\` — file exists but content has changed since capture\n`);
    stream.markdown('\n');
  }
  if (groups.missing.length) {
    stream.markdown(`### 🔴 Missing (${groups.missing.length})\n`);
    for (const f of groups.missing)
      stream.markdown(`- \`${f}\` — file no longer present in workspace\n`);
    stream.markdown('\n');
  }
  if (neutral.length) {
    stream.markdown(`### ◌ Unverifiable (${neutral.length})\n`);
    for (const f of neutral)
      stream.markdown(`- \`${f}\` — no stored hash to compare against (legacy session)\n`);
    stream.markdown('\n');
  }
  if (session.supersededBy) {
    stream.markdown(
      `> ⚠️ This session has been superseded by \`${session.supersededBy.substring(0, 8)}\` — \`@mem /detail ${session.supersededBy.substring(0, 8)}\` to view it.\n`,
    );
  }
  if (session.retracted) {
    stream.markdown(
      `> 🚫 This session is retracted${session.retractedReason ? `: _${session.retractedReason}_` : ''}.\n`,
    );
  }
}

export async function correct(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const { idPrefix, text } = splitIdAndText(query);
  if (!idPrefix || !text) {
    stream.markdown(`Usage: \`/correct <session-id-prefix> <corrected text>\`\n`);
    return;
  }
  const original = ctx.store.getById(idPrefix);
  if (!original) {
    stream.markdown(`No session found for ID "${idPrefix}".\n`);
    return;
  }
  const cfg = getConfig();
  const customRules = cfg.customRedactionRules;
  const customSensitiveEntities = cfg.customSensitiveEntities;
  const cleanedText = redact(text, {
    redactSecrets: true,
    honorPrivateTags: true,
    customRules,
    customSensitiveEntities,
  }).text;
  const now = Date.now();
  const newId = crypto.randomUUID();
  const summary = `Correction of ${original.id.substring(0, 8)}: ${cleanedText}`;
  const correction: CompressedSession = {
    id: newId,
    workspaceId: original.workspaceId,
    workspaceName: original.workspaceName,
    startTime: now,
    endTime: now,
    summary,
    observationType: original.observationType,
    keyFiles: [...original.keyFiles],
    keyTopics: [...original.keyTopics, 'correction'],
    decisions: [cleanedText],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: ['correction'],
    redactionCount: 0,
    contentHash: computeContentHash({
      summary,
      keyFiles: original.keyFiles,
      keyTopics: [...original.keyTopics, 'correction'],
      decisions: [cleanedText],
      problemsSolved: [],
    }),
    // Correction is a user-pinned source of truth — top confidence.
    confidence: 1.0,
    compressorMode: 'lm',
    correctionOf: original.id,
    repoScope: original.repoScope,
    repoScopeLabel: original.repoScopeLabel,
    branchName: original.branchName,
  };
  // Stamp the current repo scope if we still have it (handles workspace
  // moves between capture and correction).
  try {
    const scope = await getRepoScope();
    if (scope?.id) {
      correction.repoScope = scope.id;
      correction.repoScopeLabel = scope.label;
    }
  } catch {
    /* keep inherited values */
  }

  await ctx.store.addSession(correction);
  await ctx.store.addCorrection(original.id, newId);
  stream.markdown(
    `✅ Recorded correction \`${newId.substring(0, 8)}\` superseding \`${original.id.substring(0, 8)}\`.\n\n` +
      `> ${cleanedText}\n`,
  );
}

export async function supersede(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const parts = query.trim().split(/\s+/);
  if (parts.length < 2) {
    stream.markdown(`Usage: \`/supersede <newerId> <olderId>\`\n`);
    return;
  }
  const [newerPrefix, olderPrefix] = parts;
  const newer = ctx.store.getById(newerPrefix);
  const older = ctx.store.getById(olderPrefix);
  if (!newer || !older) {
    stream.markdown(
      `Could not resolve one of the IDs (newer=${newer ? '✓' : '✗'}, older=${older ? '✓' : '✗'}).\n`,
    );
    return;
  }
  if (newer.id === older.id) {
    stream.markdown(`Cannot supersede a session with itself.\n`);
    return;
  }
  await ctx.store.setSupersedes(newer.id, older.id);
  stream.markdown(
    `✅ \`${newer.id.substring(0, 8)}\` now supersedes \`${older.id.substring(0, 8)}\`. ` +
      `The older session stays on disk for audit but is excluded from injection and down-ranked in retrieval.\n`,
  );
}

export async function retract(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) {
    stream.markdown(
      `Usage: \`/retract <session-id-prefix> [reason]\` or \`/retract undo <session-id-prefix>\`\n`,
    );
    return;
  }
  const parts = trimmed.split(/\s+/);
  if (parts[0]?.toLowerCase() === 'undo') {
    const target = ctx.store.getById(parts[1] ?? '');
    if (!target) {
      stream.markdown(`No session found for ID "${parts[1] ?? ''}".\n`);
      return;
    }
    await ctx.store.undoRetract(target.id);
    stream.markdown(`✅ Restored \`${target.id.substring(0, 8)}\` — back in retrieval pool.\n`);
    return;
  }
  const { idPrefix, text } = splitIdAndText(trimmed);
  const target = ctx.store.getById(idPrefix);
  if (!target) {
    stream.markdown(`No session found for ID "${idPrefix}".\n`);
    return;
  }
  await ctx.store.setRetracted(target.id, text || undefined);
  stream.markdown(
    `🚫 Retracted \`${target.id.substring(0, 8)}\`. It will not appear in retrieval, injection, or exports. ` +
      `Run \`/retract undo ${target.id.substring(0, 8)}\` to restore.\n`,
  );
}

export async function noise(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) {
    stream.markdown(
      `Usage: \`/noise <session-id-prefix>\` or \`/noise undo <session-id-prefix>\`\n`,
    );
    return;
  }
  const parts = trimmed.split(/\s+/);
  if (parts[0]?.toLowerCase() === 'undo') {
    const target = ctx.store.getById(parts[1] ?? '');
    if (!target) {
      stream.markdown(`No session found for ID "${parts[1] ?? ''}".\n`);
      return;
    }
    await ctx.store.undoNoise(target.id);
    stream.markdown(`✅ Restored \`${target.id.substring(0, 8)}\` — back in the retrieval pool.\n`);
    return;
  }
  const target = ctx.store.getById(trimmed);
  if (!target) {
    stream.markdown(`No session found for ID "${trimmed}".\n`);
    return;
  }
  await ctx.store.setNoise(target.id, true);
  stream.markdown(
    `🗑️ Marked \`${target.id.substring(0, 8)}\` as noise. Excluded from injection and retrieval, ` +
      `and the ranker learned from it. Run \`/noise undo ${target.id.substring(0, 8)}\` to restore.\n`,
  );
}

export async function accept(
  ctx: CommandContext,
  idPrefix: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const target = ctx.store.getById(idPrefix.trim());
  if (!target) {
    stream.markdown(`Usage: \`/accept <session-id-prefix>\`\n`);
    return;
  }
  await ctx.store.recordAcceptance(target.id);
  const a = target.usage?.accepted ?? 1;
  const r = target.usage?.rejected ?? 0;
  stream.markdown(
    `👍 Marked \`${target.id.substring(0, 8)}\` as useful. Score: ${a} accept / ${r} reject.\n`,
  );
}

export async function reject(
  ctx: CommandContext,
  idPrefix: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const target = ctx.store.getById(idPrefix.trim());
  if (!target) {
    stream.markdown(`Usage: \`/reject <session-id-prefix>\`\n`);
    return;
  }
  await ctx.store.recordRejection(target.id);
  const a = target.usage?.accepted ?? 0;
  const r = target.usage?.rejected ?? 1;
  stream.markdown(
    `👎 Marked \`${target.id.substring(0, 8)}\` as unhelpful. Score: ${a} accept / ${r} reject.\n`,
  );
}

export async function conflicts(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const trimmed = (query ?? '').trim();
  // Subcommand: dismiss <id> [reason]
  if (trimmed.toLowerCase().startsWith('dismiss')) {
    const rest = trimmed.slice('dismiss'.length).trim();
    const [idPrefix, ...reasonParts] = rest.split(/\s+/);
    if (!idPrefix) {
      stream.markdown(`Usage: \`/conflicts dismiss <session-id-prefix> [reason]\`\n`);
      return;
    }
    const target = ctx.store.getById(idPrefix);
    if (!target) {
      stream.markdown(`No session found for ID "${idPrefix}".\n`);
      return;
    }
    const reason = reasonParts.length ? reasonParts.join(' ') : 'Manually dismissed';
    const ok = ctx.store.acknowledgeConflict(target.id, reason);
    if (!ok) {
      stream.markdown(`No pending conflict for \`${target.id.substring(0, 8)}\`.\n`);
      return;
    }
    stream.markdown(
      `✅ Dismissed conflict for \`${target.id.substring(0, 8)}\` — reason: _${reason}_\n`,
    );
    return;
  }

  const warnings = ctx.store.getPendingConflicts();
  if (warnings.length === 0) {
    stream.markdown(`✅ No pending conflicts.\n`);
    return;
  }
  stream.markdown(`## ⚠️ Pending Conflicts (${warnings.length})\n\n`);
  stream.markdown(
    `_Decisions that contained contradiction markers and overlap with older sessions. Review and \`/supersede\` (auto-acknowledges) or \`/conflicts dismiss <id> [reason]\` to ignore._\n\n`,
  );
  for (const w of warnings) {
    stream.markdown(renderConflictWarning(w));
  }
}

export async function why(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const trimmed = (query ?? '').trim();
  if (!trimmed) {
    stream.markdown(
      `Usage: \`/why <query terms> :: <session-id-prefix>\` — breaks down why a session ranked where it did.\n`,
    );
    return;
  }
  let q: string;
  let idPart: string;
  const sepIdx = trimmed.indexOf('::');
  if (sepIdx === -1) {
    // ID-only form: use the session's most prominent topic as the query.
    idPart = trimmed;
    const found = ctx.store.getById(idPart);
    q = (found?.keyTopics[0] ?? found?.summary ?? '').slice(0, 80);
  } else {
    q = trimmed.slice(0, sepIdx).trim();
    idPart = trimmed.slice(sepIdx + 2).trim();
  }
  const target = ctx.store.getById(idPart);
  if (!target) {
    stream.markdown(`No session found for ID "${idPart}".\n`);
    return;
  }
  const wsId = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
  const explanation = explainScore(target, q, {
    allSessions: ctx.store.getAllSessions(),
    learnedWeights: ctx.store.getAdaptiveWeights(),
    activeWorkspaceId: wsId,
  });
  stream.markdown(renderExplanation(explanation));
}

export async function janitor(
  ctx: CommandContext,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const { runJanitor } = await import('../janitor');
  const { getConfig } = await import('../types');
  const cfg = getConfig();
  const pruneAfterDays =
    vscode.workspace.getConfiguration('ghcpMem').get<number>('janitorPruneAfterDays', 0) ?? 0;
  const r = await runJanitor(ctx.store, {
    qualityFloor: cfg.qualityFloor,
    pruneAfterDays,
  });
  stream.markdown(
    `🧹 Janitor: rescored **${r.rescored}**, flagged **${r.flagged}**, unflagged **${r.unflagged}**, pruned **${r.pruned}** (floor=${cfg.qualityFloor}).\n`,
  );
  if (r.lessonsCreated > 0 || r.lessonsReinforced > 0) {
    stream.markdown(
      `🎓 Lessons: **${r.lessonsCreated}** new, **${r.lessonsReinforced}** reinforced.\n`,
    );
  }
}
