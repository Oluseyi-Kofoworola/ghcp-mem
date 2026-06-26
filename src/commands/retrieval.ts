/**
 * `@mem` retrieval + read-only insight commands — list, search, timeline,
 * detail, entity/lineage lookups, and the status/health/savings summaries.
 *
 * Extracted from contextProvider.ts (Phase 2 god-file decomposition). Free
 * functions over a CommandContext; the provider dispatches with `this`.
 */
import * as vscode from 'vscode';
import { CommandContext } from './context';
import { formatAgo, renderIndexRow, renderCompact, renderFull } from '../sessionRender';
import { getConfig } from '../types';
import { computeHealth } from '../health';
import { matchFilePath } from '../pathMatch';
import { estimateSessionTokenSavings, estimateTokenSavingsUsd } from '../savings';
import { buildEntityRecord, renderEntityMarkdown } from '../entity';
import { getCausalNeighbors, renderCausalNeighbors } from '../causalGraph';
import { parseInlineFilters, synthesize } from '../contextProviderFormat';

export async function status(
  ctx: CommandContext,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const stats = ctx.store.getStats();
  stream.markdown(`## Memory Status\n\n`);
  stream.markdown(`- **Total sessions:** ${stats.totalSessions}\n`);
  stream.markdown(`- **This workspace:** ${stats.workspaceSessions}\n`);
  stream.markdown(`- **Today sessions:** ${stats.todaySessions}\n`);
  stream.markdown(
    `- **Estimated tokens saved today:** ${stats.todayEstimatedTokensSaved.toLocaleString()}\n`,
  );
  stream.markdown(
    `- **Lifetime tokens saved:** ${stats.lifetimeEstimatedTokensSaved.toLocaleString()}\n`,
  );
  stream.markdown(`- **Avg compression ratio:** ${stats.avgCompressionRatio}×\n`);
  stream.markdown(`- **Redactions applied:** ${stats.totalRedactions}\n`);
  if (stats.oldestSession)
    stream.markdown(`- **Oldest:** ${new Date(stats.oldestSession).toLocaleDateString()}\n`);
  if (stats.newestSession)
    stream.markdown(`- **Newest:** ${new Date(stats.newestSession).toLocaleDateString()}\n`);
  stream.markdown(
    `\n> 💡 Run \`@mem /savings\` for a full token-savings breakdown with cost estimates.\n`,
  );
  stream.markdown(
    `\n**Commands:** \`/search\`, \`/timeline\`, \`/detail <id>\`, \`/recent\`, \`/azure\`, \`/health\`, \`/export <id>\`, \`/savings\`\n`,
  );
}

export async function health(
  ctx: CommandContext,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const h = computeHealth(ctx.store.getAllSessions());
  stream.markdown(`## Memory Health: ${h.score}/100  ${h.densityGlyph}\n\n`);
  stream.markdown(`- Total sessions: **${h.totalSessions}**\n`);
  stream.markdown(`- Redaction coverage: **${h.redactionCoveragePct}%**\n`);
  stream.markdown(`- Typed (non-unknown): **${h.typedPct}%**\n`);
  stream.markdown(`- Tagged: **${h.taggedPct}%**\n`);
  stream.markdown(`- Dedup merge rate: **${Math.round(h.dedupRatio * 100)}%**\n`);
  stream.markdown(`- Retention headroom: **${h.retentionHeadroomPct}%**\n`);
  stream.markdown(`- Azure-enriched sessions: **${h.azureSessionCount}**\n`);
  if (h.notes.length) {
    stream.markdown(`\n### Notes\n\n`);
    for (const n of h.notes) stream.markdown(`- ${n}\n`);
  }
}

export async function recent(
  ctx: CommandContext,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const recent = ctx.store.getRecentSessions(5);
  if (recent.length === 0) {
    stream.markdown(
      '_No sessions recorded yet. Keep coding and memory will populate automatically._\n',
    );
    return;
  }
  stream.markdown(`## Recent Sessions\n\n`);
  for (const s of [...recent].reverse()) renderCompact(s, stream);
}

