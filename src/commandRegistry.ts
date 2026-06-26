/**
 * Single source of truth for the `@mem` chat command surface.
 *
 * Before this module the surface was defined in THREE places inside
 * `contextProvider.ts` — the dispatch switch, the hand-maintained `/help`
 * catalogue, and the follow-up-chip switch — which had to be kept in sync by
 * hand. That triplication was a documented drift-bug class (a command could be
 * dispatchable but missing from help, or a follow-up chip could point at a
 * command that no longer existed). The registry collapses help + follow-ups to
 * one declarative table so those two can never drift again, and adds a
 * `tier` field (`core` vs `experimental`) so polish/test budget can be
 * concentrated on the daily-driver commands.
 *
 * Kept free of `vscode` imports so it can be unit-tested as a plain module and
 * reused by any non-extension host (e.g. the MCP server) later.
 */

/** Help-catalogue heading a command is filed under. */
export type CommandGroup = 'retrieval' | 'trust' | 'authoring' | 'generation' | 'admin';

/**
 * Maturity tier. `core` = daily-driver commands that get first-class polish and
 * test coverage; `experimental` = deeper insight/graph/consolidation features
 * that are useful but lower-traffic. Surfaced in `/help` with a legend marker.
 */
export type CommandTier = 'core' | 'experimental';

/** A follow-up chip rendered after a command's typical result. */
export interface FollowupChip {
  command: string;
  label: string;
}

/** Declarative description of one `@mem` slash command. */
export interface CommandSpec {
  /** Primary command name (without the leading slash). */
  name: string;
  /** Alternative names that route to the same handler. */
  aliases?: string[];
  group: CommandGroup;
  tier: CommandTier;
  /** Argument-shape string shown in the `/help` table. */
  signature: string;
  /** One-line description shown in the `/help` table. */
  description: string;
  /** Follow-up chips offered after this command runs. */
  followups?: FollowupChip[];
}

/** Ordered group headings — controls the section order rendered by `/help`. */
export const GROUP_ORDER: CommandGroup[] = [
  'retrieval',
  'trust',
  'authoring',
  'generation',
  'admin',
];

export const GROUP_HEADINGS: Record<CommandGroup, string> = {
  retrieval: '🔍 Retrieval',
  trust: '✅ Trust + correction',
  authoring: '✍️ Authoring',
  generation: '✏️ Generation',
  admin: '🛡 Admin + insight',
};

/**
 * Follow-up chips shown when a command has no command-specific set (and after
 * free-text queries). Mirrors the historical `default` branch of the old
 * follow-up switch.
 */
export const DEFAULT_FOLLOWUPS: FollowupChip[] = [
  { command: 'recent', label: '$(history) Recent sessions' },
  { command: 'health', label: '$(pulse) Memory health' },
];

/**
 * The command surface. Order within a group is the order rendered in `/help`.
 */
