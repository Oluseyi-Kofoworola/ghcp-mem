import * as vscode from 'vscode';
import { CompressedSession, ContextDatabase, ObservationType, getConfig } from './types';
import { cosineSim, EmbeddingFn } from './embeddings';
import { redact } from './redactor';
import { extractTerms as sharedExtractTerms, keywordScore as sharedKeywordScore } from './searchCore';
import { validateSessions } from './validator';
import { getRepoScopeSync } from './repoScope';

const DB_KEY = 'ghcpMem.contextDatabase';
const DB_VERSION = 2;
const MAX_BACKUPS = 5;
const BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Jaccard similarity on two string arrays (case-insensitive, deduped). */
function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  const sa = new Set(a.map(s => s.toLowerCase()));
  const sb = new Set(b.map(s => s.toLowerCase()));
  let inter = 0;
  for (const v of sa) if (sb.has(v)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface SearchFilters {
  type?: ObservationType;
  sinceTs?: number;
  untilTs?: number;
  workspaceOnly?: boolean;
  tag?: string;
  /** Restrict to sessions tagged with this repoScope id (see {@link './repoScope'}). */
  repoScope?: string;
}

/**
 * Persistent store with an in-memory inverted index for fast text search.
 * Improvements over claude-mem:
 *   - No SQLite/Bun/Chroma native dependencies — uses VS Code globalState
 *   - Age-based retention (retentionDays) in addition to count-based
 *   - Per-session delete, tag, and export/import
 *   - Typed filters + timeline queries (progressive disclosure pattern)
 */
export class ContextStore implements vscode.Disposable {
  private db: ContextDatabase;
  private index = new Map<string, Set<string>>(); // term → session IDs
  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onChange = this.onChangeEmitter.event;
  /**
   * Embedder is set lazily via `setEmbedder()` once the proposed
   * vscode.lm embeddings API has been resolved. Kept private so callers
   * can't accidentally replace it with an incompatible function shape.
   */
  private embedder?: EmbeddingFn;
  private lastBackupAt = 0;
  /** Queue to serialize syncToDisk calls and prevent interleaved writes. */
  private syncQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly backupDir?: vscode.Uri,
  ) {
    this.db = this.load();
    // Chunk index rebuild to avoid blocking the extension host on large stores.
    this.rebuildIndexAsync().then(() => {
      // Run retention once at startup (not on every addSession).
      this.enforceRetention().catch(() => {});
    });
  }

  /** Wire in a (possibly async) embedding function once the API is available. */
  setEmbedder(fn: EmbeddingFn): void {
    this.embedder = fn;
  }

  /** Whether an embedder has been wired in. */
  hasEmbedder(): boolean {
    return !!this.embedder;
  }

  private load(): ContextDatabase {
    const stored = this.globalState.get<ContextDatabase>(DB_KEY);
    if (stored && stored.version === DB_VERSION) return stored;
    // Migration path — best effort
    if (stored && (stored as any).sessions) {
      return { version: DB_VERSION, sessions: (stored as any).sessions, lastUpdated: Date.now() };
    }
    return { version: DB_VERSION, sessions: [], lastUpdated: Date.now() };
  }

  async addSession(session: CompressedSession): Promise<void> {
    const config = getConfig();

    // Content-hash dedup — if an identical-content session already exists,
    // merge tags + bump endTime instead of creating a new row.
    if (session.contentHash) {
      const dup = this.db.sessions.find(s => s.contentHash === session.contentHash);
      if (dup) {
        dup.endTime = Math.max(dup.endTime, session.endTime);
        dup.rawEventCount += session.rawEventCount;
        for (const t of session.userTags) if (!dup.userTags.includes(t)) dup.userTags.push(t);
        this.indexSession(dup);
        await this.persist();
        return;
      }
    }

    this.db.sessions.push(session);
    this.db.lastUpdated = Date.now();
    // Best-effort embedding — runs async after the session is indexed, so
    // it never blocks persistence and failures don't surface to users.
    if (!session.embedding && this.embedder) {
      const text = [session.summary, ...session.keyTopics, ...session.keyFiles, ...session.decisions, ...session.problemsSolved].join(' ');
      this.embedder(text).then(vec => {
        if (vec) {
          session.embedding = vec;
          this.globalState.update(DB_KEY, this.db).then(undefined, () => {});
        }
      }).catch(() => {});
    }

    this.indexSession(session);

    if (this.db.sessions.length > config.maxStoredSessions) {
      const dropped = this.db.sessions.splice(0, this.db.sessions.length - config.maxStoredSessions);
      for (const d of dropped) this.removeFromIndex(d);
    }
    // Size cap is the last line of defence after count/age limits.
    this.enforceSizeCap();
    await this.persist();
  }

  /** Age-based retention. */
  async enforceRetention(): Promise<void> {
    const config = getConfig();
    if (!config.retentionDays || config.retentionDays <= 0) return;
    const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
    const before = this.db.sessions.length;
    this.db.sessions = this.db.sessions.filter(s => {
      if (s.endTime < cutoff) { this.removeFromIndex(s); return false; }
      return true;
    });
    if (this.db.sessions.length !== before) {
      await this.persist();
    }
  }

  /**
   * Byte-size cap on the serialised store. After count + age retention, if
   * JSON.stringify(db) is still over the configured MB threshold, evict the
   * oldest sessions until we're under cap. Returns the number evicted.
   *
   * Cheap to compute (single stringify) and runs only on persist, so it
   * never blocks the UI thread for long. Skipped when cap is 0 or negative.
   */
  enforceSizeCap(): number {
    const config = getConfig();
    if (!config.maxStoreSizeMB || config.maxStoreSizeMB <= 0) return 0;
    const capBytes = config.maxStoreSizeMB * 1024 * 1024;
    if (this.db.sessions.length === 0) return 0;

    // Single stringify upfront — the loop below only stringifies the *evicted*
    // session (small, bounded) and tracks the running total, so the whole
    // operation is O(n) instead of O(n²) on a store that's well over cap.
    const initial = JSON.stringify(this.db);
    if (initial.length <= capBytes) return 0;
    let remainingBytes = initial.length;

    // Evict oldest endTime first until under cap or down to one session.
    const sorted = [...this.db.sessions].sort((a, b) => a.endTime - b.endTime);
    let evicted = 0;
    for (const s of sorted) {
      if (this.db.sessions.length <= 1) break;
      this.removeFromIndex(s);
      const idx = this.db.sessions.indexOf(s);
      if (idx !== -1) this.db.sessions.splice(idx, 1);
      // Subtract the bytes contributed by this session (JSON entry + `,` separator).
      // Approximate (object key overhead in containing array is constant per element)
      // but close enough — we re-verify with one final stringify below if needed.
      remainingBytes -= JSON.stringify(s).length + 1;
      evicted++;
      if (remainingBytes <= capBytes) break;
    }
    return evicted;
  }

  getAllSessions(): CompressedSession[] {
    return [...this.db.sessions];
  }

  getWorkspaceSessions(): CompressedSession[] {
    const wsId = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    if (!wsId) return [...this.db.sessions];
    return this.db.sessions.filter(s => s.workspaceId === wsId);
  }

  /** Sessions tagged with the same repo scope as the currently open workspace. */
  getRepoSessions(repoScopeId?: string): CompressedSession[] {
    const id = repoScopeId ?? getRepoScopeSync().id;
    if (!id) return [...this.db.sessions];
    return this.db.sessions.filter(s => s.repoScope === id);
  }

  getById(idOrPrefix: string): CompressedSession | undefined {
    return this.db.sessions.find(s => s.id === idOrPrefix || s.id.startsWith(idOrPrefix));
  }

  async deleteSession(id: string): Promise<boolean> {
    const i = this.db.sessions.findIndex(s => s.id === id);
    if (i === -1) return false;
    this.removeFromIndex(this.db.sessions[i]);
    this.db.sessions.splice(i, 1);
    await this.persist();
    return true;
  }

  /** Batch-delete multiple sessions with a single persist() call. */
  async deleteSessions(ids: string[]): Promise<number> {
    const idSet = new Set(ids);
    const before = this.db.sessions.length;
    const toRemove = this.db.sessions.filter(s => idSet.has(s.id));
    for (const s of toRemove) this.removeFromIndex(s);
    this.db.sessions = this.db.sessions.filter(s => !idSet.has(s.id));
    const removed = before - this.db.sessions.length;
    if (removed > 0) await this.persist();
    return removed;
  }

  async addTag(id: string, tag: string): Promise<boolean> {
    const s = this.getById(id);
    if (!s) return false;
    if (!s.userTags.includes(tag)) {
      s.userTags.push(tag);
      this.indexSession(s);
      await this.persist();
    }
    return true;
  }

  /** Remove a tag; returns true when the session existed (regardless of whether the tag was present). */
  async removeTag(id: string, tag: string): Promise<boolean> {
    const s = this.getById(id);
    if (!s) return false;
    const idx = s.userTags.indexOf(tag);
    if (idx !== -1) {
      s.userTags.splice(idx, 1);
      this.indexSession(s);
      await this.persist();
    }
    return true;
  }

  /**
   * Progressive-disclosure search with RRF (reciprocal rank fusion) over
   * keyword-match and recency ranks, plus filters.
   *
   * Inspired by the hybrid-search approach in hjertefolger/cortex, but
   * implemented without vector embeddings — we fuse keyword-rank with
   * recency-rank using `1/(k+rank)` with k=60, then add an exponential
   * recency decay boost.
   */
  search(query: string, filters: SearchFilters = {}, limit = 10, queryEmbedding?: number[]): CompressedSession[] {
    const terms = this.extractTerms(query);
    const wsId = vscode.workspace.workspaceFolders?.[0]?.uri.toString();

    // Candidate set via inverted index (intersection when query has terms)
    // A term with zero index hits means no session matches that term — the
    // intersection must be empty, so we short-circuit immediately rather than
    // falling back to all sessions (which was the old bug).
    let candidateIds: Set<string> | null = null;
    let hadAnyTerm = false;
    for (const term of terms) {
      hadAnyTerm = true;
      const hits = this.index.get(term);
      if (!hits || hits.size === 0) {
        // At least one required term matched nothing — intersection is empty.
        candidateIds = new Set();
        break;
      }
      if (candidateIds === null) {
        candidateIds = new Set(hits);
      } else {
        for (const id of candidateIds) {
          if (!hits.has(id)) candidateIds.delete(id);
        }
      }
    }

    let candidates = (candidateIds !== null)
      ? this.db.sessions.filter(s => candidateIds!.has(s.id))
      : hadAnyTerm ? [] : [...this.db.sessions];

    // Filters
    if (filters.type) candidates = candidates.filter(s => s.observationType === filters.type);
    if (filters.sinceTs) candidates = candidates.filter(s => s.endTime >= filters.sinceTs!);
    if (filters.untilTs) candidates = candidates.filter(s => s.startTime <= filters.untilTs!);
    if (filters.workspaceOnly && wsId) candidates = candidates.filter(s => s.workspaceId === wsId);
    if (filters.tag) candidates = candidates.filter(s => s.userTags.includes(filters.tag!));
    if (filters.repoScope) candidates = candidates.filter(s => s.repoScope === filters.repoScope);

    // --- Rank 1: keyword score (term-frequency × field weight) ---
    const keywordScores = candidates.map(s => ({ s, score: this.keywordScore(s, terms, wsId) }));
    const keywordRanked = [...keywordScores].sort((a, b) => b.score - a.score);
    const keywordRankById = new Map<string, number>();
    keywordRanked.forEach((e, i) => keywordRankById.set(e.s.id, i));

    // --- Rank 2: recency (endTime desc) ---
    const recencyRanked = [...candidates].sort((a, b) => b.endTime - a.endTime);
    const recencyRankById = new Map<string, number>();
    recencyRanked.forEach((s, i) => recencyRankById.set(s.id, i));

    // --- Rank 3 (optional): embedding cosine similarity ---
    let embRankById: Map<string, number> | undefined;
    if (queryEmbedding && candidates.some(s => s.embedding)) {
      const embRanked = [...candidates]
        .map(s => ({ s, sim: cosineSim(queryEmbedding, s.embedding) }))
        .sort((a, b) => b.sim - a.sim);
      embRankById = new Map();
      embRanked.forEach((e, i) => embRankById!.set(e.s.id, i));
    }

    const K = 60;
    const now = Date.now();
    // 7-day half-life for recency decay
    const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

    const fused = candidates.map(s => {
      const kRank = keywordRankById.get(s.id) ?? K * 10;
      const rRank = recencyRankById.get(s.id) ?? K * 10;
      let rrf = 1 / (K + kRank) + 1 / (K + rRank);
      if (embRankById) {
        const eRank = embRankById.get(s.id) ?? K * 10;
        rrf += 1 / (K + eRank);
      }
      // Exponential decay: 2^(-age/halfLife) weighted at 0.3
      const ageMs = Math.max(0, now - s.endTime);
      const decay = Math.pow(2, -ageMs / HALF_LIFE_MS) * 0.3;
      // Workspace boost
      const wsBoost = wsId && s.workspaceId === wsId ? 0.15 : 0;
      return { s, score: rrf + decay + wsBoost };
    });

    fused.sort((a, b) => b.score - a.score || b.s.endTime - a.s.endTime);

    // Near-duplicate collapse: drop entries whose keyTopics Jaccard ≥ 0.9 with
    // an earlier (higher-ranked) kept entry. Keeps the top-ranked representative.
    const COLLAPSE_THRESHOLD = 0.9;
    const kept: typeof fused = [];
    for (const entry of fused) {
      const isDup = kept.some(k => jaccard(entry.s.keyTopics, k.s.keyTopics) >= COLLAPSE_THRESHOLD);
      if (!isDup) kept.push(entry);
      if (kept.length >= limit) break;
    }
    return kept.map(x => x.s);
  }

  /**
   * Async variant that also uses embeddings when available and, when enabled,
   * filters out sessions whose key files no longer exist in the workspace
   * (mirrors GitHub agentic memory's codebase-validation pass).
   */
  async searchWithEmbedding(query: string, filters: SearchFilters = {}, limit = 10): Promise<CompressedSession[]> {
    let vec: number[] | undefined;
    if (this.embedder && query && query.trim()) {
      try { vec = await this.embedder(query); } catch { /* ignore */ }
    }
    // Over-fetch so post-filtering by freshness still yields ~limit results.
    const overFetch = Math.max(limit * 3, limit + 5);
    const raw = this.search(query, filters, overFetch, vec);
    return this.filterByFreshness(raw, limit);
  }

  /**
   * Drop sessions with too many missing key files. Honours the
   * `validateAgainstCodebase` + `freshnessFloor` config knobs. Safe to call on
   * any list — if validation is disabled or there's no workspace, returns the
   * input slice unchanged.
   */
  async filterByFreshness(sessions: CompressedSession[], limit: number): Promise<CompressedSession[]> {
    const cfg = getConfig();
    if (!cfg.validateAgainstCodebase || cfg.freshnessFloor <= 0 || sessions.length === 0) {
      return sessions.slice(0, limit);
    }
    try {
      const results = await validateSessions(sessions);
      const kept: CompressedSession[] = [];
      for (const s of sessions) {
        const r = results.get(s.id);
        // Missing validation (e.g. no workspace) — keep, don't penalise.
        if (!r || r.emptyKeyFiles) { kept.push(s); }
        else if (r.freshness >= cfg.freshnessFloor) { kept.push(s); }
        if (kept.length >= limit) break;
      }
      return kept;
    } catch (err) {
      // Validator failure is non-fatal (we always have something to return),
      // but it indicates a real bug — surface it so the user can find it in
      // the developer console instead of silently degrading retrieval.
      console.warn('[GHCP-MEM] filterByFreshness validator failed; returning unfiltered slice:', err);
      return sessions.slice(0, limit);
    }
  }

  /** Timeline: sessions in chronological order within a time window. */
  timeline(centerTs: number, windowHours = 24, limit = 10): CompressedSession[] {
    const half = windowHours * 60 * 60 * 1000;
    const lo = centerTs - half;
    const hi = centerTs + half;
    return [...this.db.sessions]
      .filter(s => s.startTime >= lo && s.startTime <= hi)
      .sort((a, b) => a.startTime - b.startTime)
      .slice(0, limit);
  }

  getRelevantSessions(query: string, maxResults?: number): CompressedSession[] {
    const config = getConfig();
    const filters: SearchFilters = {};
    if (config.scope === 'workspace') filters.workspaceOnly = true;
    else if (config.scope === 'repo') filters.repoScope = getRepoScopeSync().id;
    return this.search(query, filters, maxResults ?? config.contextRetrievalCount);
  }

  getRecentSessions(count: number): CompressedSession[] {
    const workspace = this.getWorkspaceSessions();
    return workspace.slice(-count);
  }

  /**
   * Pick the top-N workspace sessions for startup auto-injection.
   *
   * Combines recency (7-day exponential decay) with explicit importance
   * signals so that a pinned/decision-bearing session can outrank a
   * recent-but-empty one. Falls back to pure recency when no signals exist.
   *
   * Score = recencyScore + importanceScore, where:
   *   recencyScore   = exp(-days / 7) * 10           // 0..10
   *   importanceScore = (userTags ? 10 : 0)
   *                   + (decisions.length ? 4 : 0)
   *                   + (problemsSolved.length ? 4 : 0)
   *                   + (observationType !== 'unknown' ? 1 : 0)
   *
   * Returns sessions in chronological (oldest-first) order to keep the
   * inject narrative flowing forwards — matching the existing
   * `getRecentSessions` contract used by the chat participant.
   */
  getStartupCandidates(count: number): CompressedSession[] {
    const config = getConfig();
    // Choose the candidate pool based on the configured scope.
    let workspace: CompressedSession[];
    if (config.scope === 'repo') workspace = this.getRepoSessions();
    else if (config.scope === 'user') workspace = this.getAllSessions();
    else workspace = this.getWorkspaceSessions();
    if (workspace.length === 0) return [];
    const now = Date.now();
    const DAY = 86_400_000;
    const scored = workspace.map(s => {
      const days = Math.max(0, (now - s.startTime) / DAY);
      const recency = Math.exp(-days / 7) * 10;
      const importance =
        (s.userTags.length ? 10 : 0) +
        (s.decisions.length ? 4 : 0) +
        (s.problemsSolved.length ? 4 : 0) +
        (s.observationType !== 'unknown' ? 1 : 0);
      return { s, score: recency + importance };
    });
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.s.startTime - a.s.startTime; // tie-break: newer first
    });
    const top = scored.slice(0, count).map(x => x.s);
    // Return oldest-first so the inject reads chronologically.
    top.sort((a, b) => a.startTime - b.startTime);
    return top;
  }

  async clear(): Promise<void> {
    this.db.sessions = [];
    this.index.clear();
    this.db.lastUpdated = Date.now();
    await this.persist();
  }

  async exportToJson(): Promise<string> {
    return JSON.stringify(this.db, null, 2);
  }

  async importFromJson(json: string, merge = true): Promise<{ imported: number; skippedInvalid: number }> {
    const parsed = JSON.parse(json) as ContextDatabase;
    if (!parsed || !Array.isArray(parsed.sessions)) {
      throw new Error('Invalid memory JSON format');
    }
    if (!merge) {
      this.db.sessions = [];
      this.index.clear();
    }
    const existingIds = new Set(this.db.sessions.map(s => s.id));
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let imported = 0;
    let skippedInvalid = 0;
    const r = (txt: string) => redact(txt, { redactSecrets: true, honorPrivateTags: true }).text;
    for (const s of parsed.sessions) {
      // Skip sessions with missing or malformed IDs to prevent injection.
      if (typeof s.id !== 'string' || !uuidRe.test(s.id)) { skippedInvalid++; continue; }
      if (existingIds.has(s.id)) continue;
      // Re-run redaction on import to protect against unredacted third-party data.
      const sanitized: CompressedSession = {
        ...s,
        summary: r(s.summary),
        decisions: (s.decisions ?? []).map(r),
        problemsSolved: (s.problemsSolved ?? []).map(r),
        keyTopics: (s.keyTopics ?? []).map(r),
      };
      this.db.sessions.push(sanitized);
      this.indexSession(sanitized);
      imported++;
    }
    this.db.sessions.sort((a, b) => a.startTime - b.startTime);
    await this.persist();
    return { imported, skippedInvalid };
  }

  getStats() {
    const ws = this.getWorkspaceSessions();
    return {
      totalSessions: this.db.sessions.length,
      workspaceSessions: ws.length,
      oldestSession: this.db.sessions.length ? this.db.sessions[0].startTime : null,
      newestSession: this.db.sessions.length ? this.db.sessions[this.db.sessions.length - 1].endTime : null,
      totalRedactions: this.db.sessions.reduce((a, s) => a + (s.redactionCount ?? 0), 0),
    };
  }

  // ── Internals ──

  /** Keyword-frequency score over weighted fields. Public-ish for tests. */
  keywordScore(s: CompressedSession, terms: Set<string>, wsId: string | undefined): number {
    return sharedKeywordScore(s, terms, wsId);
  }

  private indexSession(s: CompressedSession): void {
    const fields = [
      s.summary,
      ...s.keyFiles,
      ...s.keyTopics,
      ...s.decisions,
      ...s.problemsSolved,
      ...s.userTags,
      s.observationType,
    ];
    const tokens = this.extractTerms(fields.join(' '));
    for (const t of tokens) {
      let set = this.index.get(t);
      if (!set) {
        set = new Set();
        this.index.set(t, set);
      }
      set.add(s.id);
    }
  }

  private removeFromIndex(s: CompressedSession): void {
    // O(terms-in-session) instead of the previous O(total-unique-terms-in-store).
    // We rebuild the same token set the indexer used so we only touch the
    // buckets that could possibly contain this session id.
    const fields = [
      s.summary,
      ...s.keyFiles,
      ...s.keyTopics,
      ...s.decisions,
      ...s.problemsSolved,
      ...s.userTags,
      s.observationType,
    ];
    const tokens = this.extractTerms(fields.join(' '));
    for (const term of tokens) {
      const set = this.index.get(term);
      if (!set) continue;
      set.delete(s.id);
      if (set.size === 0) this.index.delete(term);
    }
  }

  private rebuildIndex(): void {
    this.index.clear();
    for (const s of this.db.sessions) this.indexSession(s);
  }

  /**
   * Chunked async index rebuild — avoids blocking the extension host UI thread
   * when restoring a large store (500+ sessions) from backup or globalState.
   */
  private rebuildIndexAsync(): Promise<void> {
    this.index.clear();
    const sessions = [...this.db.sessions];
    const CHUNK = 50;
    let i = 0;
    // Yield using a macrotask (setTimeout 0) so the index rebuild doesn't
    // starve the extension host UI thread on large stores. We use setTimeout
    // rather than setImmediate because setImmediate is not available in the
    // VS Code web extension host (browser context).
    return new Promise<void>(resolve => {
      const step = () => {
        const end = Math.min(i + CHUNK, sessions.length);
        for (; i < end; i++) this.indexSession(sessions[i]);
        if (i < sessions.length) {
          setTimeout(step, 0);
        } else {
          resolve();
        }
      };
      setTimeout(step, 0);
    });
  }

  private extractTerms(text: string): Set<string> {
    return sharedExtractTerms(text);
  }

  private async persist(): Promise<void> {
    try {
      await this.writeBackup(this.db);
    } catch (err) {
      console.warn('[GHCP-MEM] backup failed:', err);
    }
    await this.globalState.update(DB_KEY, this.db);
    // Best-effort mirror to ~/.ghcp-mem/sessions.json so the standalone
    // MCP server (used by Cursor/Cline/Windsurf) can read our store.
    // Serialised through a queue to prevent interleaved writes from rapid
    // successive addSession / tag / delete calls.
    this.syncQueue = this.syncQueue.then(() => this.syncToDisk()).catch(() => {});
    this.onChangeEmitter.fire();
  }

  /**
   * Mirror the database to `~/.ghcp-mem/sessions.json` for the standalone
   * MCP server. Non-fatal on error (e.g. sandboxed FS, read-only HOME).
   *
   * Writes via tmp-file + rename so concurrent MCP readers never observe a
   * partially written / truncated JSON document, and uses compact JSON to
   * cut disk I/O roughly in half versus pretty-printed output.
   */
  private async syncToDisk(): Promise<void> {
    try {
      // Lazy-load fs so test mocks of the store don't need node:fs.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs').promises as typeof import('fs').promises;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const os = require('os') as typeof import('os');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = require('path') as typeof import('path');
      const dir = path.join(os.homedir(), '.ghcp-mem');
      await fs.mkdir(dir, { recursive: true });
      // Restrict directory to owner-only on creation (best-effort on non-POSIX).
      try { await fs.chmod(dir, 0o700); } catch { /* ignore on Windows */ }
      const finalPath = path.join(dir, 'sessions.json');
      const tmpPath = `${finalPath}.${process.pid}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(this.db), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmpPath, finalPath);
      // Ensure permissions if the file already existed with wrong mode.
      try { await fs.chmod(finalPath, 0o600); } catch { /* ignore on Windows */ }
    } catch {
      // ignore
    }
  }

  /** Rotating backup: keeps the last MAX_BACKUPS JSON snapshots in globalStorageUri. */
  private async writeBackup(db: ContextDatabase): Promise<void> {
    if (!this.backupDir) return;
    // Throttle: writing a full backup on every addSession/tag/delete causes
    // unnecessary disk churn and serializes the entire DB each time. One
    // snapshot every BACKUP_MIN_INTERVAL_MS is sufficient for crash recovery.
    const nowTs = Date.now();
    if (nowTs - this.lastBackupAt < BACKUP_MIN_INTERVAL_MS) return;
    this.lastBackupAt = nowTs;
    try {
      await vscode.workspace.fs.createDirectory(this.backupDir);
      const now = new Date();
      const stamp = now.toISOString().replace(/[:.]/g, '-');
      const file = vscode.Uri.joinPath(this.backupDir, `ghcp-mem-${stamp}.json`);
      await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(db), 'utf-8'));
      // Prune old backups
      const entries = await vscode.workspace.fs.readDirectory(this.backupDir);
      const backups = entries
        .filter(([n]) => n.startsWith('ghcp-mem-') && n.endsWith('.json'))
        .map(([n]) => n)
        .sort();
      while (backups.length > MAX_BACKUPS) {
        const oldest = backups.shift()!;
        try {
          await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.backupDir, oldest));
        } catch {
          // ignore
        }
      }
    } catch {
      // Non-fatal
    }
  }

  /** List available backups (newest first). */
  async listBackups(): Promise<{ name: string; uri: vscode.Uri }[]> {
    if (!this.backupDir) return [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.backupDir);
      return entries
        .filter(([n]) => n.startsWith('ghcp-mem-') && n.endsWith('.json'))
        .map(([n]) => ({ name: n, uri: vscode.Uri.joinPath(this.backupDir!, n) }))
        .sort((a, b) => b.name.localeCompare(a.name));
    } catch {
      return [];
    }
  }

  /** Restore the database from a backup file. Replaces current contents. */
  async restoreFromBackup(uri: vscode.Uri): Promise<number> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf-8')) as ContextDatabase;
    if (!parsed || !Array.isArray(parsed.sessions)) {
      throw new Error('Invalid backup file');
    }
    // Re-run redaction on restore — consistent with importFromJson and importPack.
    const r = (txt: string) => redact(txt, { redactSecrets: true, honorPrivateTags: true }).text;
    const sanitized = parsed.sessions.map((s): CompressedSession => ({
      ...s,
      summary: r(s.summary),
      decisions: (s.decisions ?? []).map(r),
      problemsSolved: (s.problemsSolved ?? []).map(r),
      keyTopics: (s.keyTopics ?? []).map(r),
    }));
    this.db = { version: DB_VERSION, sessions: sanitized, lastUpdated: Date.now() };
    await this.rebuildIndexAsync();
    await this.globalState.update(DB_KEY, this.db);
    this.onChangeEmitter.fire();
    return this.db.sessions.length;
  }

  dispose(): void {
    this.onChangeEmitter.dispose();
  }
}