export async function search(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  if (!query) {
    stream.markdown('Please provide a search query.\n');
    return;
  }

  // Parse inline filters: "type:feature since:7d tag:wip foo bar"
  const { cleaned, filters } = parseInlineFilters(query);
  const results = ctx.store.search(cleaned, filters, 10);

  if (results.length === 0) {
    stream.markdown(`No sessions found for: "${query}"\n`);
    return;
  }

  stream.markdown(`## Search Results (${results.length})\n\n`);
  stream.markdown(`_Token-efficient index. Use \`@mem /detail <id>\` for full content._\n\n`);
  // Phase 3 multi-hop: render each row with its supersession lineage and
  // related entities so a single search hop carries the full narrative.
  const enriched = ctx.store.enrichWithMultiHop(results);
  for (const e of enriched) {
    renderIndexRow(e.session, stream);
    // Lineage (≥2 entries means there's a real chain worth showing).
    if (e.lineage.length >= 2) {
      const chain = e.lineage.map((s) => `\`${s.id.substring(0, 8)}\``).join(' → ');
      stream.markdown(`  > 🧭 Lineage: ${chain} *(oldest → current)*\n\n`);
    }
    // "See also" pointers to related entities (max 2 each to keep tokens down).
    const seeAlso: string[] = [];
    for (const sym of e.relatedSymbols.slice(0, 2)) seeAlso.push(`\`@mem /entity ${sym}\``);
    for (const f of e.relatedFiles.slice(0, 2)) {
      if (!e.relatedSymbols.some((sym) => sym.startsWith(f + '#')))
        seeAlso.push(`\`@mem /entity ${f}\``);
    }
    if (seeAlso.length) {
      stream.markdown(`  > 🔗 See also: ${seeAlso.slice(0, 3).join(' · ')}\n\n`);
    }
  }

  stream.markdown(`\n---\n### Synthesized Context\n\n${synthesize(results, query)}`);
}

export async function timeline(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  let center = Date.now();
  let windowHours = 24;

  // If query is an ID, center around that session
  const maybe = query && ctx.store.getById(query);
  if (maybe) center = maybe.startTime;

  // Parse window spec like "72h" or "7d"
  const winMatch = query.match(/(\d+)([hdw])/);
  if (winMatch) {
    const n = parseInt(winMatch[1], 10);
    const unit = winMatch[2];
    windowHours = unit === 'h' ? n : unit === 'd' ? n * 24 : n * 24 * 7;
  }

  const results = ctx.store.timeline(center, windowHours, 20);
  if (results.length === 0) {
    stream.markdown(`No sessions in ±${windowHours}h window.\n`);
    return;
  }
  stream.markdown(`## Timeline (±${windowHours}h)\n\n`);
  for (const s of results) renderIndexRow(s, stream);
}

export async function detail(
  ctx: CommandContext,
  idPrefix: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  if (!idPrefix) {
    stream.markdown(
      'Provide a session ID (or prefix). Use `@mem /recent` or `/search` to find one.\n',
    );
    return;
  }
  const s = ctx.store.getById(idPrefix);
  if (!s) {
    stream.markdown(`No session found for ID prefix "${idPrefix}".\n`);
    return;
  }
  renderFull(s, stream);
}

