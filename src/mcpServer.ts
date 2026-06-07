#!/usr/bin/env node
/**
 * Baton MCP stdio server.
 *
 * Minimal JSON-RPC 2.0 implementation of the Model Context Protocol (MCP)
 * over stdio. Exposes the Baton session memory to any MCP-compatible
 * client (Cursor, Cline, Windsurf, Claude Desktop, etc.) without requiring
 * the @modelcontextprotocol/sdk dependency.
 *
 * Storage: reads from `~/.baton-mem/sessions.json`, which the VS Code
 * extension mirrors on every persist (see contextStore.syncToDisk).
 *
 * Launch:   npx baton-mem-mcp
 * Or:       node out/mcpServer.js
 *
 * Protocol methods implemented:
 *   - initialize
 *   - tools/list
 *   - tools/call   (baton_search | baton_timeline | baton_recent | baton_get)
 *   - ping
 *   - shutdown
 */

import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
// Import shared types to avoid duplicating interface definitions.
import type { CompressedSession, ContextDatabase } from './types';
// Shared keyword scorer — single source of truth shared with ContextStore.
import { extractTerms, keywordScore, computeAvgDocLen } from './searchCore';
// Phase 7: reuse pure helpers from the chat-side modules so MCP retrieval
// stays at full parity with the chat participant.
import { buildEntityRecord } from './entity';
import {
  snippetsFromSession,
  snippetScore,
  tokenizeSnippet,
  avgSnippetLen,
  Snippet,
} from './snippets';
import { detectConflicts, ConflictWarning } from './conflicts';
import { getCausalNeighbors } from './causalGraph';
import { explainScore } from './explain';
import { buildMermaidGraph } from './graphExport';
import { recommend } from './router';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'baton-mem';
const MCP_WRITE_ENABLED =
  process.env.GHCP_MEM_ALLOW_MCP_WRITE !== 'false' && process.env.GHCP_MEM_READONLY !== 'true';
// Read the package version at module load so we never drift from package.json.
// Falls back to 'unknown' if the bundled package.json can't be located
// (e.g. when this file is imported from out-test/ during the test compile).
let SERVER_VERSION = 'unknown';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SERVER_VERSION = require('../package.json').version ?? 'unknown';
} catch {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    SERVER_VERSION = require('../../package.json').version ?? 'unknown';
  } catch {
    /* keep 'unknown' */
  }
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

/** Alias to keep the rest of the file readable. */
type StoredSession = CompressedSession;
type StoredDatabase = ContextDatabase;

function storePath(): string {
  return process.env.GHCP_MEM_STORE_PATH ?? join(homedir(), '.baton-mem', 'sessions.json');
}

// Cache the parsed database keyed by file mtime so that high-frequency tool
// calls (search/recent/timeline/get) don't re-read and re-parse the whole
// JSON store from disk on every invocation. The extension host updates the
// file atomically via rename, so mtime changes monotonically per write.
let dbCache: { mtimeMs: number; db: StoredDatabase } | undefined;

async function loadDatabase(): Promise<StoredDatabase> {
  const p = storePath();
  try {
    const stat = await fs.stat(p);
    if (dbCache && dbCache.mtimeMs === stat.mtimeMs) return dbCache.db;
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.sessions)) {
      dbCache = { mtimeMs: stat.mtimeMs, db: parsed };
      return parsed;
    }
    const empty: StoredDatabase = { version: 2, sessions: [], lastUpdated: 0 };
    dbCache = { mtimeMs: stat.mtimeMs, db: empty };
    return empty;
  } catch {
    return { version: 2, sessions: [], lastUpdated: 0 };
  }
}

