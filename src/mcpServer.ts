#!/usr/bin/env node
/**
 * GHCP-MEM MCP stdio server.
 *
 * Minimal JSON-RPC 2.0 implementation of the Model Context Protocol (MCP)
 * over stdio. Exposes the GHCP-MEM session memory to any MCP-compatible
 * client (Cursor, Cline, Windsurf, Claude Desktop, etc.) without requiring
 * the @modelcontextprotocol/sdk dependency.
 *
 * Storage: reads from `~/.ghcp-mem/sessions.json`, which the VS Code
 * extension mirrors on every persist (see contextStore.syncToDisk).
 *
 * Launch:   npx ghcp-mem-mcp
 * Or:       node out/mcpServer.js
 *
 * Protocol methods implemented:
 *   - initialize
 *   - tools/list
 *   - tools/call   (ghcpMem_search | ghcpMem_timeline | ghcpMem_recent | ghcpMem_get)
 *   - ping
 *   - shutdown
 */

import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'ghcp-mem';
const SERVER_VERSION = '0.5.0';

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

interface StoredSession {
  id: string;
  workspaceId: string;
  workspaceName: string;
  startTime: number;
  endTime: number;
  summary: string;
  observationType: string;
  keyFiles: string[];
  keyTopics: string[];
  decisions: string[];
  problemsSolved: string[];
  userTags: string[];
  redactionCount: number;
  azureContext?: any;
}

interface StoredDatabase {
  version: number;
  sessions: StoredSession[];
  lastUpdated: number;
}

function storePath(): string {
  return process.env.GHCP_MEM_STORE_PATH ?? join(homedir(), '.ghcp-mem', 'sessions.json');
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

function extractTerms(text: string): Set<string> {
  return new Set(
    (text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2),
  );
}

function keywordScore(s: StoredSession, terms: Set<string>): number {
  let score = 0;
  const check = (text: string, weight: number) => {
    const toks = extractTerms(text);
    for (const t of terms) if (toks.has(t)) score += weight;
  };
  check(s.summary, 3);
  for (const t of s.keyTopics) check(t, 5);
  for (const f of s.keyFiles) check(f, 2);
  for (const d of s.decisions) check(d, 4);
  for (const p of s.problemsSolved) check(p, 4);
  for (const t of s.userTags) check(t, 6);
  return score;
}

/** RRF-fused search with recency decay. Mirrors ContextStore.search. */
function searchSessions(
  db: StoredDatabase,
  query: string,
  filters: { type?: string; tag?: string; sinceDays?: number; workspaceId?: string } = {},
  limit = 5,
): StoredSession[] {
  let candidates = [...db.sessions];
  if (filters.type) candidates = candidates.filter(s => s.observationType === filters.type);
  if (filters.tag) candidates = candidates.filter(s => s.userTags.includes(filters.tag!));
  if (filters.sinceDays) {
    const cutoff = Date.now() - filters.sinceDays * 24 * 60 * 60 * 1000;
    candidates = candidates.filter(s => s.endTime >= cutoff);
  }
  if (filters.workspaceId) candidates = candidates.filter(s => s.workspaceId === filters.workspaceId);

  const terms = extractTerms(query ?? '');
  const kScored = candidates.map(s => ({ s, k: keywordScore(s, terms) }));
  const keywordRanked = [...kScored].sort((a, b) => b.k - a.k);
  const kRank = new Map<string, number>();
  keywordRanked.forEach((e, i) => kRank.set(e.s.id, i));
  const recencyRanked = [...candidates].sort((a, b) => b.endTime - a.endTime);
  const rRank = new Map<string, number>();
  recencyRanked.forEach((s, i) => rRank.set(s.id, i));

  const K = 60;
  const HALF_LIFE = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const fused = candidates.map(s => {
    const rrf = 1 / (K + (kRank.get(s.id) ?? K * 10)) + 1 / (K + (rRank.get(s.id) ?? K * 10));
    const decay = Math.pow(2, -(now - s.endTime) / HALF_LIFE) * 0.3;
    return { s, score: rrf + decay };
  });
  fused.sort((a, b) => b.score - a.score || b.s.endTime - a.s.endTime);
  return fused.slice(0, limit).map(e => e.s);
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

const TOOLS = [
  {
    name: 'ghcpMem_search',
    description:
      'Search GHCP-MEM session memory for past decisions, problems solved, files touched, and topics across all workspaces.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for.' },
        type: { type: 'string', description: 'Optional observation type filter (feature, bugfix, infra, deployment, ...).' },
        sinceDays: { type: 'number', description: 'Only return sessions from the last N days.' },
        tag: { type: 'string', description: 'Filter by user-applied tag.' },
        limit: { type: 'number', description: 'Max results (default 5, max 25).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ghcpMem_recent',
    description: 'Return the N most recent GHCP-MEM sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 5, max 25).' },
      },
    },
  },
  {
    name: 'ghcpMem_timeline',
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
    name: 'ghcpMem_get',
    description: 'Get full detail of a session by ID or ID prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID or unique prefix.' },
      },
      required: ['id'],
    },
  },
];

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
    case 'ghcpMem_search': {
      const limit = clamp(args?.limit, 5, 25);
      const hits = searchSessions(
        db,
        String(args?.query ?? ''),
        { type: args?.type, tag: args?.tag, sinceDays: args?.sinceDays },
        limit,
      );
      return textContent({ count: hits.length, results: hits.map(summarizeForMcp) });
    }
    case 'ghcpMem_recent': {
      const limit = clamp(args?.limit, 5, 25);
      const recent = [...db.sessions].sort((a, b) => b.endTime - a.endTime).slice(0, limit);
      return textContent({ count: recent.length, results: recent.map(summarizeForMcp) });
    }
    case 'ghcpMem_timeline': {
      const days = clamp(args?.days, 7, 365);
      const limit = clamp(args?.limit, 10, 50);
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const hits = db.sessions
        .filter(s => s.endTime >= cutoff)
        .sort((a, b) => a.endTime - b.endTime)
        .slice(0, limit);
      return textContent({ count: hits.length, days, results: hits.map(summarizeForMcp) });
    }
    case 'ghcpMem_get': {
      const id = String(args?.id ?? '');
      const hit = db.sessions.find(s => s.id === id || s.id.startsWith(id));
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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
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
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } };
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
  const tryExit = () => { if (closed && pending === 0) process.exit(0); };
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
      .then(resp => { if (resp) send(resp); })
      .catch(err => send({ jsonrpc: '2.0', id: req.id ?? null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }))
      .finally(() => { pending--; tryExit(); });
  });
  rl.on('close', () => { closed = true; tryExit(); });
  // Never write logs to stdout — reserved for JSON-RPC frames.
  process.stderr.write(`[ghcp-mem-mcp] listening on stdio, store=${storePath()}\n`);
}

// Only run the server when invoked as a script (not when required by tests)
if (require.main === module) {
  main();
}

export { TOOLS, searchSessions, loadDatabase, storePath };