export async function azure(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const all = ctx.store
    .getAllSessions()
    .filter((s) => !!s.azureContext || s.userTags.includes('azure'));
  if (all.length === 0) {
    stream.markdown(
      '_No Azure-tagged sessions yet. Try `GHCP-MEM: Seed Azure Demo Sessions` to see examples, or edit a `.bicep`/`azure.yaml` file._\n',
    );
    return;
  }

  const needle = query.trim().toLowerCase();
  const filtered = !needle
    ? all
    : all.filter((s) => {
        const hay = [
          s.summary,
          s.keyTopics.join(' '),
          s.keyFiles.join(' '),
          s.azureContext?.resourceGroup ?? '',
          s.azureContext?.subscriptionName ?? '',
          (s.azureContext?.resourceIds ?? []).join(' '),
        ]
          .join(' ')
          .toLowerCase();
        return hay.includes(needle);
      });

  if (filtered.length === 0) {
    stream.markdown(`No Azure sessions matched "${query}".\n`);
    return;
  }

  // Group by first subsystem (fallback 'azure')
  const groups = new Map<string, typeof filtered>();
  for (const s of filtered) {
    const key = s.azureContext?.subsystems?.[0] ?? 'azure';
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }

  stream.markdown(
    `## Azure sessions (${filtered.length})${needle ? ` matching "${query}"` : ''}\n\n`,
  );
  for (const [subsystem, sessions] of groups) {
    stream.markdown(`### ${subsystem} (${sessions.length})\n\n`);
    for (const s of sessions.slice(0, 6)) {
      const date = new Date(s.startTime).toLocaleDateString();
      const ac = s.azureContext;
      const ctxLine = ac
        ? `  \n  _${[ac.subscriptionName && `sub=${ac.subscriptionName}`, ac.resourceGroup && `rg=${ac.resourceGroup}`].filter(Boolean).join(' · ') || 'azure'}_`
        : '';
      stream.markdown(
        `- **[${s.observationType}]** \`${s.id.substring(0, 8)}\` · ${date}  \n  ${s.summary.substring(0, 180)}${ctxLine}\n`,
      );
    }
  }

  stream.markdown(
    `\n_Use \`@mem /detail <id>\` to expand one. Tip: \`#ghcpMemSearch\` in agent mode filters by Azure too._\n`,
  );
}

export async function snippet(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  if (!query.trim()) {
    stream.markdown(
      `Usage: \`/snippet <keywords>\` — returns the top matching decisions, problems, summaries, and topics across all sessions.\n`,
    );
    return;
  }
  const cfg = getConfig();
  const filters: import('../contextStore').SearchFilters = {};
  if (cfg.scope === 'workspace') filters.workspaceOnly = true;
  const hits = ctx.store.searchSnippets(query, filters, 10);
  if (hits.length === 0) {
    stream.markdown(`No snippets found for: "${query}"\n`);
    return;
  }
  stream.markdown(`## 🧩 Snippet Results (${hits.length})\n\n`);
  stream.markdown(`_Chunk-level recall over all sessions. Click an ID for the full session._\n\n`);
  const kindIcon: Record<string, string> = {
    decision: '🧠',
    problem: '🛠',
    summary: '📝',
    topic: '🏷',
  };
  for (const sn of hits) {
    const icon = kindIcon[sn.kind] ?? '·';
    const conf = typeof sn.confidence === 'number' ? ` · conf:${sn.confidence.toFixed(2)}` : '';
    const ts = new Date(sn.emittedAt).toLocaleDateString();
    const sessionLink = `\`${sn.sessionId.substring(0, 8)}\``;
    const files = (sn.evidence ?? [])
      .map((e) => e.filePath)
      .filter((f): f is string => !!f)
      .slice(0, 2);
    const fileTail = files.length ? ` [📎 ${files.join(', ')}]` : '';
    stream.markdown(
      `- ${icon} **${sn.kind}** · ${sessionLink} · ${ts}${conf}\n  ${sn.text}${fileTail}\n\n`,
    );
  }
}

export async function entity(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  let key = query.trim();
  if (!key) {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) key = vscode.workspace.asRelativePath(active);
  }
  if (!key) {
    stream.markdown(
      `Usage: \`/entity <file-path>\` or \`/entity <file-path>#<symbolName>\`. ` +
        `Open a file in the editor to use \`/entity\` without an argument.\n`,
    );
    return;
  }
  const all = ctx.store.getAllSessions();
  const rec = buildEntityRecord(key, all);
  if (!rec) {
    stream.markdown(`_No memory of \`${key}\` yet — try a different path or symbol._\n`);
    return;
  }
  stream.markdown(renderEntityMarkdown(rec));
}

