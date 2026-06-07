/**
 * Context-acquisition router.
 *
 * The system can't silently intercept Copilot's `@file` decision — that
 * happens inside the chat host. But it CAN observe a user's request and
 * recommend the cheapest, highest-fidelity way to satisfy it:
 *
 *   - Pure lookups ("what did we decide about X?")          → MCP tools
 *   - Modifications  ("add a new field to Y")               → file attach
 *   - Investigations ("find where X is used")               → MCP first, then attach
 *   - Mixed          ("explain X then add error handling")  → step plan
 *
 * The recommender is consumed two ways:
 *   1. `@mem /route <query>` — surfaces the recommendation to humans
 *   2. `baton_route` MCP tool — lets agents (Copilot, Cursor, Cline)
 *      query the router themselves before deciding context, so they pick
 *      tools without an attach round-trip.
 *
 * Pure module: no vscode imports. The chat command wraps it with file-
 * existence checks; the MCP tool calls it directly.
 */

import { classifyIntent, QueryIntent } from './queryIntent';

/** Coarse high-level intent — drives which action surface we recommend. */
export type RequestIntent =
  | 'lookup' // "why / what / how / who / when" question
  | 'modify' // explicit write/edit verb
  | 'investigate' // "find / locate / search / show me"
  | 'mixed' // combines lookup + modify
  | 'unknown';

/** Single suggested step. Cost is an estimate in LM tokens. */
export type RouteAction =
  | {
      kind: 'mcp';
      tool: string;
      args: Record<string, unknown>;
      rationale: string;
      estimatedTokens: number;
    }
  | {
      kind: 'attach';
      paths: string[];
      rationale: string;
      estimatedTokens: number;
    };

export interface RouteRecommendation {
  intent: RequestIntent;
  queryIntent: QueryIntent;
  actions: RouteAction[];
  estimatedTotalTokens: number;
  /**
   * Tokens you'd spend if you naively attached every mentioned file. The
   * delta (`naiveAttachTokens − estimatedTotalTokens`) is the saving.
   */
  naiveAttachTokens: number;
  reasoning: string;
}

/**
 * Inputs the router needs to give realistic recommendations. Caller looks
 * up file sizes in the workspace and passes them in; the router itself
 * stays free of vscode-fs / Node-fs so it remains testable.
 */
export interface RouteContext {
  /**
   * Map of workspace-relative path → byte size. Used to estimate the
   * cost of an `@file` attach. Missing entries are assumed unknown and
   * fall back to a heuristic default.
   */
  fileSizes?: Record<string, number>;
  /**
   * Whether MCP tools are wired up in the caller's environment. When
   * false, the recommender prefers attach + manual answer over MCP calls
   * the agent cannot make.
   */
  mcpAvailable?: boolean;
}

// ── Classifier ──────────────────────────────────────────────────────────────

const MODIFY_VERBS = [
  /\b(add|change|update|modify|edit|refactor|rename|delete|remove|fix|patch|implement|create|generate|write|extend|migrate|wire|hook|inject|build|rebuild|introduce|replace)\b/i,
];
const LOOKUP_VERBS = [
  /\b(why|what|how|when|who|which|explain|describe|show me what|tell me about)\b/i,
  /\b(rationale|decision|design choice|history)\b/i,
];
const INVESTIGATE_VERBS = [/\b(find|locate|search|show me where|grep|look up|where is|list)\b/i];

/**
 * Coarse high-level intent classifier. Layered on top of `queryIntent`
 * (the retrieval-time bucketer) but operates on writer-vs-reader axes
 * — so a "fix bug in auth.ts" query is `modify`, even though
 * queryIntent might call it `problem`.
 */
export function classifyRequest(query: string): RequestIntent {
  const q = (query ?? '').trim();
  if (!q) return 'unknown';
  const hasModify = MODIFY_VERBS.some((re) => re.test(q));
  const hasLookup = LOOKUP_VERBS.some((re) => re.test(q));
  const hasInvestigate = INVESTIGATE_VERBS.some((re) => re.test(q));
  if (hasModify && hasLookup) return 'mixed';
  if (hasModify) return 'modify';
  if (hasLookup) return 'lookup';
  if (hasInvestigate) return 'investigate';
  return 'unknown';
}

