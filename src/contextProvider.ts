import * as vscode from 'vscode';

import { ContextStore } from './contextStore';
import { getConfig } from './types';

import { GROUP_ORDER, GROUP_HEADINGS, getFollowups, commandsInGroup } from './commandRegistry';

import { redact } from './redactor';

import { renderLessonsForInjection, rankLessons } from './lessons';
import {
  ProjectRule,
  RuleCategory,
  parseRulesFile,
  serializeRulesFile,
  addRule,
  removeRule,
  renderRulesForInjection,
  isKnownCategory,
  RULE_CATEGORIES,
} from './projectRules';
import { formatInjectTimestamp, renderTrustBadge, renderClaimList } from './contextProviderFormat';

import {
  standup,
  commit,
  ask,
  recap,
  whereami,
  debt,
  adr,
  pr,
  precommit,
  decisions,
} from './commands/generation';
import { CommandContext } from './commands/context';
import {
  status,
  health,
  recent,
  search,
  timeline,
  detail,
  azure,
  snippet,
  entity,
  lineage,
  related,
  savings,
} from './commands/retrieval';
import {
  verify,
  correct,
  supersede,
  retract,
  noise,
  accept,
  reject,
  conflicts,
  why,
  janitor,
} from './commands/trust';
import { audit, compliance, route, graph, exportSession, lessons } from './commands/admin';

// Re-exported from ./contextProviderFormat to preserve the historical public
// surface (several of these are imported directly in tests).
export {
  formatInjectTimestamp,
  renderTrustBadge,
  renderClaimList,
  splitIdAndText,
} from './contextProviderFormat';

/**
 * Chat participant implementing progressive disclosure (claude-mem style
 * `search → timeline → detail`) but without any external service.
 *
 * New LM-powered commands:
 *  /standup — AI daily standup note from sessions
 *  /commit   — AI conventional commit message from staged diff + sessions
 *  /ask      — RAG Q&A over full session history
 *  /recap    — AI narrative weekly recap
 */
export class ContextProvider implements vscode.Disposable, CommandContext {
  private disposables: vscode.Disposable[] = [];

  /**
   * Session IDs the developer has evicted ("stale for this task") via
   * `/evict`. In-memory only — the suppression resets when VS Code restarts,
   * mirroring Anthropic's context-editing model where stale tool results are
   * cleared from the working window without touching the durable store.
   * `/pin` removes an id from this set.
   */
  private suppressedForSession = new Set<string>();

  /**
   * In-memory cache of the team-shared project rules parsed from
   * `.github/memory/rules.md`. Refreshed on activation and whenever the file
   * changes (watcher) or a `/rules` command mutates it. Read-only for
   * injection/listing; mutations always re-read the file from disk first so a
   * concurrent hand-edit is never clobbered.
   */
  private projectRules: ProjectRule[] = [];

  /**
   * Hook the extension installs so a `/rules` mutation immediately rewrites
   * the generated startup + cross-editor context files (instead of waiting for
   * the file watcher to fire).
   */
  private rulesChangedHook?: () => Promise<void> | void;

  constructor(public readonly store: ContextStore) {}

  /** Install the callback invoked after a `/rules` command edits the file. */
  setRulesChangedHook(fn: () => Promise<void> | void): void {
    this.rulesChangedHook = fn;
  }

  register(): void {
    const p = vscode.chat.createChatParticipant('ghcp-mem', this.handle.bind(this));
    p.iconPath = new vscode.ThemeIcon('history');
    p.followupProvider = {
      provideFollowups(
        _result: vscode.ChatResult,
        context: vscode.ChatContext,
      ): vscode.ChatFollowup[] {
        const last = context.history[context.history.length - 1];
        const cmd = last instanceof vscode.ChatRequestTurn ? last.command : undefined;
        // Follow-up chips are declared once in commandRegistry.ts so they can
        // never drift from the dispatch/help surfaces.
        return getFollowups(cmd).map((chip) => ({
          prompt: '',
          command: chip.command,
          label: chip.label,
          participant: 'ghcp-mem',
        }));
      },
    };
    this.disposables.push(p);
  }