export async function lineage(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const idPrefix = query.trim();
  if (!idPrefix) {
    stream.markdown(
      `Usage: \`/lineage <session-id-prefix>\` — shows predecessors and successors (sessions sharing files within ±30 days).\n`,
    );
    return;
  }
  const target = ctx.store.getById(idPrefix);
  if (!target) {
    stream.markdown(`No session found for ID "${idPrefix}".\n`);
    return;
  }
  const neighbors = getCausalNeighbors(target.id, ctx.store.getAllSessions());
  if (!neighbors) {
    stream.markdown(`Could not compute lineage for "${idPrefix}".\n`);
    return;
  }
  stream.markdown(renderCausalNeighbors(neighbors));
}

export async function related(
  ctx: CommandContext,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!activeFile) {
    stream.markdown(
      '_Open a file in the editor first, then run `@mem /related` to find sessions that touched it._\n',
    );
    return;
  }

  const rel = vscode.workspace.asRelativePath(activeFile);

  // Match by suffix or basename — sessions store relative paths
  const all = ctx.store.getAllSessions();
  const matches = all
    .filter((s) => s.keyFiles.some((f) => matchFilePath(f, rel)))
    .sort((a, b) => b.endTime - a.endTime);

  if (matches.length === 0) {
    stream.markdown(`_No sessions found that touched \`${rel}\`._\n\n`);
    stream.markdown('_Note: only files captured during active coding sessions appear here._\n');
    return;
  }

  stream.markdown(`## 🔗 Sessions touching \`${rel}\`\n\n`);
  stream.markdown(`_${matches.length} session(s) found_\n\n`);

  for (const s of matches.slice(0, 15)) {
    const ago = formatAgo(s.endTime);
    const branch = s.branchName ? ` · \`${s.branchName}\`` : '';
    stream.markdown(
      `### [${s.observationType}] ${new Date(s.startTime).toLocaleDateString()} (${ago}${branch})\n\n`,
    );
    stream.markdown(`${s.summary}\n\n`);
    if (s.decisions.length) {
      stream.markdown(`**Decisions:** ${s.decisions.slice(0, 3).join(' · ')}\n\n`);
    }
    stream.markdown(
      `\`${s.id.substring(0, 8)}\` · _\`@mem /detail ${s.id.substring(0, 8)}\` for full detail_\n\n---\n\n`,
    );
  }
  if (matches.length > 15) {
    stream.markdown(
      `_... and ${matches.length - 15} more. Use \`@mem /search ${rel.split('/').pop() ?? rel}\` to see all._\n`,
    );
  }
}