/** RRF-fused search with recency decay. Mirrors ContextStore.search. */
function searchSessions(
  db: StoredDatabase,
  query: string,
  filters: {
    type?: string;
    tag?: string;
    sinceDays?: number;
    workspaceId?: string;
    workspaceName?: string;
  } = {},
  limit = 5,
): StoredSession[] {
  let candidates = [...db.sessions];
  if (filters.type) candidates = candidates.filter((s) => s.observationType === filters.type);
  if (filters.tag) candidates = candidates.filter((s) => s.userTags.includes(filters.tag!));
  if (filters.sinceDays) {
    const cutoff = Date.now() - filters.sinceDays * 24 * 60 * 60 * 1000;
    candidates = candidates.filter((s) => s.endTime >= cutoff);
  }
  if (filters.workspaceId)
    candidates = candidates.filter((s) => s.workspaceId === filters.workspaceId);
  // workspaceName filter: case-insensitive substring match on workspaceName field.
  if (filters.workspaceName) {
    const needle = filters.workspaceName.toLowerCase();
    candidates = candidates.filter((s) => s.workspaceName?.toLowerCase().includes(needle));
  }

  const terms = extractTerms(query ?? '');
  const avgDocLen = computeAvgDocLen(candidates);
  const kScored = candidates.map((s) => ({ s, k: keywordScore(s, terms, undefined, avgDocLen) }));

  // When the user supplied a query AND at least one candidate has a positive
  // keyword score, drop the zero-score candidates so unrelated sessions can't
  // outrank a clear match through tiny differences in RRF rank position.
  // Without this guard the previous logic could (and did) return 'ui tweaks'
  // ahead of 'authentication rework' for the query 'authentication' purely
  // because both sessions had identical recency.
  let scoped = candidates;
  if (terms.size > 0 && kScored.some((e) => e.k > 0)) {
    const positive = new Set(kScored.filter((e) => e.k > 0).map((e) => e.s.id));
    scoped = candidates.filter((s) => positive.has(s.id));
  }
  const scopedKScored = kScored.filter((e) => scoped.includes(e.s));
  const keywordRanked = [...scopedKScored].sort((a, b) => b.k - a.k);
  const kRank = new Map<string, number>();
  keywordRanked.forEach((e, i) => kRank.set(e.s.id, i));
  const recencyRanked = [...scoped].sort((a, b) => b.endTime - a.endTime);
  const rRank = new Map<string, number>();
  recencyRanked.forEach((s, i) => rRank.set(s.id, i));

  const K = 60;
  const HALF_LIFE = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const fused = scoped.map((s) => {
    const rrf = 1 / (K + (kRank.get(s.id) ?? K * 10)) + 1 / (K + (rRank.get(s.id) ?? K * 10));
    const decay = Math.pow(2, -(now - s.endTime) / HALF_LIFE) * 0.3;
    return { s, score: rrf + decay };
  });
  fused.sort((a, b) => b.score - a.score || b.s.endTime - a.s.endTime);
  return fused.slice(0, limit).map((e) => e.s);
}

function summarizeForMcp(s: StoredSession): any {
  return {
    id: s.id,
    shortId: s.id.substring(0, 8),
    date: new Date(s.endTime).toISOString(),
    type: s.observationType,
    summary: s.summary,
    keyFiles: s.keyFiles.slice(0, 10),
    keyTopics: s.keyTopics.slice(0, 8),
    decisions: s.decisions.slice(0, 5),
    problemsSolved: s.problemsSolved.slice(0, 5),
    tags: s.userTags,
    azure: s.azureContext
      ? {
          subscription: s.azureContext.subscriptionName ?? s.azureContext.subscriptionId,
          resourceGroup: s.azureContext.resourceGroup,
          subsystems: s.azureContext.subsystems,
        }
      : undefined,
  };
}

/** Timeline results ordered by most recent first for quick activity recall. */
export function timelineSessions(db: StoredDatabase, days = 7, limit = 10): StoredSession[] {
  const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n)));
  const d = clampInt(days, 1, 365);
  const l = clampInt(limit, 1, 50);
  const cutoff = Date.now() - d * 24 * 60 * 60 * 1000;
  return db.sessions
    .filter((s) => s.endTime >= cutoff)
    .sort((a, b) => b.endTime - a.endTime)
    .slice(0, l);
}

