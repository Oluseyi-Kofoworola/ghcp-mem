/**
 * `@mem` admin + insight commands — workspace integrity audit, compliance
 * report, retrieval-router preview, causal graph, markdown export, and the
 * consolidated lessons surface.
 *
 * Extracted from contextProvider.ts (Phase 2 god-file decomposition).
 */
import * as vscode from 'vscode';
import { CommandContext } from './context';
import { getConfig, CompressedSession } from '../types';
import { redact } from '../redactor';
import { buildComplianceReport, renderComplianceReport } from '../compliance';
import { recommend, renderRecommendation, extractMentionedPaths } from '../router';
import { buildMermaidGraph } from '../graphExport';
import { exportSessionMarkdown } from '../markdownExport';
import { rankLessons, makePinnedLesson } from '../lessons';

export async function audit(ctx: CommandContext, stream: vscode.ChatResponseStream): Promise<void> {
  const { runWorkspaceAudit, hasBlockingIssues } = await import('../integrityChecker');
  const { issues, rulesRun } = await runWorkspaceAudit();
  if (rulesRun.length === 0) {
    stream.markdown('No workspace folder open — nothing to audit.\n');
    return;
  }
  stream.markdown(`## 🩺 Workspace Integrity Audit\n\n`);
  stream.markdown(
    `Ran **${rulesRun.length}** rule${rulesRun.length === 1 ? '' : 's'} (\`${rulesRun.join('`, `')}\`).\n\n`,
  );

  if (issues.length === 0) {
    stream.markdown('✅ **No issues found.** Every checked surface is consistent.\n');
    return;
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  if (errors.length) {
    stream.markdown(`### ❌ ${errors.length} error${errors.length === 1 ? '' : 's'}\n\n`);
    for (const i of errors) {
      const loc = i.line ? `\`${i.file}:${i.line}\`` : `\`${i.file}\``;
      stream.markdown(
        `- **${i.rule}** · ${loc} — ${i.message}` + (i.fix ? `\n  > 💡 ${i.fix}` : '') + '\n',
      );
    }
    stream.markdown('\n');
  }
  if (warnings.length) {
    stream.markdown(`### ⚠️ ${warnings.length} warning${warnings.length === 1 ? '' : 's'}\n\n`);
    for (const i of warnings) {
      const loc = i.line ? `\`${i.file}:${i.line}\`` : `\`${i.file}\``;
      stream.markdown(
        `- **${i.rule}** · ${loc} — ${i.message}` + (i.fix ? `\n  > 💡 ${i.fix}` : '') + '\n',
      );
    }
    stream.markdown('\n');
  }
  if (hasBlockingIssues(issues)) {
    stream.markdown(
      '> These are blocking issues for the release-consistency gate. Either fix them before `vsce publish`, or run `npm run bump:version -- <version>` to realign every surface.\n',
    );
  }
  stream.button({
    command: 'ghcpMem.runIntegrityAudit',
    title: 'Open full audit report',
  });
}

export async function compliance(
  ctx: CommandContext,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const cfg = getConfig();
  const report = buildComplianceReport(ctx.store.getAllSessions(), {
    customSensitiveEntities: cfg.customSensitiveEntities,
  });
  stream.markdown(renderComplianceReport(report));
}

export async function route(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const q = (query ?? '').trim();
  if (!q) {
    stream.markdown(
      `Usage: \`/route <your question>\` — returns the cheapest way to satisfy it (MCP vs file open).\n`,
    );
    return;
  }
  // Look up file sizes for any path the query mentions so the cost
  // estimate reflects the actual workspace instead of the default.
  const mentioned = extractMentionedPaths(q);
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  const fileSizes: Record<string, number> = {};
  if (ws) {
    for (const rawPath of mentioned) {
      const path = rawPath.replace(/#.*$/, '');
      try {
        const uri = vscode.Uri.joinPath(ws, path);
        const stat = await vscode.workspace.fs.stat(uri);
        fileSizes[path] = stat.size;
      } catch {
        /* file may not exist; default kicks in */
      }
    }
  }
  const rec = recommend(q, { fileSizes, mcpAvailable: true });
  stream.markdown(renderRecommendation(rec));
}

export async function graph(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const trimmed = (query ?? '').trim();
  const fileFilter = trimmed.startsWith('file:') ? trimmed.slice(5).trim() : undefined;
  let sessions = ctx.store.getAllSessions();
  if (fileFilter) {
    const want = fileFilter.toLowerCase();
    sessions = sessions.filter((s) => s.keyFiles.some((f) => f.toLowerCase().includes(want)));
  }
  if (sessions.length === 0) {
    stream.markdown(`_No sessions to graph${fileFilter ? ` for filter "${fileFilter}"` : ''}._\n`);
    return;
  }
  const mermaid = buildMermaidGraph(sessions);
  stream.markdown(`## 🕸 Decision Graph${fileFilter ? ` — \`${fileFilter}\`` : ''}\n\n`);
  stream.markdown(`\`\`\`mermaid\n${mermaid}\n\`\`\`\n`);
  stream.markdown(
    `\n_${sessions.length} session(s). Solid arrows = supersession, dashed = correction, dotted = causal (bugfix follows feature)._\n`,
  );
}

export async function exportSession(
  ctx: CommandContext,
  idPrefix: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  let s: CompressedSession | undefined;
  if (idPrefix) {
    s = ctx.store.getById(idPrefix);
  } else {
    const recent = ctx.store.getRecentSessions(1);
    s = recent[0];
  }
  if (!s) {
    stream.markdown(`No session found${idPrefix ? ` for ID "${idPrefix}"` : ''}.\n`);
    return;
  }
  const md = exportSessionMarkdown(s);
  stream.markdown('```markdown\n' + md + '\n```\n');
}

export async function lessons(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const trimmed = query.trim();
  const [verb, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(' ').trim();

  if (verb?.toLowerCase() === 'add') {
    if (!arg) {
      stream.markdown('Usage: `/lessons add <a fact or how-to worth remembering>`\n');
      return;
    }
    const cfg = getConfig();
    const cleanText = redact(arg, {
      redactSecrets: true,
      honorPrivateTags: true,
      customRules: cfg.customRedactionRules,
      customSensitiveEntities: cfg.customSensitiveEntities,
    }).text;
    const lesson = makePinnedLesson(cleanText);
    await ctx.store.addLesson(lesson);
    const kindLabel = lesson.kind === 'procedural' ? 'how-to' : 'fact';
    stream.markdown(`📌 Pinned ${kindLabel} \`${lesson.id.substring(0, 8)}\`: ${lesson.text}\n`);
    return;
  }

  if (verb?.toLowerCase() === 'forget') {
    if (!arg) {
      stream.markdown('Usage: `/lessons forget <lesson-id-prefix>`\n');
      return;
    }
    const removed = await ctx.store.deleteLesson(arg);
    stream.markdown(
      removed ? `🗑️ Forgot lesson \`${arg}\`.\n` : `No lesson found for ID "${arg}".\n`,
    );
    return;
  }

  const all = rankLessons(ctx.store.getLessons());
  if (all.length === 0) {
    stream.markdown(
      'No consolidated lessons yet. They form automatically once a decision or fix recurs ' +
        'across sessions (run `/janitor` to consolidate now), or pin one with `/lessons add <text>`.\n',
    );
    return;
  }
  const facts = all.filter((l) => l.kind === 'semantic');
  const howtos = all.filter((l) => l.kind === 'procedural');
  stream.markdown(`## 🎓 Durable lessons (${all.length})\n\n`);
  const renderRow = (l: (typeof all)[number]): string => {
    const pin = l.pinned ? ' 📌' : '';
    const seen = l.pinned ? '' : ` _(seen ×${l.supportCount})_`;
    const scope = l.scopeLabel ? ` · \`${l.scopeLabel}\`` : '';
    return `- \`${l.id.substring(0, 8)}\`${pin} ${l.text}${seen}${scope}`;
  };
  if (facts.length) {
    stream.markdown(`### Facts\n\n${facts.map(renderRow).join('\n')}\n\n`);
  }
  if (howtos.length) {
    stream.markdown(`### How-to\n\n${howtos.map(renderRow).join('\n')}\n`);
  }
}