/**
 * Naïve regex extractor for workspace-relative file paths and entity-style
 * symbol IDs (`src/auth.ts` or `src/auth.ts#hashPassword`). Used to seed
 * the suggested attach / entity lookup with the actual artefacts the user
 * mentioned.
 */
export function extractMentionedPaths(query: string): string[] {
  if (!query) return [];
  const re = /\b([\w./-]*\.[a-z]{1,5}(?:#\w+)?)\b/g;
  const out = new Set<string>();
  for (const m of query.matchAll(re)) out.add(m[1]);
  return [...out];
}

// ── Cost helpers ────────────────────────────────────────────────────────────

/** Rough per-call cost for MCP tools that return compact JSON. */
const MCP_TOOL_TOKEN_COST: Record<string, number> = {
  baton_search: 250,
  baton_get: 400,
  baton_entity: 500,
  baton_snippets: 450,
  baton_lineage: 350,
  baton_conflicts: 400,
  baton_explain: 400,
  baton_graph: 800, // mermaid graph can be larger
  baton_recent: 300,
  baton_timeline: 300,
};

/**
 * Convert a file's byte size to an LM-token estimate. Uses the standard
 * `~4 chars per token` rule of thumb. When size is unknown, defaults to
 * 2000 tokens — the historical average of a small TS source file.
 */
export function estimateAttachTokens(bytes: number | undefined): number {
  if (!bytes || bytes <= 0) return 2000;
  return Math.ceil(bytes / 4);
}

// ── Recommender ─────────────────────────────────────────────────────────────

/**
 * Produce a structured recommendation for satisfying `query`.
 *
 * The recommender is intentionally biased toward MCP for `lookup` /
 * `investigate` intents, attach for `modify`, and a hybrid plan for
 * `mixed`. When MCP is unavailable (e.g. the caller hasn't wired up the
 * stdio server), we degrade gracefully to attach-only.
 */
export function recommend(query: string, ctx: RouteContext = {}): RouteRecommendation {
  const intent = classifyRequest(query);
  const qIntent = classifyIntent(query);
  const mentioned = extractMentionedPaths(query);
  const mcpAvailable = ctx.mcpAvailable !== false;

  // Naive baseline: attach every mentioned file at full cost. This is the
  // number we'll compare against to surface the saving.
  const naiveAttachTokens =
    mentioned.reduce((acc, p) => {
      const path = p.replace(/#.*$/, ''); // strip symbol suffix
      return acc + estimateAttachTokens(ctx.fileSizes?.[path]);
    }, 0) || estimateAttachTokens(undefined); // assume one default-size file if no mentions

  const actions: RouteAction[] = [];

  if (!mcpAvailable) {
    actions.push({
      kind: 'attach',
      paths: mentioned.length ? mentioned : ['(file the user means)'],
      rationale:
        'MCP tools not wired up — fall back to file attach. Run `npx baton-mem-mcp` to enable cheaper routes.',
      estimatedTokens: naiveAttachTokens,
    });
    return {
      intent,
      queryIntent: qIntent,
      actions,
      estimatedTotalTokens: naiveAttachTokens,
      naiveAttachTokens,
      reasoning: 'No MCP server detected; recommending the attach fallback.',
    };
  }

  switch (intent) {
    case 'lookup': {
      // Lookups: prefer the most-specific MCP tool given the queryIntent.
      const tool =
        qIntent === 'decision' || qIntent === 'problem'
          ? 'baton_snippets'
          : mentioned.length
            ? 'baton_entity'
            : 'baton_search';
      const args: Record<string, unknown> =
        tool === 'baton_entity' && mentioned[0] ? { key: mentioned[0] } : { query };
      actions.push({
        kind: 'mcp',
        tool,
        args,
        rationale: `Lookup intent: query the memory store directly — ~${MCP_TOOL_TOKEN_COST[tool]} tokens vs ${naiveAttachTokens} for attaching ${mentioned.length || 1} file(s).`,
        estimatedTokens: MCP_TOOL_TOKEN_COST[tool] ?? 400,
      });
      break;
    }
    case 'investigate': {
      // Investigation: search snippets first; if the user still needs
      // source we'll attach the winning files based on those results.
      actions.push({
        kind: 'mcp',
        tool: 'baton_snippets',
        args: { query },
        rationale:
          'Investigation intent: snippet search returns the matching decision/problem text plus the source session ID. If you then need the actual code, attach only the file(s) returned.',
        estimatedTokens: MCP_TOOL_TOKEN_COST.baton_snippets,
      });
      break;
    }
    case 'modify': {
      // Modifications: attach the files the user explicitly mentioned.
      // Augment with a cheap MCP lookup so the agent has the project's
      // prior decisions in scope — keeps the cost-per-task low.
      if (mentioned.length) {
        actions.push({
          kind: 'attach',
          paths: mentioned,
          rationale:
            'Modification intent: source required to write the change. Attach only the files explicitly mentioned, not their dependency closure.',
          estimatedTokens: mentioned.reduce(
            (acc, p) => acc + estimateAttachTokens(ctx.fileSizes?.[p.replace(/#.*$/, '')]),
            0,
          ),
        });
      }
      if (mentioned[0]) {
        actions.push({
          kind: 'mcp',
          tool: 'baton_entity',
          args: { key: mentioned[0] },
          rationale:
            'Lift prior decisions about this file so the change respects past architectural choices.',
          estimatedTokens: MCP_TOOL_TOKEN_COST.baton_entity,
        });
      }
      break;
    }
    case 'mixed': {
      // Mixed: do the lookup first (cheap), then attach.
      actions.push({
        kind: 'mcp',
        tool: 'baton_search',
        args: { query },
        rationale:
          'Mixed intent: surface prior context cheaply first, then attach files only when the change actually requires editing them.',
        estimatedTokens: MCP_TOOL_TOKEN_COST.baton_search,
      });
      if (mentioned.length) {
        actions.push({
          kind: 'attach',
          paths: mentioned,
          rationale: 'After the lookup, attach the file(s) you intend to edit.',
          estimatedTokens: mentioned.reduce(
            (acc, p) => acc + estimateAttachTokens(ctx.fileSizes?.[p.replace(/#.*$/, '')]),
            0,
          ),
        });
      }
      break;
    }
    case 'unknown':
    default: {
      // Couldn't classify — default to the cheapest probe so the user
      // can iterate without burning the attach budget.
      actions.push({
        kind: 'mcp',
        tool: 'baton_search',
        args: { query },
        rationale:
          'Intent unclear: try the cheap search probe first. Re-route with a more specific question once results land.',
        estimatedTokens: MCP_TOOL_TOKEN_COST.baton_search,
      });
      break;
    }
  }

  const total = actions.reduce((acc, a) => acc + a.estimatedTokens, 0);
  const savedTokens = Math.max(0, naiveAttachTokens - total);
  const savedPct = naiveAttachTokens > 0 ? Math.round((savedTokens / naiveAttachTokens) * 100) : 0;
  const reasoning =
    total < naiveAttachTokens
      ? `Estimated ${total} tokens vs ${naiveAttachTokens} for naive attach — ~${savedPct}% saving.`
      : `Estimated ${total} tokens (attach is the right call here — no cheaper alternative exists for ${intent} intent).`;

  return {
    intent,
    queryIntent: qIntent,
    actions,
    estimatedTotalTokens: total,
    naiveAttachTokens,
    reasoning,
  };
}

/**
 * Render a RouteRecommendation as chat-friendly markdown. The output is
 * deliberately short and actionable so it can be inserted into a chat
 * stream without dominating the response.
 */
export function renderRecommendation(rec: RouteRecommendation): string {
  const lines: string[] = [];
  lines.push(`## 🧭 Routing — \`${rec.intent}\` intent (${rec.queryIntent} retrieval)`);
  lines.push('');
  lines.push(`> ${rec.reasoning}`);
  lines.push('');
  rec.actions.forEach((a, i) => {
    lines.push(
      `**${i + 1}. ${a.kind === 'mcp' ? `🔧 MCP \`${a.tool}\`` : '📎 Attach file(s)'}** · ~${a.estimatedTokens} tokens`,
    );
    if (a.kind === 'mcp') {
      lines.push(`   \`\`\``);
      lines.push(`   ${a.tool}(${JSON.stringify(a.args)})`);
      lines.push(`   \`\`\``);
    } else {
      lines.push(`   ${a.paths.map((p) => `\`${p}\``).join(', ')}`);
    }
    lines.push(`   _${a.rationale}_`);
    lines.push('');
  });
  return lines.join('\n');
}