export async function savings(
  ctx: CommandContext,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const stats = ctx.store.getStats();

  if (stats.totalSessions === 0) {
    stream.markdown(
      '_No sessions stored yet. Keep coding — GHCP-MEM will start tracking context savings automatically._\n',
    );
    return;
  }

  const usd = (tokens: number) => `$${estimateTokenSavingsUsd(tokens).toFixed(4)}`;
  const fmt = (n: number) => n.toLocaleString();
  const sessionRow = (s: {
    summary?: string;
    keyFiles?: string[];
    keyTopics?: string[];
    decisions?: string[];
    problemsSolved?: string[];
  }) => estimateSessionTokenSavings(s);

  // Today's sessions
  const todaySessions = ctx.store.getAllSessions().filter((s) => {
    const d = new Date(s.endTime);
    const now = new Date();
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    );
  });

  stream.markdown(`## 💰 GHCP-MEM Token Savings Report\n\n`);

  // ── Today ──
  stream.markdown(
    `### Today (${stats.todaySessions} session${stats.todaySessions !== 1 ? 's' : ''})\n\n`,
  );
  if (todaySessions.length === 0) {
    stream.markdown('_No sessions captured today yet._\n\n');
  } else {
    stream.markdown('| Session | Raw | Compact | Saved | Ratio |\n');
    stream.markdown('|---------|----:|--------:|------:|------:|\n');
    for (const s of todaySessions.slice(-10)) {
      const r = sessionRow(s);
      const label = (s.summary ?? 'Session').substring(0, 35).replace(/\|/g, '/');
      stream.markdown(
        `| ${label}… | ${fmt(r.rawTokens)} | ${fmt(r.compactTokens)} | **${fmt(r.tokensSaved)}** | ${r.compressionRatio}× |\n`,
      );
    }
    stream.markdown(
      `\n**Today total saved:** ${fmt(stats.todayEstimatedTokensSaved)} tokens ≈ ${usd(stats.todayEstimatedTokensSaved)} (GPT-4o pricing)\n`,
    );
    stream.markdown(
      `**Today raw vs compact:** ${fmt(stats.todayEstimatedRawTokens)} raw tokens → ${fmt(stats.todayEstimatedCompactTokens)} compact tokens\n\n`,
    );
  }

  // ── Lifetime ──
  stream.markdown(`### Lifetime (${fmt(stats.totalSessions)} sessions)\n\n`);
  stream.markdown(`| Metric | Value |\n`);
  stream.markdown(`|--------|-------|\n`);
  stream.markdown(`| Total tokens saved | **${fmt(stats.lifetimeEstimatedTokensSaved)}** |\n`);
  stream.markdown(`| Raw tokens represented | **${fmt(stats.lifetimeEstimatedRawTokens)}** |\n`);
  stream.markdown(
    `| Compact tokens retained | **${fmt(stats.lifetimeEstimatedCompactTokens)}** |\n`,
  );
  stream.markdown(
    `| Dollar equivalent | **${usd(stats.lifetimeEstimatedTokensSaved)}** (GPT-4o) |\n`,
  );
  stream.markdown(`| Avg compression ratio | **${stats.avgCompressionRatio}×** |\n`);
  stream.markdown(
    `| Compact knowledge in memory | **${fmt(stats.totalCompactTokens)} tokens** |\n`,
  );
  stream.markdown(`| Redactions applied | **${fmt(stats.totalRedactions)}** |\n`);

  // ── Interpretation ──
  const perConvSaved =
    stats.totalSessions > 0
      ? Math.round(stats.lifetimeEstimatedTokensSaved / stats.totalSessions)
      : 0;
  stream.markdown(`\n### 💡 What This Means\n\n`);
  stream.markdown(
    `- Each new Copilot chat saves you ~**${fmt(perConvSaved)} tokens** on average — context GHCP-MEM already knows.\n`,
  );
  stream.markdown(
    `- You have **${fmt(stats.totalCompactTokens)} tokens** of knowledge compressed and ready to auto-inject — without re-explaining anything.\n`,
  );
  stream.markdown(
    `- The **${stats.avgCompressionRatio}× avg compression ratio** means every 1 token injected replaces ${stats.avgCompressionRatio} tokens you would otherwise have typed.\n`,
  );

  if (stats.lifetimeEstimatedTokensSaved > 10_000) {
    stream.markdown(
      `\n> 🏆 You've crossed **${fmt(Math.round(stats.lifetimeEstimatedTokensSaved / 1000))}K tokens saved** — that's roughly ${Math.round(stats.lifetimeEstimatedTokensSaved / 750)} pages of context you never had to re-explain!\n`,
    );
  }

  stream.markdown(
    `\n---\n_Estimates: 4 chars/token heuristic · GPT-4o May 2025 input pricing ($5/1M tokens) · Run \`@mem /status\` for a quick summary._\n`,
  );
}
