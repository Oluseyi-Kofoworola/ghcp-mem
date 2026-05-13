import * as vscode from 'vscode';
import { ContextStore } from './contextStore';
import { CompressedSession, ObservationType } from './types';
import { computeHealth } from './health';

/**
 * Chat participant implementing progressive disclosure (claude-mem style
 * `search → timeline → detail`) but without any external service.
 */
export class ContextProvider implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly store: ContextStore) {}

  register(): void {
    const p = vscode.chat.createChatParticipant('ghcp-mem', this.handle.bind(this));
    p.iconPath = new vscode.ThemeIcon('history');
    this.disposables.push(p);
  }

  private async handle(
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const cmd = request.command;
    const query = request.prompt.trim();

    switch (cmd) {
      case 'status':   return this.status(stream);
      case 'recent':   return this.recent(stream);
      case 'search':   return this.search(query, stream);
      case 'timeline': return this.timeline(query, stream);
      case 'detail':   return this.detail(query, stream);
      case 'azure':    return this.azure(query, stream);
      case 'health':   return this.health(stream);
      default:
        if (!query || query.toLowerCase() === 'status') return this.status(stream);
        if (query.toLowerCase() === 'recent') return this.recent(stream);
        return this.search(query, stream);
    }
  }

  private async status(stream: vscode.ChatResponseStream): Promise<void> {
    const stats = this.store.getStats();
    stream.markdown(`## Memory Status\n\n`);
    stream.markdown(`- **Total sessions:** ${stats.totalSessions}\n`);
    stream.markdown(`- **This workspace:** ${stats.workspaceSessions}\n`);
    stream.markdown(`- **Redactions applied:** ${stats.totalRedactions}\n`);
    if (stats.oldestSession) stream.markdown(`- **Oldest:** ${new Date(stats.oldestSession).toLocaleDateString()}\n`);
    if (stats.newestSession) stream.markdown(`- **Newest:** ${new Date(stats.newestSession).toLocaleDateString()}\n`);
    stream.markdown(`\n**Commands:** \`/search\`, \`/timeline\`, \`/detail <id>\`, \`/recent\`, \`/azure\`, \`/health\`, \`/status\`\n`);
  }

  private async health(stream: vscode.ChatResponseStream): Promise<void> {
    const h = computeHealth(this.store.getAllSessions());
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

  private async recent(stream: vscode.ChatResponseStream): Promise<void> {
    const recent = this.store.getRecentSessions(5);
    if (recent.length === 0) {
      stream.markdown('_No sessions recorded yet. Keep coding and memory will populate automatically._\n');
      return;
    }
    stream.markdown(`## Recent Sessions\n\n`);
    for (const s of [...recent].reverse()) this.renderCompact(s, stream);
  }

  /**
   * Layer-1 search: returns a compact index (like claude-mem's `search`).
   * Use \`/detail <id>\` to fetch full content for a specific session.
   */
  private async search(query: string, stream: vscode.ChatResponseStream): Promise<void> {
    if (!query) {
      stream.markdown('Please provide a search query.\n');
      return;
    }

    // Parse inline filters: "type:feature since:7d tag:wip foo bar"
    const { cleaned, filters } = parseInlineFilters(query);
    const results = this.store.search(cleaned, filters, 10);

    if (results.length === 0) {
      stream.markdown(`No sessions found for: "${query}"\n`);
      return;
    }

    stream.markdown(`## Search Results (${results.length})\n\n`);
    stream.markdown(`_Token-efficient index. Use \`@mem /detail <id>\` for full content._\n\n`);
    for (const s of results) this.renderIndexRow(s, stream);

    stream.markdown(`\n---\n### Synthesized Context\n\n${synthesize(results, query)}`);
  }

  /** Layer-1b timeline view — chronological window. */
  private async timeline(query: string, stream: vscode.ChatResponseStream): Promise<void> {
    let center = Date.now();
    let windowHours = 24;

    // If query is an ID, center around that session
    const maybe = query && this.store.getById(query);
    if (maybe) center = maybe.startTime;

    // Parse window spec like "72h" or "7d"
    const winMatch = query.match(/(\d+)([hdw])/);
    if (winMatch) {
      const n = parseInt(winMatch[1], 10);
      const unit = winMatch[2];
      windowHours = unit === 'h' ? n : unit === 'd' ? n * 24 : n * 24 * 7;
    }

    const results = this.store.timeline(center, windowHours, 20);
    if (results.length === 0) {
      stream.markdown(`No sessions in ±${windowHours}h window.\n`);
      return;
    }
    stream.markdown(`## Timeline (±${windowHours}h)\n\n`);
    for (const s of results) this.renderIndexRow(s, stream);
  }

  /** Layer-2 detail — fetch full content only after filtering. */
  private async detail(idPrefix: string, stream: vscode.ChatResponseStream): Promise<void> {
    if (!idPrefix) {
      stream.markdown('Provide a session ID (or prefix). Use `@mem /recent` or `/search` to find one.\n');
      return;
    }
    const s = this.store.getById(idPrefix);
    if (!s) {
      stream.markdown(`No session found for ID prefix "${idPrefix}".\n`);
      return;
    }
    this.renderFull(s, stream);
  }

  /**
   * Layer-1 Azure view — sessions that touched Azure resources, grouped by subsystem.
   * Accepts an optional filter (substring matched against summary/topics/files/resourceId).
   */
  private async azure(query: string, stream: vscode.ChatResponseStream): Promise<void> {
    const all = this.store.getAllSessions().filter(s => !!s.azureContext || s.userTags.includes('azure'));
    if (all.length === 0) {
      stream.markdown('_No Azure-tagged sessions yet. Try `GHCP-MEM: Seed Azure Demo Sessions` to see examples, or edit a `.bicep`/`azure.yaml` file._\n');
      return;
    }

    const needle = query.trim().toLowerCase();
    const filtered = !needle ? all : all.filter(s => {
      const hay = [
        s.summary,
        s.keyTopics.join(' '),
        s.keyFiles.join(' '),
        s.azureContext?.resourceGroup ?? '',
        s.azureContext?.subscriptionName ?? '',
        (s.azureContext?.resourceIds ?? []).join(' '),
      ].join(' ').toLowerCase();
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

    stream.markdown(`## Azure sessions (${filtered.length})${needle ? ` matching "${query}"` : ''}\n\n`);
    for (const [subsystem, sessions] of groups) {
      stream.markdown(`### ${subsystem} (${sessions.length})\n\n`);
      for (const s of sessions.slice(0, 6)) {
        const date = new Date(s.startTime).toLocaleDateString();
        const ac = s.azureContext;
        const ctxLine = ac
          ? `  \n  _${[ac.subscriptionName && `sub=${ac.subscriptionName}`, ac.resourceGroup && `rg=${ac.resourceGroup}`].filter(Boolean).join(' · ') || 'azure'}_`
          : '';
        stream.markdown(`- **[${s.observationType}]** \`${s.id.substring(0, 8)}\` · ${date}  \n  ${s.summary.substring(0, 180)}${ctxLine}\n`);
      }
    }

    stream.markdown(`\n_Use \`@mem /detail <id>\` to expand one. Tip: \`#ghcpMemSearch\` in agent mode filters by Azure too._\n`);
  }

  buildStartupContext(): string {
    const recent = this.store.getStartupCandidates(3);
    if (recent.length === 0) return '';
    const lines = ['## Previous Session Context (auto-injected by GHCP-MEM)', ''];
    for (const s of recent) {
      const when = formatInjectTimestamp(s.startTime);
      lines.push(`### ${when} · ${s.observationType} · id:\`${s.id.substring(0, 8)}\``);
      lines.push(s.summary);
      if (s.keyFiles.length) {
        const shown = s.keyFiles.slice(0, 5);
        const extra = s.keyFiles.length > shown.length ? ` (+${s.keyFiles.length - shown.length} more)` : '';
        lines.push(`Files: ${shown.join(', ')}${extra}`);
      }
      if (s.keyTopics.length) lines.push(`Topics: ${s.keyTopics.join(', ')}`);
      if (s.decisions.length) lines.push(`Decisions: ${s.decisions.join('; ')}`);
      if (s.problemsSolved.length) lines.push(`Resolved: ${s.problemsSolved.join('; ')}`);
      if (s.userTags.length) lines.push(`Tags: ${s.userTags.join(', ')}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  // ── Rendering ──

  private renderIndexRow(s: CompressedSession, stream: vscode.ChatResponseStream): void {
    const date = new Date(s.startTime).toLocaleString();
    const tags = s.userTags.length ? ` · 🏷️ ${s.userTags.join(',')}` : '';
    stream.markdown(`- **[${s.observationType}]** \`${s.id.substring(0, 8)}\` · ${date}${tags}  \n  ${s.summary.substring(0, 180)}\n`);
  }

  private renderCompact(s: CompressedSession, stream: vscode.ChatResponseStream): void {
    const start = new Date(s.startTime).toLocaleString();
    const dur = Math.round((s.endTime - s.startTime) / 60000);
    stream.markdown(`### [${s.observationType}] ${start} (${dur} min) · \`${s.id.substring(0, 8)}\`\n\n${s.summary}\n\n`);
    if (s.keyFiles.length) stream.markdown(`**Files:** ${s.keyFiles.slice(0, 5).map(f => `\`${f}\``).join(', ')}\n\n`);
    if (s.keyTopics.length) stream.markdown(`**Topics:** ${s.keyTopics.join(', ')}\n\n`);
  }

  private renderFull(s: CompressedSession, stream: vscode.ChatResponseStream): void {
    const start = new Date(s.startTime).toLocaleString();
    const end = new Date(s.endTime).toLocaleString();
    const dur = Math.round((s.endTime - s.startTime) / 60000);
    stream.markdown(`## Session \`${s.id}\`\n\n`);
    stream.markdown(`- **Type:** ${s.observationType}\n`);
    stream.markdown(`- **Workspace:** ${s.workspaceName}\n`);
    stream.markdown(`- **Started:** ${start}\n- **Ended:** ${end} (${dur} min)\n`);
    stream.markdown(`- **Events captured:** ${s.rawEventCount} · **Redactions:** ${s.redactionCount}\n`);
    if (s.userTags.length) stream.markdown(`- **User tags:** ${s.userTags.join(', ')}\n`);
    if (s.azureContext) {
      const ac = s.azureContext;
      const bits = [
        ac.subscriptionName && `sub=${ac.subscriptionName}`,
        ac.resourceGroup && `rg=${ac.resourceGroup}`,
        ac.defaultLocation && `loc=${ac.defaultLocation}`,
        ac.subsystems?.length && `subsystems=${ac.subsystems.join(',')}`,
      ].filter(Boolean).join(' · ');
      if (bits) stream.markdown(`- **Azure:** ${bits}\n`);
      if (ac.resourceIds?.length) {
        stream.markdown(`- **Resource IDs (${ac.resourceIds.length}):**\n${ac.resourceIds.slice(0, 10).map(r => `  - \`${r}\``).join('\n')}\n`);
      }
    }
    stream.markdown(`\n### Summary\n\n${s.summary}\n\n`);
    if (s.keyFiles.length) stream.markdown(`### Files\n${s.keyFiles.map(f => `- \`${f}\``).join('\n')}\n\n`);
    if (s.keyTopics.length) stream.markdown(`### Topics\n${s.keyTopics.map(t => `- ${t}`).join('\n')}\n\n`);
    if (s.decisions.length) stream.markdown(`### Decisions\n${s.decisions.map(d => `- ${d}`).join('\n')}\n\n`);
    if (s.problemsSolved.length) stream.markdown(`### Problems Solved\n${s.problemsSolved.map(p => `- ${p}`).join('\n')}\n\n`);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

/**
 * Format a startup-inject timestamp as `M/D/YYYY HH:MM` (24h, local).
 * Exported for tests.
 */
export function formatInjectTimestamp(ts: number): string {
  const d = new Date(ts);
  const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
}

/**
 * Parses inline filter tokens from a search query.
 * Supported: `type:feature`, `since:7d`, `tag:wip`, `workspace:true`
 */
function parseInlineFilters(q: string): {
  cleaned: string;
  filters: import('./contextStore').SearchFilters;
} {
  const filters: import('./contextStore').SearchFilters = {};
  const tokens = q.split(/\s+/);
  const remaining: string[] = [];
  for (const tok of tokens) {
    const [k, v] = tok.split(':');
    if (!v) { remaining.push(tok); continue; }
    switch (k.toLowerCase()) {
      case 'type':
        filters.type = v as ObservationType;
        break;
      case 'since': {
        const m = v.match(/^(\d+)([hdw])$/);
        if (m) {
          const n = parseInt(m[1], 10);
          const ms = m[2] === 'h' ? n * 3600000 : m[2] === 'd' ? n * 86400000 : n * 604800000;
          filters.sinceTs = Date.now() - ms;
        }
        break;
      }
      case 'tag': filters.tag = v; break;
      case 'workspace': filters.workspaceOnly = v === 'true'; break;
      default: remaining.push(tok);
    }
  }
  return { cleaned: remaining.join(' '), filters };
}

function synthesize(sessions: CompressedSession[], query: string): string {
  const topics = new Set<string>();
  const files = new Set<string>();
  const decisions: string[] = [];
  const problems: string[] = [];
  for (const s of sessions) {
    s.keyTopics.forEach(t => topics.add(t));
    s.keyFiles.forEach(f => files.add(f));
    decisions.push(...s.decisions);
    problems.push(...s.problemsSolved);
  }
  const out: string[] = [`Based on ${sessions.length} session(s) matching "${query}":\n`];
  if (topics.size) out.push(`**Known topics:** ${Array.from(topics).join(', ')}\n`);
  if (files.size) out.push(`**Active files:** ${Array.from(files).slice(0, 8).map(f => `\`${f}\``).join(', ')}\n`);
  if (decisions.length) {
    out.push('**Decisions:**');
    for (const d of decisions.slice(0, 5)) out.push(`- ${d}`);
    out.push('');
  }
  if (problems.length) {
    out.push('**Previously solved:**');
    for (const p of problems.slice(0, 5)) out.push(`- ${p}`);
  }
  return out.join('\n');
}