  private async handle(
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const cmd = request.command;
    const query = request.prompt.trim();

    switch (cmd) {
      case 'status':
        return status(this, stream);
      case 'recent':
        return recent(this, stream);
      case 'search':
        return search(this, query, stream);
      case 'timeline':
        return timeline(this, query, stream);
      case 'detail':
        return detail(this, query, stream);
      case 'azure':
        return azure(this, query, stream);
      case 'health':
        return health(this, stream);
      case 'export':
        return exportSession(this, query, stream);
      case 'standup':
        return standup(this, query, stream, request, token);
      case 'commit':
        return commit(this, stream, request, token);
      case 'ask':
        return ask(this, query, stream, request, token);
      case 'recap':
        return recap(this, query, stream, request, token);
      case 'savings':
        return savings(this, stream);
      case 'related':
        return related(this, stream);
      case 'decisions':
        return decisions(this, query, stream, request, token);
      case 'whereami':
        return whereami(this, stream, request, token);
      case 'debt':
        return debt(this, stream, request, token);
      case 'adr':
        return adr(this, query, stream, request, token);
      case 'pr':
        return pr(this, query, stream, request, token);
      case 'precommit':
        return precommit(this, stream, request, token);
      case 'audit':
        return audit(this, stream);
      case 'verify':
        return verify(this, query, stream);
      case 'correct':
        return correct(this, query, stream);
      case 'supersede':
        return supersede(this, query, stream);
      case 'retract':
        return retract(this, query, stream);
      case 'noise':
        return noise(this, query, stream);
      case 'janitor':
        return janitor(this, stream);
      case 'accept':
        return accept(this, query, stream);
      case 'reject':
        return reject(this, query, stream);
      case 'entity':
        return entity(this, query, stream);
      case 'snippet':
        return snippet(this, query, stream);
      case 'conflicts':
        return conflicts(this, query, stream);
      case 'lineage':
        return lineage(this, query, stream);
      case 'why':
        return why(this, query, stream);
      case 'graph':
        return graph(this, query, stream);
      case 'compliance':
        return compliance(this, stream);
      case 'route':
        return route(this, query, stream);
      case 'lessons':
        return lessons(this, query, stream);
      case 'rules':
        return this.rules(query, stream);
      case 'pin':
        return this.pin(query, stream);
      case 'evict':
        return this.evict(query, stream);
      case 'help':
      case '?':
        return this.help(stream);
      default:
        if (!query || query.toLowerCase() === 'status') return status(this, stream);
        if (query.toLowerCase() === 'recent') return recent(this, stream);
        return search(this, query, stream);
    }
  }

  /**
   * Self-discovery command — added in v1.11.0 in response to a review that
   * called out 41 slash commands with no in-chat catalog and inconsistent
   * follow-up chip coverage. Groups the surface so users can scan by intent
   * (retrieval / trust / authoring / generation / admin) instead of scrolling
   * the entire alphabetical list.
   */
  private async help(stream: vscode.ChatResponseStream): Promise<void> {
    stream.markdown('### `@mem` commands\n\n');
    stream.markdown(
      'Type any of these in Copilot Chat. Most take a query; a few take an `<id>` ' +
        '(use `/recent` or `/search` to find one). Square brackets denote optional args. ' +
        '⚗️ marks experimental commands.\n\n',
    );

    // Rendered from the single command registry (commandRegistry.ts) so the
    // catalogue can never drift from the dispatch + follow-up surfaces.
    for (const group of GROUP_ORDER) {
      const specs = commandsInGroup(group);
      if (specs.length === 0) continue;
      stream.markdown(`#### ${GROUP_HEADINGS[group]}\n\n`);
      stream.markdown('| Command | What it does |\n|---|---|\n');
      for (const spec of specs) {
        // Escape pipes so command syntax doesn't break the markdown table.
        const cmdEsc = spec.signature.replace(/\|/g, '\\|');
        const desc = spec.tier === 'experimental' ? `⚗️ ${spec.description}` : spec.description;
        stream.markdown(`| \`${cmdEsc}\` | ${desc} |\n`);
      }
      stream.markdown('\n');
    }

    stream.markdown(
      '\n_Tip: every command above also has a follow-up chip after typical results — you usually never need to remember the name._\n',
    );
  }