const TOOLS = [
  {
    name: 'baton_search',
    description:
      'Search Baton session memory for past decisions, problems solved, files touched, and topics across all workspaces. PREFER THIS over opening files when the user is asking *about* the project history ("why / what / when / who") — typically returns the answer in ~250 tokens vs 1000–10000 for a file open.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for.' },
        type: {
          type: 'string',
          description:
            'Optional observation type filter (feature, bugfix, infra, deployment, ...).',
        },
        sinceDays: { type: 'number', description: 'Only return sessions from the last N days.' },
        tag: { type: 'string', description: 'Filter by user-applied tag.' },
        workspaceId: {
          type: 'string',
          description: 'Scope results to a specific workspace URI. Omit for all workspaces.',
        },
        workspaceName: {
          type: 'string',
          description:
            'Scope results by workspace name (case-insensitive substring). Easier to use than workspaceId.',
        },
        limit: { type: 'number', description: 'Max results (default 5, max 25).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'baton_recent',
    description: 'Return the N most recent Baton sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 5, max 25).' },
        workspaceId: {
          type: 'string',
          description: 'Scope results to a specific workspace URI. Omit for all workspaces.',
        },
        workspaceName: {
          type: 'string',
          description:
            'Scope results by workspace name (case-insensitive substring). Easier to use than workspaceId.',
        },
      },
    },
  },
  {
    name: 'baton_timeline',
    description: 'Return sessions within a time window (days around now).',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Look back N days (default 7).' },
        limit: { type: 'number', description: 'Max results (default 10, max 50).' },
      },
    },
  },
  {
    name: 'baton_get',
    description: 'Get full detail of a session by ID or ID prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID or unique prefix.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'baton_store',
    description:
      'Persist a note or session summary into Baton so it will be recalled in future sessions. Use for durable facts, decisions, or preferences.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '2-4 sentence summary of what should be remembered.',
        },
        observationType: {
          type: 'string',
          description:
            'Category (feature, bugfix, refactor, docs, test, chore, research, config, security, deployment, infra, unknown). Default: research.',
        },
        keyTopics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 10 topic keywords.',
        },
        keyFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 10 relevant file paths.',
        },
        decisions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Architectural or design decisions.',
        },
        problemsSolved: {
          type: 'array',
          items: { type: 'string' },
          description: 'Problems resolved.',
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'User-facing tags.' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'baton_delete',
    description: 'Delete a Baton session by ID or ID prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID or unique prefix to delete.' },
      },
      required: ['id'],
    },
  },
  // ── Phase 7: MCP parity with chat participant ────────────────────────────
  {
    name: 'baton_entity',
    description:
      'Aggregate every session that touched a file path or LSP symbol into a single focused summary. Key auto-detects: "src/auth.ts" → file entity, "src/auth.ts#hashPassword" → symbol entity (anything containing "#"). PREFER THIS over opening the file when the user asks "what do we know about <file/symbol>?" or "what decisions exist for <thing>?" — returns ~500 tokens vs typically 2000–10000 for the raw source.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Workspace-relative file path or symbol ID (`path#symbol`).',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'baton_snippets',
    description:
      'Chunk-level retrieval — returns matching decisions, problems, summaries, or topics across all stored sessions (not just whole-session results). PREFER THIS over file open when the user wants the exact decision/error text matching some keywords — typically 200–500 tokens vs file size.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to match.' },
        type: { type: 'string', description: 'Optional observation-type filter.' },
        tag: { type: 'string', description: 'Filter by user-applied tag.' },
        sinceDays: { type: 'number', description: 'Only consider sessions from the last N days.' },
        limit: { type: 'number', description: 'Max snippet results (default 10, max 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'baton_conflicts',
    description:
      'List pending conflict warnings — decisions whose text contained contradiction markers (e.g. "instead of", "deprecated") and that overlap with older sessions on file/topic. Useful for spotting unresolved supersessions in a team-shared store.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'baton_lineage',
    description:
      'Return the cross-session causal chain (predecessors + successors) for a session. Edges include semantic labels: "introduced_issue_fixed_by" (feature→bugfix), "extends" (feature→refactor), "tests" (feature→test), "continues_work_from" (fallback).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID or unique prefix.' },
        limit: {
          type: 'number',
          description: 'Max predecessors / successors per side (default 5, max 25).',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'baton_explain',
    description:
      'Score-decomposition explainer — break down why a session ranked where it did for a specific query. Returns per-signal contributions (keyword rank, recency decay, confidence, reinforcement, feedback, intent boosts, supersession penalty).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The query whose ranking should be explained.' },
        id: { type: 'string', description: 'Session ID (or prefix) being explained.' },
      },
      required: ['query', 'id'],
    },
  },
  {
    name: 'baton_graph',
    description:
      'Emit a Mermaid flowchart of the decision graph (supersession + correction + causal edges). Ready to paste into a PR description, ADR, or README. Optional file filter restricts to sessions touching a path.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description:
            'Optional workspace-relative path substring; restricts to sessions touching it.',
        },
      },
    },
  },
  {
    name: 'baton_route',
    description:
      'Context-acquisition recommender. Call BEFORE deciding whether to open a file: given the user question, returns the cheapest path to an answer (MCP tools vs file open), with per-action token estimates and a structured reasoning string. Use this to avoid uploading large files when a cheaper memory query would suffice. Off by default unless you want explicit cost guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The user question / task description to route.' },
        fileSizes: {
          type: 'object',
          description:
            'Optional map of workspace-relative path → byte size. When supplied, the recommender uses real sizes for estimates instead of a default.',
        },
      },
      required: ['query'],
    },
  },
];

