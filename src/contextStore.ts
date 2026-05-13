import * as vscode from 'vscode';
import { CompressedSession, ContextDatabase, ObservationType, getConfig } from './types';
import { cosineSim, EmbeddingFn } from './embeddings';

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
  /** Optional: set by extension.ts once the embedder is resolved. */
  embedder?: EmbeddingFn;
  private lastBackupAt = 0;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly backupDir?: vscode.Uri,
  ) {
    this.db = this.load();
    this.rebuildIndex();
    this.enforceRetention().catch(() => {});
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
    await this.enforceRetention();
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

  getAllSessions(): CompressedSession[] {
    return [...this.db.sessions];
  }

  getWorkspaceSessions(): CompressedSession[] {
    const wsId = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    if (!wsId) return [...this.db.sessions];
    return this.db.sessions.filter(s => s.workspaceId === wsId);
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
    let candidateIds: Set<string> | null = null;
    for (const term of terms) {
      const hits = this.index.get(term);
      if (!hits) continue;
      if (candidateIds === null) {
        candidateIds = new Set(hits);
      } else {
        for (const id of candidateIds) {
          if (!hits.has(id)) candidateIds.delete(id);
        }
      }
    }

    let candidates = candidateIds
      ? this.db.sessions.filter(s => candidateIds!.has(s.id))
      : [...this.db.sessions];

    // Filters
    if (filters.type) candidates = candidates.filter(s => s.observationType === filters.type);
    if (filters.sinceTs) candidates = candidates.filter(s => s.endTime >= filters.sinceTs!);
    if (filters.untilTs) candidates = candidates.filter(s => s.startTime <= filters.untilTs!);
    if (filters.workspaceOnly && wsId) candidates = candidates.filter(s => s.workspaceId === wsId);
    if (filters.tag) candidates = candidates.filter(s => s.userTags.includes(filters.tag!));

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
   * Async variant that also uses embeddings when available.
   * Safe to call even if the embedder is not configured.
   */
  async searchWithEmbedding(query: string, filters: SearchFilters = {}, limit = 10): Promise<CompressedSession[]> {
    let vec: number[] | undefined;
    if (this.embedder && query && query.trim()) {
      try { vec = await this.embedder(query); } catch { /* ignore */ }
    }
    return this.search(query, filters, limit, vec);
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
    return this.search(query, { workspaceOnly: true }, maxResults ?? config.contextRetrievalCount);
  }

  getRecentSessions(count: number): CompressedSession[] {
    const workspace = this.getWorkspaceSessions();
    return workspace.slice(-count);
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

  async importFromJson(json: string, merge = true): Promise<{ imported: number }> {
    const parsed = JSON.parse(json) as ContextDatabase;
    if (!parsed || !Array.isArray(parsed.sessions)) {
      throw new Error('Invalid memory JSON format');
    }
    if (!merge) {
      this.db.sessions = [];
      this.index.clear();
    }
    const existingIds = new Set(this.db.sessions.map(s => s.id));
    let imported = 0;
    for (const s of parsed.sessions) {
      if (existingIds.has(s.id)) continue;
      this.db.sessions.push(s);
      this.indexSession(s);
      imported++;
    }
    this.db.sessions.sort((a, b) => a.startTime - b.startTime);
    await this.persist();
    return { imported };
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
    let score = 0;
    if (wsId && s.workspaceId === wsId) score += 2;

    const check = (text: string, weight: number) => {
      const tokens = this.extractTerms(text);
      for (const t of terms) if (tokens.has(t)) score += weight;
    };
    check(s.summary, 3);
    for (const t of s.keyTopics) check(t, 5);
    for (const f of s.keyFiles) check(f, 2);
    for (const d of s.decisions) check(d, 4);
    for (const p of s.problemsSolved) check(p, 4);
    for (const t of s.userTags) check(t, 6);
    return score;
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
    for (const [term, set] of this.index) {
      set.delete(s.id);
      if (set.size === 0) this.index.delete(term);
    }
  }

  private rebuildIndex(): void {
    this.index.clear();
    for (const s of this.db.sessions) this.indexSession(s);
  }

  private extractTerms(text: string): Set<string> {
    return new Set(
      (text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2)
    );
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
    this.syncToDisk().catch(() => {});
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
      const finalPath = path.join(dir, 'sessions.json');
      const tmpPath = `${finalPath}.${process.pid}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(this.db), 'utf8');
      await fs.rename(tmpPath, finalPath);
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
    this.db = { version: DB_VERSION, sessions: parsed.sessions, lastUpdated: Date.now() };
    this.rebuildIndex();
    await this.globalState.update(DB_KEY, this.db);
    this.onChangeEmitter.fire();
    return this.db.sessions.length;
  }

  dispose(): void {
    this.onChangeEmitter.dispose();
  }
}