  /**
   * Layer-1 search: returns a compact index (like claude-mem's `search`).
   * Use \`/detail <id>\` to fetch full content for a specific session.
   */

  /** Layer-1b timeline view — chronological window. */

  /** Layer-2 detail — fetch full content only after filtering. */

  /**
   * Layer-1 Azure view — sessions that touched Azure resources, grouped by subsystem.
   * Accepts an optional filter (substring matched against summary/topics/files/resourceId).
   */

  // ── Phase 2 Slice A: trust + correction commands ────────────────────────

  /**
   * `/verify <id>` — re-run grounding validation on a session and surface a
   * per-file breakdown. Lets developers spot-check whether a memory is still
   * supported by the current code or has drifted/broken.
   */

  /**
   * `/correct <id> <text>` — capture a correction note as a new session,
   * link it to the original, and supersede the original. Both rows are
   * kept on disk so the audit trail survives.
   */

  /**
   * `/supersede <newerId> <olderId>` — mark one existing session as
   * superseding another. Both rows are retained.
   */

  /**
   * `/retract <id> [reason]` — exclude a session from retrieval and
   * injection. `/retract undo <id>` reverses the action.
   */

  /**
   * `/noise <id>` — mark a session as low-quality so it stops appearing
   * in startup injection and retrieval. `/noise undo <id>` reverses it.
   */

  /**
   * `/janitor` — manually run the quality re-scorer over every stored
   * session. Useful after raising or lowering `ghcpMem.qualityFloor`.
   */

  /**
   * `/accept <id>` — strengthen a session's reinforcement signal so
   * subsequent searches rank it higher. Surfaced to developers as the
   * "I actually used this memory" handshake.
   */

  /**
   * `/reject <id>` — weaken a session's reinforcement signal. Use when a
   * retrieved memory was wrong or stale.
   */

  /**
   * `/entity <key>` — aggregate every session that touched a file path or
   * LSP symbol into a single focused summary. Key auto-detects:
   *   - "src/auth.ts"            → file entity
   *   - "src/auth.ts#hashPassword" → symbol entity (anything containing '#')
   * When no key is supplied, falls back to the file currently open in the
   * active editor so `@mem /entity` "just works" mid-coding.
   */

  /**
   * `/snippet <query>` — chunk-level retrieval. Returns the top decisions,
   * problems, summaries, or topics matching the query — each with its
   * source session ID so the developer can drill in with `/detail`.
   *
   * Useful when you want the exact decision text ("we use bcrypt cost 12")
   * rather than a session-card blob that buries the answer.
   */

  /** `/conflicts [dismiss <id> [reason]]` — list or dismiss pending conflict warnings. */

  /** `/lineage <id>` — render the cross-session causal chain for a session. */

  /**
   * `/why <query> :: <session-id-prefix>` — score-decomposition explainer.
   *
   * Format: `/why <query terms> :: <id>` (separator is ` :: ` to keep IDs
   * with hyphens parseable). When no `::` is provided we treat the whole
   * string as an ID and use the most-recent retrieved session's query if
   * available.
   */

  /**
   * `/graph` — emit the full decision graph as a Mermaid flowchart.
   *
   * Optional filter: `/graph file:src/auth.ts` restricts to sessions that
   * touch the file. Output is a fenced ```mermaid block ready to paste
   * into a PR, ADR, or docs page.
   */

  /**
   * `/compliance` — print an audit-friendly posture report: grounding
   * coverage, trust distribution, conflict counts, redaction stats,
   * custom-entity inventory. Ideal for enterprise security reviews.
   */