/** Atomically write `db` back to disk (same rename pattern as the extension). */
async function saveDatabase(db: StoredDatabase): Promise<void> {
  const p = storePath();
  const dir = join(p, '..');
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  db.lastUpdated = Date.now();
  await fs.writeFile(tmp, JSON.stringify(db), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, p);
  // Bust the mtime cache so the next loadDatabase re-reads the file.
  dbCache = undefined;
}

function textContent(obj: unknown): any {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

async function handleCall(name: string, args: any): Promise<any> {
  const db = await loadDatabase();
  const clamp = (n: any, def: number, max: number) => {
    const v = typeof n === 'number' ? Math.floor(n) : def;
    return Math.max(1, Math.min(max, v));
  };

  switch (name) {
    case 'baton_search': {
      const limit = clamp(args?.limit, 5, 25);
      const hits = searchSessions(
        db,
        String(args?.query ?? ''),
        {
          type: args?.type,
          tag: args?.tag,
          sinceDays: args?.sinceDays,
          workspaceId: args?.workspaceId,
          workspaceName: args?.workspaceName,
        },
        limit,
      );
      return textContent({ count: hits.length, results: hits.map(summarizeForMcp) });
    }
    case 'baton_recent': {
      const limit = clamp(args?.limit, 5, 25);
      let recent = [...db.sessions].sort((a, b) => b.endTime - a.endTime);
      if (args?.workspaceId) recent = recent.filter((s) => s.workspaceId === args.workspaceId);
      if (args?.workspaceName) {
        const needle = String(args.workspaceName).toLowerCase();
        recent = recent.filter((s) => s.workspaceName?.toLowerCase().includes(needle));
      }
      return textContent({
        count: recent.slice(0, limit).length,
        results: recent.slice(0, limit).map(summarizeForMcp),
      });
    }
    case 'baton_timeline': {
      const days = clamp(args?.days, 7, 365);
      const limit = clamp(args?.limit, 10, 50);
      const hits = timelineSessions(db, days, limit);
      return textContent({ count: hits.length, days, results: hits.map(summarizeForMcp) });
    }
    case 'baton_get': {
      const id = String(args?.id ?? '');
      const hit = db.sessions.find((s) => s.id === id || s.id.startsWith(id));
      if (!hit) return textContent({ error: `No session matching id "${id}"` });
      return textContent({
        ...summarizeForMcp(hit),
        rawEventCount: (hit as any).rawEventCount,
        redactionCount: hit.redactionCount,
        workspaceName: hit.workspaceName,
        startTime: new Date(hit.startTime).toISOString(),
        endTime: new Date(hit.endTime).toISOString(),
      });
    }
    case 'baton_store': {
      if (!MCP_WRITE_ENABLED) throw new Error('MCP write tools are disabled by policy');
      const now = Date.now();
      const session: StoredSession = {
        id: randomUUID(),
        workspaceId: 'mcp',
        workspaceName: 'mcp-client',
        startTime: now,
        endTime: now,
        summary: String(args?.summary ?? '').substring(0, 2000),
        observationType: (args?.observationType ?? 'research') as StoredSession['observationType'],
        keyFiles: (Array.isArray(args?.keyFiles) ? args.keyFiles : []).slice(0, 10).map(String),
        keyTopics: (Array.isArray(args?.keyTopics) ? args.keyTopics : []).slice(0, 10).map(String),
        decisions: (Array.isArray(args?.decisions) ? args.decisions : []).slice(0, 20).map(String),
        problemsSolved: (Array.isArray(args?.problemsSolved) ? args.problemsSolved : [])
          .slice(0, 20)
          .map(String),
        userTags: (Array.isArray(args?.tags) ? args.tags : []).slice(0, 10).map(String),
        rawEventCount: 0,
        redactionCount: 0,
      };
      const storeDb = await loadDatabase();
      storeDb.sessions.push(session);
      await saveDatabase(storeDb);
      return textContent({ stored: true, id: session.id, shortId: session.id.substring(0, 8) });
    }
    case 'baton_delete': {
      if (!MCP_WRITE_ENABLED) throw new Error('MCP write tools are disabled by policy');
      const delId = String(args?.id ?? '');
      const delDb = await loadDatabase();
      const before = delDb.sessions.length;
      delDb.sessions = delDb.sessions.filter((s) => s.id !== delId && !s.id.startsWith(delId));
      const deleted = before - delDb.sessions.length;
      if (deleted > 0) await saveDatabase(delDb);
      return textContent({ deleted, id: delId });
    }

    // ── Phase 7: parity tools ─────────────────────────────────────────────
    case 'baton_entity': {
      const key = String(args?.key ?? '').trim();
      if (!key) return textContent({ error: 'key is required' });
      const rec = buildEntityRecord(key, db.sessions);
      if (!rec) return textContent({ entity: null, message: `No memory of "${key}"` });
      return textContent({
        key: rec.key,
        kind: rec.kind,
        sessionCount: rec.sessionCount,
        firstSeenAt: new Date(rec.firstSeenAt).toISOString(),
        lastTouchedAt: new Date(rec.lastTouchedAt).toISOString(),
        observationTypes: rec.observationTypes,
        topTopics: rec.topTopics,
        decisionLineage: rec.decisionLineage,
        allSupersededOrRetracted: rec.allSupersededOrRetracted,
        decisions: rec.decisions.map((d) => ({
          text: d.text,
          sessionId: d.sessionId,
          emittedAt: new Date(d.emittedAt).toISOString(),
          evidenceFiles: (d.evidence ?? []).map((e) => e.filePath).filter(Boolean),
        })),
        problems: rec.problems.map((p) => ({
          text: p.text,
          sessionId: p.sessionId,
          emittedAt: new Date(p.emittedAt).toISOString(),
        })),
        sessions: rec.sessions,
      });
    }
    case 'baton_snippets': {
      const query = String(args?.query ?? '');
      const limit = clamp(args?.limit, 10, 50);
      const sinceMs = args?.sinceDays ? Date.now() - clamp(args.sinceDays, 7, 365) * 86_400_000 : 0;
      let pool = db.sessions.filter((s) => !s.retracted);
      if (args?.type) pool = pool.filter((s) => s.observationType === args.type);
      if (args?.tag) pool = pool.filter((s) => (s.userTags ?? []).includes(String(args.tag)));
      if (sinceMs) pool = pool.filter((s) => s.endTime >= sinceMs);
      const snippets: Snippet[] = [];
      for (const s of pool) snippets.push(...snippetsFromSession(s));
      const terms = tokenizeSnippet(query);
      if (terms.size === 0) {
        return textContent({
          count: Math.min(snippets.length, limit),
          results: snippets
            .sort((a, b) => b.emittedAt - a.emittedAt)
            .slice(0, limit)
            .map(snippetForMcp),
        });
      }
      const avgDocLen = avgSnippetLen(snippets);
      const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const scored = snippets
        .map((sn) => {
          const k = snippetScore(sn, terms, avgDocLen);
          if (k === 0) return undefined;
          const age = Math.max(0, now - sn.emittedAt);
          const decay = Math.pow(2, -age / HALF_LIFE_MS) * 0.3;
          const conf = sn.confidence ?? 0.5;
          const confBoost = (conf - 0.5) * 0.1;
          const supersededPenalty = sn.supersededBy ? -0.3 : 0;
          return { sn, score: k + decay + confBoost + supersededPenalty };
        })
        .filter((e): e is { sn: Snippet; score: number } => !!e)
        .sort((a, b) => b.score - a.score || b.sn.emittedAt - a.sn.emittedAt);
      return textContent({
        count: Math.min(scored.length, limit),
        results: scored.slice(0, limit).map((e) => snippetForMcp(e.sn)),
      });
    }
    case 'baton_conflicts': {
      // MCP server is stateless across processes — recompute conflicts
      // fresh on every call against the persisted store. This gives the
      // same listing the in-extension /conflicts surface would show,
      // minus the in-memory acknowledgement state (which lives in the
      // extension host).
      const warnings: ConflictWarning[] = [];
      const sorted = [...db.sessions].sort((a, b) => a.endTime - b.endTime);
      for (let i = 1; i < sorted.length; i++) {
        const previous = sorted.slice(0, i);
        const found = detectConflicts(sorted[i], previous);
        for (const w of found) warnings.push(w);
      }
      return textContent({
        count: warnings.length,
        warnings: warnings.map((w) => ({
          newSessionId: w.newSessionId,
          decisionText: w.decisionText,
          marker: w.marker,
          detectedAt: new Date(w.detectedAt).toISOString(),
          candidates: w.candidates.map((c) => ({
            sessionId: c.sessionId,
            summary: c.summary,
            sharedFiles: c.sharedFiles,
            sharedTopics: c.sharedTopics,
            endTime: new Date(c.endTime).toISOString(),
          })),
        })),
      });
    }
    case 'baton_lineage': {
      const id = String(args?.id ?? '');
      const limit = clamp(args?.limit, 5, 25);
      const target = db.sessions.find((s) => s.id === id || s.id.startsWith(id));
      if (!target) return textContent({ error: `No session matching id "${id}"` });
      const n = getCausalNeighbors(target.id, db.sessions, limit);
      if (!n) return textContent({ error: `Could not compute lineage for "${id}"` });
      return textContent({
        centerId: n.centerId,
        predecessors: n.predecessors.map((p) => ({
          sessionId: p.sessionId,
          summary: p.summary,
          observationType: p.observationType,
          endTime: new Date(p.endTime).toISOString(),
          sharedFiles: p.sharedFiles,
          label: p.label,
          gapDays: Math.round(p.gapMs / 86_400_000),
        })),
        successors: n.successors.map((s) => ({
          sessionId: s.sessionId,
          summary: s.summary,
          observationType: s.observationType,
          endTime: new Date(s.endTime).toISOString(),
          sharedFiles: s.sharedFiles,
          label: s.label,
          gapDays: Math.round(s.gapMs / 86_400_000),
        })),
      });
    }
    case 'baton_explain': {
      const query = String(args?.query ?? '');
      const id = String(args?.id ?? '');
      const target = db.sessions.find((s) => s.id === id || s.id.startsWith(id));
      if (!target) return textContent({ error: `No session matching id "${id}"` });
      const e = explainScore(target, query, { allSessions: db.sessions });
      return textContent(e);
    }
    case 'baton_graph': {
      const fileFilter = typeof args?.file === 'string' ? args.file.toLowerCase() : undefined;
      const pool = fileFilter
        ? db.sessions.filter((s) => s.keyFiles.some((f) => f.toLowerCase().includes(fileFilter)))
        : db.sessions;
      const mermaid = buildMermaidGraph(pool);
      return textContent({
        sessionCount: pool.length,
        fileFilter: fileFilter ?? null,
        mermaid,
      });
    }
    case 'baton_route': {
      const query = String(args?.query ?? '');
      const fileSizes =
        args?.fileSizes && typeof args.fileSizes === 'object'
          ? (args.fileSizes as Record<string, number>)
          : undefined;
      const rec = recommend(query, { fileSizes, mcpAvailable: true });
      return textContent(rec);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Compact snippet shape for MCP responses. */
function snippetForMcp(sn: Snippet): any {
  return {
    id: sn.id,
    sessionId: sn.sessionId,
    kind: sn.kind,
    text: sn.text,
    emittedAt: new Date(sn.emittedAt).toISOString(),
    confidence: sn.confidence,
    evidenceFiles: (sn.evidence ?? []).map((e) => e.filePath).filter(Boolean),
  };
}

function send(resp: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(resp) + '\n');
}

async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            capabilities: { tools: {} },
          },
        };
      case 'initialized':
      case 'notifications/initialized':
        return undefined; // notification — no response
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const { name, arguments: args } = req.params ?? {};
        const result = await handleCall(String(name), args ?? {});
        return { jsonrpc: '2.0', id, result };
      }
      case 'shutdown':
        setImmediate(() => process.exit(0));
        return { jsonrpc: '2.0', id, result: null };
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function main(): void {
  const rl = createInterface({ input: process.stdin });
  let pending = 0;
  let closed = false;
  const tryExit = () => {
    if (closed && pending === 0) process.exit(0);
  };
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    pending++;
    dispatch(req)
      .then((resp) => {
        if (resp) send(resp);
      })
      .catch((err) =>
        send({
          jsonrpc: '2.0',
          id: req.id ?? null,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        }),
      )
      .finally(() => {
        pending--;
        tryExit();
      });
  });
  rl.on('close', () => {
    closed = true;
    tryExit();
  });
  // Never write logs to stdout — reserved for JSON-RPC frames.
  process.stderr.write(`[baton-mem-mcp] listening on stdio, store=${storePath()}\n`);
}

// Only run the server when invoked as a script (not when required by tests)
if (require.main === module) {
  main();
}

export { TOOLS, searchSessions, loadDatabase, storePath };