export const COMMAND_REGISTRY: CommandSpec[] = [
  // ── 🔍 Retrieval ──────────────────────────────────────────────────────────
  {
    name: 'search',
    group: 'retrieval',
    tier: 'core',
    signature: '/search <query> [type:X since:Yd tag:Z]',
    description: 'fused keyword+recency+embedding search',
    followups: [
      { command: 'recent', label: '$(history) Show recent sessions' },
      { command: 'health', label: '$(pulse) Check memory health' },
    ],
  },
  {
    name: 'recent',
    group: 'retrieval',
    tier: 'core',
    signature: '/recent',
    description: 'last N captured sessions, newest first',
    followups: [
      { command: 'search', label: '$(search) Search sessions…' },
      { command: 'timeline', label: '$(calendar) View timeline' },
    ],
  },
  {
    name: 'timeline',
    group: 'retrieval',
    tier: 'core',
    signature: '/timeline [days]',
    description: 'chronological view of recent activity',
    followups: [{ command: 'search', label: '$(search) Search sessions…' }],
  },
  {
    name: 'detail',
    group: 'retrieval',
    tier: 'core',
    signature: '/detail <id|prefix>',
    description: 'full structured row for one session',
  },
  {
    name: 'snippet',
    group: 'retrieval',
    tier: 'experimental',
    signature: '/snippet <query>',
    description: 'chunk-level retrieval inside sessions',
  },
  {
    name: 'entity',
    group: 'retrieval',
    tier: 'experimental',
    signature: '/entity <path[#symbol]>',
    description: 'every session that touched a file/symbol',
  },
  {
    name: 'lineage',
    group: 'retrieval',
    tier: 'experimental',
    signature: '/lineage <id>',
    description: 'predecessor → successor chain for one session',
  },
  {
    name: 'related',
    group: 'retrieval',
    tier: 'core',
    signature: '/related',
    description: 'sessions that touched the file currently open in the editor',
  },

  // ── ✅ Trust + correction ──────────────────────────────────────────────────
  {
    name: 'verify',
    group: 'trust',
    tier: 'core',
    signature: '/verify <id>',
    description: 'per-file verified/drifted/missing classification',
  },
  {
    name: 'correct',
    group: 'trust',
    tier: 'core',
    signature: '/correct <id> <text>',
    description: 'create a linked correction; supersedes the original',
  },
  {
    name: 'supersede',
    group: 'trust',
    tier: 'experimental',
    signature: '/supersede <newer> <older>',
    description: 'mark one session as superseding another',
  },
  {
    name: 'retract',
    group: 'trust',
    tier: 'experimental',
    signature: '/retract <id> [reason] · /retract undo <id>',
    description: 'exclude from retrieval (reversible)',
  },
  {
    name: 'noise',
    group: 'trust',
    tier: 'experimental',
    signature: '/noise <id> · /noise undo <id>',
    description: 'flag as low-quality + feed adaptive ranker',
  },
  {
    name: 'accept',
    group: 'trust',
    tier: 'experimental',
    signature: '/accept <id>',
    description: 'thumbs-up — reinforces ranking weights',
  },
  {
    name: 'reject',
    group: 'trust',
    tier: 'experimental',
    signature: '/reject <id>',
    description: 'thumbs-down — reinforces ranking weights',
  },
  {
    name: 'conflicts',
    group: 'trust',
    tier: 'experimental',
    signature: '/conflicts',
    description: 'list contradiction-marker warnings; `dismiss <id>` to clear',
  },
  {
    name: 'why',
    group: 'trust',
    tier: 'experimental',
    signature: '/why <query> :: <id>',
    description: 'per-signal score breakdown for one ranking decision',
  },

  // ── ✍️ Authoring ───────────────────────────────────────────────────────────
  {
    name: 'lessons',
    group: 'authoring',
    tier: 'experimental',
    signature: '/lessons [add|remove|pin|unpin]',
    description: 'consolidated semantic + procedural memory',
  },
  {
    name: 'rules',
    group: 'authoring',
    tier: 'core',
    signature: '/rules [add|remove|list]',
    description: 'team-shared project rules (`.github/memory/rules.md`)',
  },
  {
    name: 'pin',
    group: 'authoring',
    tier: 'core',
    signature: '/pin <id> · /unpin <id>',
    description: 'force-include in startup brief',
  },
  {
    name: 'evict',
    group: 'authoring',
    tier: 'core',
    signature: '/evict <id>',
    description: 'remove from working set without deleting the row',
  },

  // ── ✏️ Generation ──────────────────────────────────────────────────────────
  {
    name: 'whereami',
    group: 'generation',
    tier: 'core',
    signature: '/whereami',
    description: 'one-screen "what was I doing here?" briefing',
    followups: [
      { command: 'debt', label: '$(warning) Show tech debt' },
      { command: 'standup', label: '$(calendar) Daily standup' },
    ],
  },
  {
    name: 'standup',
    group: 'generation',
    tier: 'core',
    signature: '/standup',
    description: 'yesterday/today/blockers shaped from recent sessions',
    followups: [
      { command: 'recap', label: '$(book) Weekly recap' },
      { command: 'commit', label: '$(git-commit) Generate commit' },
    ],
  },
  {
    name: 'commit',
    group: 'generation',
    tier: 'core',
    signature: '/commit [--check]',
    description: 'commit message draft (or `--check` to pre-flight)',
    followups: [{ command: 'standup', label: '$(calendar) Daily standup' }],
  },
  {
    name: 'precommit',
    group: 'generation',
    tier: 'core',
    signature: '/precommit',
    description: 'consistency pre-flight against staged diff (alias for /commit --check)',
    followups: [
      { command: 'commit', label: '$(git-commit) Generate commit message' },
      { command: 'debt', label: '$(warning) Show tech debt' },
    ],
  },
  {
    name: 'adr',
    group: 'generation',
    tier: 'core',
    signature: '/adr <topic>',
    description: 'draft an ADR from related session decisions',
    followups: [
      { command: 'decisions', label: '$(list-ordered) All decisions' },
      { command: 'precommit', label: '$(git-commit) Pre-commit check' },
    ],
  },
  {
    name: 'pr',
    group: 'generation',
    tier: 'core',
    signature: '/pr [base]',
    description: 'pull-request title + body grounded in branch history',
    followups: [
      { command: 'decisions', label: '$(list-ordered) Architecture decisions' },
      { command: 'search', label: '$(search) Search sessions' },
    ],
  },
  {
    name: 'recap',
    group: 'generation',
    tier: 'core',
    signature: '/recap [days]',
    description: 'narrative recap of recent work',
    followups: [
      { command: 'standup', label: '$(calendar) Daily standup' },
      { command: 'search', label: '$(search) Search sessions' },
    ],
  },
  {
    name: 'ask',
    group: 'generation',
    tier: 'core',
    signature: '/ask <question>',
    description: 'answer a question from session memory',
    followups: [
      { command: 'standup', label: '$(calendar) Daily standup' },
      { command: 'search', label: '$(search) Search sessions' },
    ],
  },
  {
    name: 'decisions',
    group: 'generation',
    tier: 'core',
    signature: '/decisions',
    description: 'list architecture decisions across sessions',
  },
  {
    name: 'debt',
    group: 'generation',
    tier: 'core',
    signature: '/debt',
    description: "what's owed — TODO/FIXME/tech-debt signals from recent sessions",
    followups: [
      { command: 'precommit', label: '$(git-commit) Pre-commit check' },
      { command: 'decisions', label: '$(list-ordered) Architecture decisions' },
    ],
  },

  // ── 🛡 Admin + insight ─────────────────────────────────────────────────────
  {
    name: 'status',
    group: 'admin',
    tier: 'core',
    signature: '/status',
    description: 'session count, last capture, health',
  },
  {
    name: 'health',
    group: 'admin',
    tier: 'core',
    signature: '/health',
    description: 'one-shot health score breakdown',
    followups: [{ command: 'status', label: '$(info) Show status' }],
  },
  {
    name: 'audit',
    group: 'admin',
    tier: 'experimental',
    signature: '/audit',
    description: 'workspace integrity audit (cross-file consistency)',
  },
  {
    name: 'compliance',
    group: 'admin',
    tier: 'experimental',
    signature: '/compliance',
    description: 'grounding/trust/conflict/redaction report',
  },
  {
    name: 'savings',
    group: 'admin',
    tier: 'experimental',
    signature: '/savings',
    description: 'estimated token cost saved vs cold prompting',
  },
  {
    name: 'route',
    group: 'admin',
    tier: 'experimental',
    signature: '/route <question>',
    description: 'show which retrieval path the router would pick',
  },
  {
    name: 'janitor',
    group: 'admin',
    tier: 'experimental',
    signature: '/janitor',
    description: 'manual re-score pass over every stored session',
  },
  {
    name: 'graph',
    group: 'admin',
    tier: 'experimental',
    signature: '/graph',
    description: 'mermaid causal graph of related sessions',
  },
  {
    name: 'export',
    group: 'admin',
    tier: 'core',
    signature: '/export <id>',
    description: 'session row as diff-friendly markdown',
  },
  {
    name: 'azure',
    group: 'admin',
    tier: 'experimental',
    signature: '/azure',
    description: 'Azure-context-aware retrieval shortcut',
  },
  {
    name: 'help',
    aliases: ['?'],
    group: 'admin',
    tier: 'core',
    signature: '/help · /?',
    description: 'list every command grouped by intent',
  },
];

/** Lookup a command spec by primary name or alias. */
export function findCommand(name: string | undefined): CommandSpec | undefined {
  if (!name) return undefined;
  return COMMAND_REGISTRY.find((c) => c.name === name || (c.aliases?.includes(name) ?? false));
}

/**
 * Follow-up chips for a command. Returns the command's own chips, or the shared
 * default set when the command defines none (or is unknown / free-text).
 */
export function getFollowups(command: string | undefined): FollowupChip[] {
  const spec = findCommand(command);
  return spec?.followups ?? DEFAULT_FOLLOWUPS;
}

/** Every name the dispatcher may receive (primary names + aliases). */
export function allCommandNames(): string[] {
  const names: string[] = [];
  for (const c of COMMAND_REGISTRY) {
    names.push(c.name);
    if (c.aliases) names.push(...c.aliases);
  }
  return names;
}

/** Commands filed under a group, in registry order. */
export function commandsInGroup(group: CommandGroup): CommandSpec[] {
  return COMMAND_REGISTRY.filter((c) => c.group === group);
}