  /**
   * `/route <query>` — context-acquisition recommender. Tells you (or the
   * calling agent) whether a question is cheapest answered via MCP tools
   * or via a file open, and estimates the token cost of each option.
   *
   * Auto-resolves the byte size of any file path mentioned in the query so
   * the per-action estimate reflects the actual workspace, not a guess.
   */

  /**
   * `/lessons` — list the consolidated semantic + procedural lessons.
   * `/lessons add <text>` pins a hand-authored lesson (the hot-path
   * "remember this" write). `/lessons forget <id>` deletes one.
   */

  // ── Durable project memory rules (team-shared, git-committed) ──

  /** Workspace-relative URI of the canonical rules file, or undefined if no workspace. */
  private rulesFileUri(): vscode.Uri | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!ws) return undefined;
    return vscode.Uri.joinPath(ws, '.github', 'memory', 'rules.md');
  }

  /** Read + parse the rules file from disk (empty list when absent/unreadable). */
  private async readRulesFromDisk(): Promise<ProjectRule[]> {
    const uri = this.rulesFileUri();
    if (!uri) return [];
    try {
      const buf = await vscode.workspace.fs.readFile(uri);
      return parseRulesFile(Buffer.from(buf).toString('utf-8'));
    } catch {
      return [];
    }
  }

  /** Refresh the in-memory rules cache from disk. Called on activation + file change. */
  async refreshProjectRules(): Promise<void> {
    this.projectRules = await this.readRulesFromDisk();
  }

  /** Redact a rule's text so a hand-edited secret never reaches a generated file. */
  private redactRule(r: ProjectRule): ProjectRule {
    const cfg = getConfig();
    const text = redact(r.text, {
      redactSecrets: true,
      honorPrivateTags: true,
      customRules: cfg.customRedactionRules,
      customSensitiveEntities: cfg.customSensitiveEntities,
    }).text;
    return { ...r, text };
  }

  /** The redacted rules block for startup injection (empty string when disabled/empty). */
  buildProjectRulesBlock(): string {
    if (!getConfig().projectRules) return '';
    const redacted = this.projectRules.map((r) => this.redactRule(r));
    return renderRulesForInjection(redacted);
  }

  /**
   * `/rules` — list the team-shared project rules.
   * `/rules add [category:]<text>` — append a rule (redacted) and commit-ready.
   * `/rules remove <id|index>` — delete a rule.
   */
  private async rules(query: string, stream: vscode.ChatResponseStream): Promise<void> {
    const trimmed = query.trim();
    const [verb, ...rest] = trimmed.split(/\s+/);
    const arg = rest.join(' ').trim();
    const lc = verb?.toLowerCase();

    if (!this.rulesFileUri()) {
      stream.markdown('Open a workspace folder to use project rules.\n');
      return;
    }

    if (lc === 'add') {
      return this.rulesAdd(arg, stream);
    }
    if (lc === 'remove' || lc === 'rm' || lc === 'forget') {
      return this.rulesRemove(arg, stream);
    }

    // Default: list. Always read fresh so the listing reflects hand-edits.
    const rules = await this.readRulesFromDisk();
    this.projectRules = rules;
    if (rules.length === 0) {
      stream.markdown(
        'No project rules yet. Add one with `/rules add <text>` ' +
          '(optionally `/rules add architecture: all writes go through contextStore`). ' +
          'Rules live in `.github/memory/rules.md` — commit it to share with your team.\n',
      );
      return;
    }
    stream.markdown(`## 📐 Project Memory Rules (${rules.length})\n\n`);
    stream.markdown('_Source: `.github/memory/rules.md` · injected first in every session._\n\n');
    let idx = 0;
    for (const cat of RULE_CATEGORIES) {
      const inCat = rules.filter((r) => r.category === cat);
      if (inCat.length === 0) continue;
      stream.markdown(`### ${cat[0].toUpperCase()}${cat.slice(1)}\n\n`);
      for (const r of inCat) {
        idx++;
        const shown = this.redactRule(r).text;
        stream.markdown(`${idx}. \`${r.id.substring(0, 8)}\` ${shown}\n`);
      }
      stream.markdown('\n');
    }
  }

  private async rulesAdd(arg: string, stream: vscode.ChatResponseStream): Promise<void> {
    if (!arg) {
      stream.markdown(
        'Usage: `/rules add [category:]<text>` — category is one of ' +
          `${RULE_CATEGORIES.join(', ')}.\n`,
      );
      return;
    }
    // Treat a leading `word:` as a category only when it names a known one,
    // so rules containing URLs / `C:\` / "Note: ..." aren't misparsed.
    let category: RuleCategory = 'general';
    let body = arg;
    const m = /^([A-Za-z]+)\s*:\s*(.+)$/.exec(arg);
    if (m && isKnownCategory(m[1])) {
      category = m[1].toLowerCase() as RuleCategory;
      body = m[2].trim();
    }
    const cfg = getConfig();
    const cleanText = redact(body, {
      redactSecrets: true,
      honorPrivateTags: true,
      customRules: cfg.customRedactionRules,
      customSensitiveEntities: cfg.customSensitiveEntities,
    }).text;
    if (cleanText.trim().length < 3) {
      stream.markdown('Rule text is too short after redaction — nothing added.\n');
      return;
    }

    // Read fresh from disk so a concurrent hand-edit isn't clobbered.
    const current = await this.readRulesFromDisk();
    const { rules, rule, added } = addRule(current, cleanText, category);
    if (!added) {
      stream.markdown(`That rule already exists as \`${rule.id.substring(0, 8)}\`.\n`);
      return;
    }
    await this.writeRulesFile(rules);
    stream.markdown(
      `📐 Added **${category}** rule \`${rule.id.substring(0, 8)}\`: ${rule.text}\n\n` +
        '_Commit `.github/memory/rules.md` to share it with your team._\n',
    );
  }

  private async rulesRemove(arg: string, stream: vscode.ChatResponseStream): Promise<void> {
    if (!arg) {
      stream.markdown('Usage: `/rules remove <rule-id-prefix | list-number>`\n');
      return;
    }
    const current = await this.readRulesFromDisk();
    const result = removeRule(current, arg);
    if (result.ambiguous) {
      stream.markdown(`Id prefix "${arg}" matches more than one rule — use a longer prefix.\n`);
      return;
    }
    if (!result.removed) {
      stream.markdown(`No rule found for "${arg}".\n`);
      return;
    }
    await this.writeRulesFile(result.rules);
    stream.markdown(`🗑️ Removed rule \`${result.removed.id.substring(0, 8)}\`.\n`);
  }

  /** Persist the rule list, refresh the cache, and rewrite generated context. */
  private async writeRulesFile(rules: ProjectRule[]): Promise<void> {
    const uri = this.rulesFileUri();
    if (!uri) return;
    const dir = vscode.Uri.joinPath(uri, '..');
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeRulesFile(rules), 'utf-8'));
    this.projectRules = rules;
    await this.rulesChangedHook?.();
  }

  /**
   * `/pin <session-id>` — un-evict a session that was suppressed for this
   * task with `/evict`, returning it to the injected working set.
   */
  private async pin(query: string, stream: vscode.ChatResponseStream): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) {
      stream.markdown('Usage: `/pin <session-id-prefix>`\n');
      return;
    }
    const target = this.store.getById(trimmed);
    if (!target) {
      stream.markdown(`No session found for ID "${trimmed}".\n`);
      return;
    }
    if (this.suppressedForSession.delete(target.id)) {
      stream.markdown(`📌 \`${target.id.substring(0, 8)}\` is back in the injected working set.\n`);
    } else {
      stream.markdown(`\`${target.id.substring(0, 8)}\` was not evicted — nothing to pin.\n`);
    }
  }

  /**
   * `/evict <session-id>` — drop a session from the injected working set for
   * the remainder of this VS Code session without deleting it from the store.
   * Mirrors Anthropic's context-editing: clear stale material from the
   * working window, keep it durable on disk. `/pin` reverses it.
   */
  private async evict(query: string, stream: vscode.ChatResponseStream): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) {
      stream.markdown('Usage: `/evict <session-id-prefix>`\n');
      return;
    }
    const target = this.store.getById(trimmed);
    if (!target) {
      stream.markdown(`No session found for ID "${trimmed}".\n`);
      return;
    }
    this.suppressedForSession.add(target.id);
    stream.markdown(
      `🚫 Evicted \`${target.id.substring(0, 8)}\` from the injected working set for this session. ` +
        `Run \`/pin ${target.id.substring(0, 8)}\` to bring it back (the session stays on disk).\n`,
    );
  }

  buildStartupContext(): string {
    const config = getConfig();
    const recent = this.store.getStartupCandidates(config.startupContextSessionCount);
    const rulesBlock = this.buildProjectRulesBlock();
    const lessonsBlock = renderLessonsForInjection(rankLessons(this.store.getLessons()));
    // Nothing to inject? Signal the caller to remove any stale generated file.
    if (recent.length === 0 && !rulesBlock && !lessonsBlock) return '';

    const lines = ['## Previous Session Context (auto-injected by GHCP-MEM)', ''];

    // Project memory rules are binding, team-authored directives — they go
    // first, ahead of the routing primer and any episodic detail.
    if (rulesBlock) {
      lines.push(rulesBlock, '');
    }

    // Phase 9 routing primer: teaches the agent to prefer GHCP-MEM MCP/chat
    // tools over file open for lookup-style questions. Only worth injecting
    // when there is actually memory to route to (sessions or lessons).
    if (recent.length > 0 || lessonsBlock) {
      lines.push(
        '### How to gather context cheaply',
        'Before reading source files, check whether the question is about',
        'project HISTORY (what was decided / fixed / why) vs CODE (need to',
        'modify or read current state). Prefer GHCP-MEM tools for history:',
        '',
        '- "why did we / what was decided / how does X work" →',
        '  `@mem /entity <path>`, `@mem /snippet <q>`, or MCP `ghcpMem_entity` / `ghcpMem_snippets` (~200–500 tokens vs typically 2000–10000 for a file).',
        '- "find where X is used / show me past errors / who touched Y" →',
        '  `@mem /search <q>` or MCP `ghcpMem_search` (~250 tokens).',
        '- "what is the supersession chain / lineage for X" →',
        '  `@mem /lineage <id>` or MCP `ghcpMem_lineage` (~350 tokens).',
        '- "explain why this session ranked above that one" →',
        '  `@mem /why <q> :: <id>` or MCP `ghcpMem_explain`.',
        '- Unsure which is cheaper? Call `@mem /route <question>` or MCP',
        '  `ghcpMem_route` first — it returns a token-cost estimate per option.',
        '',
        'Only open / attach files when you need to MODIFY or read current',
        'source. For "what / why / when / who" questions about project',
        'history, the memory tools are typically 5–20× cheaper.',
        '',
      );
    }
    // Consolidated semantic + procedural lessons go right after the routing
    // primer and before the raw session cards: durable, distilled knowledge
    // first, then the episodic detail it was drawn from.
    if (lessonsBlock) {
      lines.push(lessonsBlock, '');
    }
    for (const s of recent) {
      if (this.suppressedForSession.has(s.id)) continue;
      const when = formatInjectTimestamp(s.startTime);
      const branch = s.branchName ? ` · branch:\`${s.branchName}\`` : '';
      const workspace = s.workspaceName ? ` · workspace:\`${s.workspaceName}\`` : '';
      const trust = renderTrustBadge(s);
      lines.push(
        `### ${when} · ${s.observationType} · id:\`${s.id.substring(0, 8)}\`${trust}${branch}${workspace}`,
      );
      lines.push(s.summary);
      if (s.keyFiles.length) {
        const shown = s.keyFiles.slice(0, 8);
        const extra =
          s.keyFiles.length > shown.length ? ` (+${s.keyFiles.length - shown.length} more)` : '';
        lines.push(`Files: ${shown.join(', ')}`);
        if (extra) lines[lines.length - 1] += extra;
      }
      if (s.keyTopics.length) lines.push(`Topics: ${s.keyTopics.join(', ')}`);
      if (s.decisions.length) {
        lines.push(`Decisions: ${renderClaimList(s.decisions, s.decisionEvidence)}`);
      }
      if (s.problemsSolved.length) {
        lines.push(`Resolved: ${renderClaimList(s.problemsSolved, s.problemEvidence)}`);
      }
      if (s.azureContext?.subsystems?.length) {
        lines.push(`Azure: ${s.azureContext.subsystems.join(', ')}`);
      }
      if (s.userTags.length) lines.push(`Tags: ${s.userTags.join(', ')}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * `/export <id|prefix>` — emit a session as a diff-friendly markdown block
   * inline in the chat. Handy for pasting into a PR description, a design
   * doc, or commit message. Falls back to "most recent" when no id is given.
   */

  // ── LM-powered smart commands ──

  /**
   * `/standup [yesterday]` — Generate a professional daily standup note
   * from the last 24 h of coding sessions. Pass "yesterday" to scope to
   * the previous calendar day.
   */

  /**
   * `/commit` — Generate a conventional commit message from the current
   * git staged diff and any sessions that overlap the staged files.
   */

  /**
   * `/ask <question>` — RAG question-answering over the full session history.
   * Finds the most relevant sessions via BM25 and uses the LM to synthesise
   * a grounded, cited answer.
   */

  /**
   * `/recap [7d|30d|this week|this month]` — AI narrative recap for
   * retrospectives, weekly reviews, or knowledge transfer docs.
   */

  // ── Token Savings ──

  // ── Where Am I? ──

  /**
   * `/whereami` — precise interruption-recovery brief.
   * "You were in the middle of X. Last file touched: Y. These things were left TODO."
   * Designed for returning after hours/days away and getting back into flow instantly.
   */

  // ── Technical Debt Ledger ──

  /**
   * `/debt` — extract and surface technical debt signals from session history.
   * Parses sessions for TODO/FIXME/HACK/workaround/shortcut signals,
   * groups by file and age, and generates an AI prioritisation.
   */

  // ── Auto-generated ADRs ──

  /**
   * `/adr [topic]` — generate a formal Architecture Decision Record from
   * session history. Goes beyond `/decisions` by producing a structured
   * ADR document: Title / Status / Context / Decision / Consequences.
   */

  // ── PR Review Context Injection ──

  /**
   * `/pr [branch-or-number]` — surface sessions that touched the same files
   * as a pull request or branch diff, giving reviewers full history context.
   * If no branch given, uses the current git branch diff against main/master.
   */

  // ── Pre-commit Architectural Consistency Check ──

  /**
   * `/precommit` — check staged diff against past architectural decisions.
   * Flags potential regressions before they land in the codebase.
   */

  // ── Related files ──

  /**
   * `/related` — show sessions that touched the currently active editor file.
   * Zero typing needed: just open a file and run `@mem /related`.
   */

  /** Format a timestamp as a human-readable "X ago" string. */

  // ── Architecture Decisions ──

  /**
   * `/decisions [filter]` — extract all decisions across sessions into a
   * structured ADR-style document. Optionally filter by keyword.
   * Great for documentation, retros, and onboarding new teammates.
   */

  /**
   * `/savings` — full token-savings breakdown with per-session table,
   * lifetime totals, compression ratio, and dollar-equivalent estimates.
   */

  /** Stream a language model response into the chat stream. */
  async streamLm(
    prompt: string,
    stream: vscode.ChatResponseStream,
    request: vscode.ChatRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    try {
      const response = await request.model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        token,
      );
      for await (const chunk of response.stream) {
        if (chunk instanceof vscode.LanguageModelTextPart) {
          stream.markdown(chunk.value);
        }
      }
    } catch (err) {
      stream.markdown(
        `\n\n_Error calling language model: ${err instanceof Error ? err.message : String(err)}_\n`,
      );
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
