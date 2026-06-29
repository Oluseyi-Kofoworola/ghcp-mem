import * as vscode from 'vscode';
import { CompressedSession, ContextDatabase, ObservationType, getConfig } from './types';
import { cosineSim, EmbeddingFn } from './embeddings';
import { redact } from './redactor';
import {
  extractTerms as sharedExtractTerms,
  keywordScore as sharedKeywordScore,
  computeTermStats,
  keywordScoreFromStats,
  SessionTermStats,
} from './searchCore';
import { validateSessions } from './validator';
import { getRepoScopeSync } from './repoScope';
import { aggregateTokenSavings } from './savings';
import { classifyIntent, intentWeights } from './queryIntent';
import { expandQuery } from './queryExpansion';
import { effectiveConfidence } from './decay';
import { walkSupersedesChain } from './entity';
import {
  Snippet,
  snippetsFromSession,
  snippetScore,
  tokenizeSnippet,
  avgSnippetLen,
} from './snippets';
import { ConflictWarning, detectConflicts } from './conflicts';
import {
  AdaptiveWeightsState,
  FeedbackSample,
  SignalName,
  emptyState,
  recordSample,
  recomputeWeights,
  applyRecomputedWeights,
  defaultWeights,
} from './adaptiveWeights';
import { Lesson } from './lessons';
const DB_KEY = 'ghcpMem.contextDatabase';
const ADAPTIVE_KEY = 'ghcpMem.adaptiveWeights';
const DB_VERSION = 2;
const MAX_BACKUPS = 5;
const BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Jaccard similarity on two string arrays (case-insensitive, deduped). */
function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  const sa = new Set(a.map((s) => s.toLowerCase()));
  const sb = new Set(b.map((s) => s.toLowerCase()));
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
  /**
   * Per-session BM25 term statistics, memoised at index time. Eliminates the
   * per-query O(candidates × fields) re-tokenisation that was the dominant cost
   * in `search()` as the store grows. Kept in lockstep with `index` — every
   * `indexSession` writes it, every `removeFromIndex` clears it.
   */
  private termStats = new Map<string, SessionTermStats>();
  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onChange = this.onChangeEmitter.event;
  /** Phase 4 pending conflict warnings, kept in memory (not persisted). */
  private pendingConflicts: ConflictWarning[] = [];
  /** Phase 5 adaptive ranking state, persisted separately from the session db. */
  private adaptiveState: AdaptiveWeightsState = emptyState();
  /**
   * Per-session snapshot of the signal values used the last time the session
   * was returned by `search()`. Lets `recordAcceptance` / `recordRejection`
   * feed accurate sample values back into the learner without having to
   * rerun the entire fusion pipeline.
   */
  private lastRetrievalSignals: Map<string, Record<SignalName, number>> = new Map();
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
    // Load any previously-learned adaptive ranking state. Failure is fine —
    // the system simply behaves as the static ranker until enough signal
    // accumulates again.
    try {
      const stored = this.globalState.get<AdaptiveWeightsState>(ADAPTIVE_KEY);
      if (stored && stored.weights) {
        this.adaptiveState = stored;
      }
    } catch {
      /* keep empty state */
    }
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

    // v1.13.0: pre-persist quality gate. If qualityPersistFloor > 0 and the
    // session's quality score is below the floor, drop it BEFORE it hits disk.
    // Distinct from `qualityFloor` (which only excludes from injection but
    // keeps the row on disk for janitor review). Pinned (`userTags` has
    // 'pinned') and correction sessions are never gated — they're user-asserted
    // intent. The score uses the same heuristic as the janitor (see
    // src/quality.ts).
    const isUserPinned = session.userTags?.includes('pinned') ?? false;
    if (config.qualityPersistFloor > 0 && !isUserPinned && !session.correctionOf) {
      try {
        const { scoreSessionQuality } = await import('./quality');
        const q = scoreSessionQuality(session);
        if (q.score < config.qualityPersistFloor) {
          console.log(
            `[GHCP-MEM] dropped low-quality capture before persist ` +
              `(score=${q.score.toFixed(2)} < floor=${config.qualityPersistFloor}; ` +
              `id=${session.id.slice(0, 8)})`,
          );
          return;
        }
      } catch (err) {
        console.warn(
          '[GHCP-MEM] pre-persist quality gate failed (non-fatal, persisting anyway):',
          err,
        );
      }
    }

    // Content-hash dedup — if an identical-content session already exists,
    // merge tags + bump endTime instead of creating a new row.
    if (session.contentHash) {
      const dup = this.db.sessions.find((s) => s.contentHash === session.contentHash);
      if (dup) {
        dup.endTime = Math.max(dup.endTime, session.endTime);
        dup.rawEventCount += session.rawEventCount;
        for (const t of session.userTags) if (!dup.userTags.includes(t)) dup.userTags.push(t);
        this.indexSession(dup);
        await this.persist();
        return;
      }
    }

    // Phase 4 conflict detection — runs BEFORE persisting so we see the
    // pre-existing corpus. Warnings are stored in-memory and surfaced via
    // `getPendingConflicts` / `/conflicts`. Detection is best-effort: a
    // failure here must never block session capture.
    try {
      const warnings = detectConflicts(session, this.db.sessions);
      for (const w of warnings) this.pendingConflicts.push(w);
    } catch (err) {
      console.warn('[GHCP-MEM] conflict detection failed (non-fatal):', err);
    }

    this.db.sessions.push(session);
    this.db.lastUpdated = Date.now();
    // Best-effort embedding — runs async after the session is indexed, so
    // it never blocks persistence and failures don't surface to users.
    if (!session.embedding && this.embedder) {
      const text = [
        session.summary,
        ...session.keyTopics,
        ...session.keyFiles,
        ...session.decisions,
        ...session.problemsSolved,
      ].join(' ');
      // Capture the id by value so the closure doesn't pin the session ref;
      // we re-resolve from the live db at write time. Before v1.10.2 we
      // assigned `session.embedding = vec` directly to the captured object,
      // which (a) wrote to a dead reference if enforceSizeCap had evicted
      // the row between scheduling and resolution, and (b) raced with
      // concurrent addSession/persist mutations on the same row.
      const targetId = session.id;
      this.embedder(text)
        .then((vec) => {
          if (!vec) return;
          const current = this.db.sessions.find((s) => s.id === targetId);
          if (!current) return; // evicted between scheduling and resolution
          current.embedding = vec;
          this.globalState.update(DB_KEY, this.db).then(undefined, () => {});
        })
        .catch(() => {});
    }

    this.indexSession(session);

    if (this.db.sessions.length > config.maxStoredSessions) {
      const dropped = this.db.sessions.splice(
        0,
        this.db.sessions.length - config.maxStoredSessions,
      );
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
    this.db.sessions = this.db.sessions.filter((s) => {
      if (s.endTime < cutoff) {
        this.removeFromIndex(s);
        return false;
      }
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
    return this.db.sessions.filter((s) => s.workspaceId === wsId);
  }

  /**
   * Sessions tagged with the same repo scope as the currently open workspace.
   *
   * Backward-compat: sessions captured before `repoScope` was stamped
   * (pre-Phase-1.6) still match if their `workspaceId` equals the current
   * workspace URI. Otherwise upgraders would silently lose access to all
   * pre-existing memories the moment the default scope flipped to 'repo'.
   *
   * When no workspace is open (tests, sentinel scope), return all sessions —
   * there is nothing to scope against.
   */
  getRepoSessions(repoScopeId?: string): CompressedSession[] {
    const id = repoScopeId ?? getRepoScopeSync().id;
    if (!id || id === 'no-workspace') return [...this.db.sessions];
    const wsId = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    return this.db.sessions.filter(
      (s) => s.repoScope === id || (!s.repoScope && !!wsId && s.workspaceId === wsId),
    );
  }

  getById(idOrPrefix: string): CompressedSession | undefined {
    return this.db.sessions.find((s) => s.id === idOrPrefix || s.id.startsWith(idOrPrefix));
  }

  /**
   * Phase 3 multi-hop helper: return the full supersession lineage for a
   * session, oldest → newest. Useful for retrieval renderers that want to
   * show "this decision evolved through 3 prior versions" so the developer
   * understands the current decision isn't context-free.
   *
   * Returns `[session]` for sessions with no supersession history, or an
   * empty array when the ID is unknown.
   */
  getLineage(id: string): CompressedSession[] {
    const sessionsById = new Map<string, CompressedSession>();
    for (const s of this.db.sessions) sessionsById.set(s.id, s);
    return walkSupersedesChain(id, sessionsById);
  }

  /**
   * For each session in `results`, attach its lineage (oldest → newest) and
   * a list of symbol IDs surfaced via decisionEvidence. Consumers like the
   * chat /search command surface these as "see also" hints so a single
   * retrieval hop can carry an entire decision narrative + entity pointer
   * without forcing follow-up queries.
   */
  enrichWithMultiHop(results: CompressedSession[]): Array<{
    session: CompressedSession;
    lineage: CompressedSession[];
    relatedSymbols: string[];
    relatedFiles: string[];
  }> {
    const sessionsById = new Map<string, CompressedSession>();
    for (const s of this.db.sessions) sessionsById.set(s.id, s);
    return results.map((session) => {
      const lineage = walkSupersedesChain(session.id, sessionsById);
      const symbolSet = new Set<string>();
      const fileSet = new Set<string>();
      for (const evList of [
        ...(session.decisionEvidence ?? []),
        ...(session.problemEvidence ?? []),
      ]) {
        for (const ev of evList) {
          if (ev.symbolId) symbolSet.add(ev.symbolId);
          if (ev.filePath) fileSet.add(ev.filePath);
        }
      }
      return {
        session,
        lineage,
        relatedSymbols: [...symbolSet].slice(0, 5),
        relatedFiles: [...fileSet].slice(0, 5),
      };
    });
  }

  async deleteSession(id: string): Promise<boolean> {
    const i = this.db.sessions.findIndex((s) => s.id === id);
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
    const toRemove = this.db.sessions.filter((s) => idSet.has(s.id));
    for (const s of toRemove) this.removeFromIndex(s);
    this.db.sessions = this.db.sessions.filter((s) => !idSet.has(s.id));
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

  // ── Phase 2: supersession / retraction / correction mutators ───────────────

  /**
   * Mark `newerId` as superseding `olderId`. Both rows are retained on disk
   * so the audit trail survives; retrieval down-ranks `olderId` and skips it
   * for startup injection. Returns false when either ID is unknown.
   */
  async setSupersedes(newerId: string, olderId: string): Promise<boolean> {
    if (newerId === olderId) return false;
    const newer = this.getById(newerId);
    const older = this.getById(olderId);
    if (!newer || !older) return false;
    newer.supersedes = older.id;
    older.supersededBy = newer.id;
    // If a pending conflict warning matches this supersession, mark it
    // acknowledged so the user doesn't keep seeing it in /conflicts.
    this.acknowledgeConflict(newer.id, `Resolved via /supersede ${olderId.substring(0, 8)}`);
    await this.persist();
    return true;
  }

  /**
   * Retract a session so retrieval and injection skip it. The row stays on
   * disk so the developer can recover via the audit log; `undoRetract` clears
   * the flag.
   */
  async setRetracted(id: string, reason?: string): Promise<boolean> {
    const s = this.getById(id);
    if (!s) return false;
    s.retracted = true;
    if (reason && reason.trim()) {
      const customRules = getConfig().customRedactionRules;
      s.retractedReason = redact(reason, {
        redactSecrets: true,
        honorPrivateTags: true,
        customRules,
      }).text;
    }
    await this.persist();
    return true;
  }

  /** Reverse a previous `setRetracted` call. */
  async undoRetract(id: string): Promise<boolean> {
    const s = this.getById(id);
    if (!s) return false;
    if (!s.retracted) return true;
    s.retracted = false;
    s.retractedReason = undefined;
    await this.persist();
    return true;
  }

  /**
   * Mark a session as noise — same effect as the ingestion quality gate
   * deciding the session was low value. The row stays on disk; retrieval
   * and injection exclude it. `undoNoise` clears the flag.
   *
   * When `feedLearner` is set (the user-driven `/noise` path, as opposed to
   * the janitor's automatic re-scoring), we also push a negative sample into
   * the adaptive ranker so an explicit "this was noise" verdict nudges the
   * ranking weights — closing the feedback loop the same way `/reject` does.
   */
  async setNoise(id: string, feedLearner = false): Promise<boolean> {
    const s = this.getById(id);
    if (!s) return false;
    s.lowQuality = true;
    if (feedLearner) this.feedAdaptiveSample(s.id, -1);
    await this.persist();
    return true;
  }

  async undoNoise(id: string): Promise<boolean> {
    const s = this.getById(id);
    if (!s) return false;
    if (!s.lowQuality) return true;
    s.lowQuality = false;
    await this.persist();
    return true;
  }

  /**
   * Stamp `correctionId` as a correction of `originalId`. Use after
   * persisting a new session that captures the corrected information
   * (e.g. produced by the `/correct` chat command).
   */
  async addCorrection(originalId: string, correctionId: string): Promise<boolean> {
    if (originalId === correctionId) return false;
    const original = this.getById(originalId);
    const correction = this.getById(correctionId);
    if (!original || !correction) return false;
    correction.correctionOf = original.id;
    // Also chain supersession so retrieval treats the correction as the
    // authoritative version while the original stays on disk.
    original.supersededBy = correction.id;
    correction.supersedes = original.id;
    await this.persist();
    return true;
  }

  // ── Phase 2: local telemetry counters ─────────────────────────────────────

  /**
   * Throttled persistence for telemetry-only mutations. Counter writes can
   * fire on every search() call — we don't want to round-trip globalState
   * and the JSON mirror that often, so we coalesce into a 5 s window.
   */
  private telemetryDirty = false;
  private telemetryFlushTimer?: NodeJS.Timeout;
  private readonly TELEMETRY_FLUSH_MS = 5_000;

  private scheduleTelemetryFlush(): void {
    this.telemetryDirty = true;
    if (this.telemetryFlushTimer) return;
    this.telemetryFlushTimer = setTimeout(() => {
      this.telemetryFlushTimer = undefined;
      if (this.telemetryDirty) {
        this.telemetryDirty = false;
        void this.persist().catch(() => {});
      }
    }, this.TELEMETRY_FLUSH_MS);
  }

  /** Bump the retrieved counter for every session in `ids`. */
  bumpRetrieved(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    let any = false;
    for (const id of ids) {
      const s = this.getById(id);
      if (!s) continue;
      const u = s.usage ?? { retrieved: 0, lastRetrievedAt: 0, accepted: 0, rejected: 0 };
      u.retrieved += 1;
      u.lastRetrievedAt = now;
      s.usage = u;
      any = true;
    }
    if (any) this.scheduleTelemetryFlush();
  }

  /** Record that the developer found a retrieved memory useful. */
  async recordAcceptance(id: string): Promise<boolean> {
    const s = this.getById(id);
    if (!s) return false;
    const u = s.usage ?? { retrieved: 0, lastRetrievedAt: 0, accepted: 0, rejected: 0 };
    u.accepted += 1;
    u.lastInteractionAt = Date.now();
    s.usage = u;
    this.feedAdaptiveSample(id, 1);
    await this.persist();
    return true;
  }

  /** Record that the developer found a retrieved memory unhelpful or wrong. */
  async recordRejection(id: string): Promise<boolean> {
    const s = this.getById(id);
    if (!s) return false;
    const u = s.usage ?? { retrieved: 0, lastRetrievedAt: 0, accepted: 0, rejected: 0 };
    u.rejected += 1;
    u.lastInteractionAt = Date.now();
    s.usage = u;
    this.feedAdaptiveSample(id, -1);
    await this.persist();
    return true;
  }

  /**
   * Phase 5: pump a feedback sample into the adaptive learner. Uses the
   * per-signal snapshot captured by the last search(). When no snapshot
   * exists (e.g. user accepts a session they navigated to manually) we
   * skip — no signal values means no learning signal.
   *
   * Recomputes weights every time a sample lands. The recomputation is
   * deliberately cheap (5 floating-point ops) and bounded by MAX_STEP so
   * a burst of feedback can't whipsaw the ranker.
   */
  private feedAdaptiveSample(sessionId: string, feedback: 1 | -1): void {
    const values = this.lastRetrievalSignals.get(sessionId);
    if (!values) return;
    const sample: FeedbackSample = { values, feedback };
    recordSample(this.adaptiveState, sample);
    const next = recomputeWeights(this.adaptiveState);
    this.adaptiveState = applyRecomputedWeights(this.adaptiveState, next);
    // Persist asynchronously — adaptive state lives in its own globalState
    // key so we don't entangle it with the session DB serialisation path.
    this.globalState.update(ADAPTIVE_KEY, this.adaptiveState).then(undefined, () => {});
  }

  /** Phase 5: expose the current adaptive weights (defensive copy). */
  getAdaptiveWeights(): Record<SignalName, number> {
    return { ...this.adaptiveState.weights };
  }

  /** Phase 5: total feedback samples observed (test/diagnostic surface). */
  getAdaptiveSampleCount(): { accepted: number; rejected: number } {
    return {
      accepted: this.adaptiveState.acceptedCount,
      rejected: this.adaptiveState.rejectedCount,
    };
  }

  /** Phase 5: reset learned weights to defaults (escape hatch + tests). */
  async resetAdaptiveWeights(): Promise<void> {
    this.adaptiveState = emptyState();
    await this.globalState.update(ADAPTIVE_KEY, this.adaptiveState);
  }

  // ── Derived lessons (semantic + procedural memory) ────────────────────────

  /** Return all consolidated lessons (defensive copy of the array). */
  getLessons(): Lesson[] {
    return [...(this.db.lessons ?? [])];
  }

  /** Look up a lesson by full id or unique id prefix. */
  getLessonById(idOrPrefix: string): Lesson | undefined {
    const key = idOrPrefix.trim();
    if (!key) return undefined;
    const all = this.db.lessons ?? [];
    return all.find((l) => l.id === key) ?? all.find((l) => l.id.startsWith(key));
  }

  /**
   * Replace the full lesson set — used by the janitor after a consolidation
   * pass. Persists immediately so the on-disk JSON (which the stdio MCP
   * server reads) stays in sync.
   */
  async setLessons(lessons: Lesson[]): Promise<void> {
    this.db.lessons = lessons;
    await this.persist();
  }

  /**
   * Add or merge a single authored (pinned) lesson — the hot-path "remember
   * this" write. If a lesson with the same id already exists we keep the
   * pinned flag and refresh its text/tags rather than duplicating.
   */
  async addLesson(lesson: Lesson): Promise<void> {
    const all = this.db.lessons ?? [];
    const existing = all.find((l) => l.id === lesson.id);
    if (existing) {
      existing.text = lesson.text;
      existing.tags = Array.from(new Set([...existing.tags, ...lesson.tags])).slice(0, 12);
      existing.pinned = true;
      existing.updatedAt = lesson.updatedAt;
      existing.confidence = Math.max(existing.confidence, lesson.confidence);
    } else {
      all.push(lesson);
    }
    this.db.lessons = all;
    await this.persist();
  }

  /** Delete a lesson by id or prefix. Returns true if one was removed. */
  async deleteLesson(idOrPrefix: string): Promise<boolean> {
    const all = this.db.lessons ?? [];
    const before = all.length;
    this.db.lessons = all.filter((l) => l.id !== idOrPrefix && !l.id.startsWith(idOrPrefix));
    if (this.db.lessons.length === before) return false;
    await this.persist();
    return true;
  }

  /**
   * Force a pending telemetry flush — useful in tests and at extension
   * deactivation. No-op when nothing is queued.
   */
  async flushTelemetry(): Promise<void> {
    if (this.telemetryFlushTimer) {
      clearTimeout(this.telemetryFlushTimer);
      this.telemetryFlushTimer = undefined;
    }
    if (this.telemetryDirty) {
      this.telemetryDirty = false;
      await this.persist();
    }
  }

  /** Phase 4: return unacknowledged conflict warnings, newest first. */
  getPendingConflicts(): ConflictWarning[] {
    return [...this.pendingConflicts]
      .filter((w) => !w.acknowledged)
      .sort((a, b) => b.detectedAt - a.detectedAt);
  }

  /** Mark a conflict warning as acknowledged (e.g. after the user /supersedes). */
  acknowledgeConflict(newSessionId: string, reason?: string): boolean {
    const w = this.pendingConflicts.find((x) => x.newSessionId === newSessionId && !x.acknowledged);
    if (!w) return false;
    w.acknowledged = true;
    if (reason) w.acknowledgedReason = reason;
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
   *
   * Phase 1 grounding tweaks:
   *  - Soft union over inverted-index hits (not hard intersection) so a
   *    single rare-term miss no longer zeroes recall. The match-ratio
   *    becomes a ranking signal instead.
   *  - Per-session confidence (set at compression time) nudges ranking up
   *    or down so well-evidenced memories outrank ungrounded ones.
   *
   * Phase 2 Slice A enhancements:
   *  - Query intent classification reweights signals (recency-heavy for
   *    "what was I doing yesterday", BM25-heavy for entity lookups).
   *  - Co-occurrence query expansion recovers matches when the developer
   *    phrases the query differently from how the session was captured.
   *  - Retracted sessions are excluded outright.
   *  - Superseded sessions are down-ranked (kept for audit but pushed below
   *    their replacement).
   *  - Local reinforcement (`usage.retrieved` + accept/reject ratio) gently
   *    boosts memories the developer interacts with repeatedly.
   *  - Returned sessions get their `usage.retrieved` counter bumped, with
   *    throttled persistence so we don't write on every search.
   */
  search(
    query: string,
    filters: SearchFilters = {},
    limit = 10,
    queryEmbedding?: number[],
  ): CompressedSession[] {
    const baseTerms = this.extractTerms(query);
    const intent = classifyIntent(query ?? '');
    const weights = intentWeights(intent);

    // Query expansion: extend the term set with co-occurring terms drawn
    // from the inverted index. Tagged so we don't trigger the match-ratio
    // bonus for matches that came purely from expansion (we still want the
    // original-query match to dominate ranking).
    const expansionTerms = new Set<string>(
      expandQuery(baseTerms, this.index, this.db.sessions.length),
    );
    const terms = new Set<string>([...baseTerms, ...expansionTerms]);

    const wsId = vscode.workspace.workspaceFolders?.[0]?.uri.toString();

    // Candidate set via inverted index — SOFT UNION. Take every session that
    // matches at least one query term, plus a count of how many ORIGINAL
    // (un-expanded) terms each session matched. The match-ratio is used
    // later as a ranking signal so sessions that hit more terms still win,
    // but a single rare-term miss no longer zeroes out recall.
    const termMatchCount = new Map<string, number>();
    let hadAnyTerm = false;
    for (const term of baseTerms) {
      hadAnyTerm = true;
      const hits = this.index.get(term);
      if (!hits || hits.size === 0) continue;
      for (const id of hits) {
        termMatchCount.set(id, (termMatchCount.get(id) ?? 0) + 1);
      }
    }
    // Expansion terms broaden the candidate pool without contributing to
    // match-ratio.
    const expansionMatched = new Set<string>();
    for (const term of expansionTerms) {
      const hits = this.index.get(term);
      if (!hits) continue;
      for (const id of hits) expansionMatched.add(id);
    }

    let candidates: CompressedSession[];
    if (hadAnyTerm) {
      candidates = this.db.sessions.filter(
        (s) => termMatchCount.has(s.id) || expansionMatched.has(s.id),
      );
    } else {
      // No query → return everything (recency fusion will sort it).
      candidates = [...this.db.sessions];
    }

    // Filter retracted sessions — they're kept on disk for audit but never
    // surface in retrieval.
    candidates = candidates.filter((s) => !s.retracted);

    // Filters
    if (filters.type) candidates = candidates.filter((s) => s.observationType === filters.type);
    if (filters.sinceTs) candidates = candidates.filter((s) => s.endTime >= filters.sinceTs!);
    if (filters.untilTs) candidates = candidates.filter((s) => s.startTime <= filters.untilTs!);
    if (filters.workspaceOnly && wsId)
      candidates = candidates.filter((s) => s.workspaceId === wsId);
    if (filters.tag) candidates = candidates.filter((s) => s.userTags.includes(filters.tag!));
    if (filters.repoScope) {
      // Mirror getRepoSessions: legacy sessions without repoScope still match
      // if their workspaceId equals the current workspace.
      candidates = candidates.filter(
        (s) =>
          s.repoScope === filters.repoScope || (!s.repoScope && !!wsId && s.workspaceId === wsId),
      );
    }

    // --- Rank 1: keyword score (BM25 with field weights) ---
    // Uses the memoised per-session term stats so we don't re-tokenise every
    // candidate's fields on every query. Numerically identical to the
    // un-memoised path (computeAvgDocLen + keywordScore).
    const avgDocLen = candidates.length
      ? candidates.reduce((sum, s) => sum + this.statsFor(s).docLenWeighted, 0) / candidates.length
      : 50;
    const keywordScores = candidates.map((s) => ({
      s,
      score: keywordScoreFromStats(
        this.statsFor(s),
        terms,
        !!wsId && s.workspaceId === wsId,
        avgDocLen,
      ),
    }));
    const keywordRanked = [...keywordScores].sort((a, b) => b.score - a.score);
    const keywordRankById = new Map<string, number>();
    keywordRanked.forEach((e, i) => keywordRankById.set(e.s.id, i));

    // --- Rank 2: recency (endTime desc) ---
    const recencyRanked = [...candidates].sort((a, b) => b.endTime - a.endTime);
    const recencyRankById = new Map<string, number>();
    recencyRanked.forEach((s, i) => recencyRankById.set(s.id, i));

    // --- Rank 3 (optional): embedding cosine similarity ---
    let embRankById: Map<string, number> | undefined;
    if (queryEmbedding && candidates.some((s) => s.embedding)) {
      const embRanked = [...candidates]
        .map((s) => ({ s, sim: cosineSim(queryEmbedding, s.embedding) }))
        .sort((a, b) => b.sim - a.sim);
      embRankById = new Map();
      embRanked.forEach((e, i) => embRankById!.set(e.s.id, i));
    }

    const K = 60;
    const now = Date.now();
    // 7-day half-life for recency decay
    const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
    const termCount = baseTerms.size;
    // Reinforcement normaliser — divides log(1 + max retrieved) so the
    // strongest-used memory caps the boost at a fixed weight.
    let maxRetrieved = 1;
    for (const s of candidates) {
      const r = s.usage?.retrieved ?? 0;
      if (r > maxRetrieved) maxRetrieved = r;
    }
    const reinforcementNorm = Math.log(1 + maxRetrieved) || 1;

    // Phase 5: pull learned weight multipliers. When learning hasn't yet
    // collected enough samples this returns 1.0 across the board and
    // ranking matches the static behaviour.
    const learned = this.adaptiveState.weights ?? defaultWeights();

    const fused = candidates.map((s) => {
      const kRank = keywordRankById.get(s.id) ?? K * 10;
      const rRank = recencyRankById.get(s.id) ?? K * 10;
      const kComponent = (1 / (K + kRank)) * weights.keywordWeight * learned.keyword;
      const rComponent = 1 / (K + rRank);
      let rrf = kComponent + rComponent;
      if (embRankById) {
        const eRank = embRankById.get(s.id) ?? K * 10;
        rrf += 1 / (K + eRank);
      }
      // Exponential decay: 2^(-age/halfLife) weighted at 0.3 — intent
      // weights can multiply this up for "recent"-flavoured queries.
      const ageMs = Math.max(0, now - s.endTime);
      const recencyValue = Math.pow(2, -ageMs / HALF_LIFE_MS);
      const decay = recencyValue * 0.3 * weights.recencyMultiplier * learned.recency;
      // Workspace boost
      const wsBoost = wsId && s.workspaceId === wsId ? 0.15 : 0;
      // Match-ratio boost: rewards sessions that hit more of the query
      // terms. Caps the soft-union recall lift so a 1-of-4 match doesn't
      // outrank a 4-of-4 match purely on recency.
      const matchRatio = termCount > 0 ? (termMatchCount.get(s.id) ?? 0) / termCount : 0;
      const matchBoost = matchRatio * 0.25;
      // Confidence weight: low-confidence memories (no evidence, fallback
      // compressor, heavy redaction) get gently down-ranked. Defaults to
      // 0.5 for legacy sessions without a confidence score. Phase 3 uses
      // the decayed effective confidence so stale memories also fade.
      const confValue = effectiveConfidence(s) ?? 0.5;
      const confBoost = (confValue - 0.5) * 0.1 * learned.confidence;
      // Intent-driven decision/problem boosts (decision queries lift
      // sessions with non-empty decisions, etc.).
      const decisionBoost =
        weights.decisionBoost > 0 && s.decisions.length > 0 ? weights.decisionBoost : 0;
      const problemBoost =
        weights.problemBoost > 0 && s.problemsSolved.length > 0 ? weights.problemBoost : 0;
      // Supersession penalty — keeps the older row visible but well below
      // its replacement.
      const supersededPenalty = s.supersededBy ? -0.3 : 0;
      // Local reinforcement: log-normalised retrieval count plus a
      // tie-breaker for explicit accept/reject feedback.
      const retrieved = s.usage?.retrieved ?? 0;
      const reinforcementValue = Math.log(1 + retrieved) / reinforcementNorm;
      const reinforcement = reinforcementValue * 0.1 * learned.reinforcement;
      const accepted = s.usage?.accepted ?? 0;
      const rejected = s.usage?.rejected ?? 0;
      const feedbackValue = accepted - rejected;
      const feedback = feedbackValue * 0.05 * learned.feedback;
      // Snapshot the per-signal values so a later accept/reject can feed
      // them back into the adaptive learner.
      this.lastRetrievalSignals.set(s.id, {
        keyword: 1 / (K + kRank),
        recency: recencyValue,
        confidence: confValue,
        reinforcement: reinforcementValue,
        feedback: feedbackValue,
      });
      return {
        s,
        score:
          rrf +
          decay +
          wsBoost +
          matchBoost +
          confBoost +
          decisionBoost +
          problemBoost +
          supersededPenalty +
          reinforcement +
          feedback,
      };
    });

    fused.sort((a, b) => b.score - a.score || b.s.endTime - a.s.endTime);

    // Near-duplicate collapse: drop entries whose keyTopics Jaccard ≥ 0.9 with
    // an earlier (higher-ranked) kept entry. Keeps the top-ranked representative.
    const COLLAPSE_THRESHOLD = 0.9;
    const kept: typeof fused = [];
    for (const entry of fused) {
      const isDup = kept.some(
        (k) => jaccard(entry.s.keyTopics, k.s.keyTopics) >= COLLAPSE_THRESHOLD,
      );
      if (!isDup) kept.push(entry);
      if (kept.length >= limit) break;
    }
    const result = kept.map((x) => x.s);
    // Phase 2 reinforcement: bump retrieved counters with throttled persist.
    // Only fires when the query had at least one term — empty-query "browse"
    // calls (timeline/recent) shouldn't pollute the reinforcement signal.
    if (hadAnyTerm && result.length > 0) {
      this.bumpRetrieved(result.map((s) => s.id));
    }
    return result;
  }

  /**
   * Async variant that also uses embeddings when available and, when enabled,
   * filters out sessions whose key files no longer exist in the workspace
   * (mirrors GitHub agentic memory's codebase-validation pass).
   */
  async searchWithEmbedding(
    query: string,
    filters: SearchFilters = {},
    limit = 10,
  ): Promise<CompressedSession[]> {
    let vec: number[] | undefined;
    if (this.embedder && query && query.trim()) {
      try {
        vec = await this.embedder(query);
      } catch {
        /* ignore */
      }
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
  async filterByFreshness(
    sessions: CompressedSession[],
    limit: number,
  ): Promise<CompressedSession[]> {
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
        if (!r || r.emptyKeyFiles) {
          kept.push(s);
        }
        // Use grounded freshness (drift-aware) when available, fall back to
        // plain freshness for legacy results / tests that don't populate it.
        else if ((r.groundedFreshness ?? r.freshness) >= cfg.freshnessFloor) {
          kept.push(s);
        }
        if (kept.length >= limit) break;
      }
      return kept;
    } catch (err) {
      // Validator failure is non-fatal (we always have something to return),
      // but it indicates a real bug — surface it so the user can find it in
      // the developer console instead of silently degrading retrieval.
      console.warn(
        '[GHCP-MEM] filterByFreshness validator failed; returning unfiltered slice:',
        err,
      );
      return sessions.slice(0, limit);
    }
  }

  /** Timeline: sessions in chronological order within a time window. */
  timeline(centerTs: number, windowHours = 24, limit = 10): CompressedSession[] {
    const half = windowHours * 60 * 60 * 1000;
    const lo = centerTs - half;
    const hi = centerTs + half;
    return [...this.db.sessions]
      .filter((s) => s.startTime >= lo && s.startTime <= hi)
      .sort((a, b) => a.startTime - b.startTime)
      .slice(0, limit);
  }

  /**
   * Phase 4 chunk-level retrieval. Returns the top-N snippets matching the
   * query, ranked by BM25 + recency + decayed confidence + match-ratio.
   * Snippets are derived from sessions on demand (no extra storage), and
   * filtering is consistent with `search()`:
   *
   *   - Retracted parent sessions excluded.
   *   - Superseded parent sessions down-ranked (kept for audit).
   *   - WorkspaceOnly/repoScope filters honoured via the parent session.
   *
   * Cheap by design: O(snippets) scan per query — fine for the typical
   * store size (≤10K sessions, ≤100K snippets). For larger corpora the
   * caller can pass `prefilteredSessions` to scope to a candidate set
   * already narrowed by the session-level search.
   */
  searchSnippets(
    query: string,
    filters: SearchFilters = {},
    limit = 10,
    prefilteredSessions?: CompressedSession[],
  ): Snippet[] {
    const wsId = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    const sessionPool = prefilteredSessions ?? this.db.sessions;

    // Apply session-level filters before decomposing so we don't bother
    // building snippets for sessions we'd reject anyway.
    let scoped = sessionPool.filter((s) => !s.retracted);
    if (filters.type) scoped = scoped.filter((s) => s.observationType === filters.type);
    if (filters.sinceTs) scoped = scoped.filter((s) => s.endTime >= filters.sinceTs!);
    if (filters.untilTs) scoped = scoped.filter((s) => s.startTime <= filters.untilTs!);
    if (filters.workspaceOnly && wsId) scoped = scoped.filter((s) => s.workspaceId === wsId);
    if (filters.tag) scoped = scoped.filter((s) => s.userTags.includes(filters.tag!));
    if (filters.repoScope) {
      scoped = scoped.filter(
        (s) =>
          s.repoScope === filters.repoScope || (!s.repoScope && !!wsId && s.workspaceId === wsId),
      );
    }

    const snippets: Snippet[] = [];
    for (const s of scoped) snippets.push(...snippetsFromSession(s));
    if (snippets.length === 0) return [];

    const terms = tokenizeSnippet(query);
    if (terms.size === 0) {
      // No query terms → return snippets newest-first.
      return [...snippets].sort((a, b) => b.emittedAt - a.emittedAt).slice(0, limit);
    }

    const avgDocLen = avgSnippetLen(snippets);
    const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const scored = snippets
      .map((sn) => {
        const keyword = snippetScore(sn, terms, avgDocLen);
        if (keyword === 0) return undefined;
        const age = Math.max(0, now - sn.emittedAt);
        const decay = Math.pow(2, -age / HALF_LIFE_MS) * 0.3;
        const wsBoost = wsId && sn.workspaceId === wsId ? 0.15 : 0;
        const conf = sn.confidence ?? 0.5;
        const confBoost = (conf - 0.5) * 0.1;
        const supersededPenalty = sn.supersededBy ? -0.3 : 0;
        return { sn, score: keyword + decay + wsBoost + confBoost + supersededPenalty };
      })
      .filter((e): e is { sn: Snippet; score: number } => !!e)
      .sort((a, b) => b.score - a.score || b.sn.emittedAt - a.sn.emittedAt);

    return scored.slice(0, limit).map((e) => e.sn);
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
    // Always union in sessions tagged as "global" (org standards, naming,
    // WAF, etc.) regardless of scope — these are the explicit allow-list
    // for cross-repo knowledge.
    const globalTags = config.globalTags ?? [];
    if (globalTags.length > 0) {
      const seen = new Set(workspace.map((s) => s.id));
      for (const s of this.db.sessions) {
        if (seen.has(s.id)) continue;
        if (s.userTags.some((t) => globalTags.includes(t.toLowerCase()))) {
          workspace.push(s);
          seen.add(s.id);
        }
      }
    }
    if (workspace.length === 0) return [];
    // Exclude retracted sessions and sessions superseded by a more recent
    // one. Both stay on disk for audit but we never want the auto-injected
    // brief to surface a contradicted/retracted memory.
    workspace = workspace.filter((s) => !s.retracted && !s.supersededBy && !s.lowQuality);
    if (workspace.length === 0) return [];
    // Conflict-aware: if a newer session in the pool contradicts an older
    // one (shared file/topic + contradiction marker), drop the older side
    // so the injected brief doesn't carry both contradicting decisions.
    const dropped = new Set<string>();
    for (const s of workspace) {
      const others = workspace.filter((o) => o.id !== s.id && o.startTime < s.startTime);
      const warnings = detectConflicts(s, others);
      for (const w of warnings) {
        for (const c of w.candidates) dropped.add(c.sessionId);
      }
    }
    if (dropped.size > 0) workspace = workspace.filter((s) => !dropped.has(s.id));
    if (workspace.length === 0) return [];
    const now = Date.now();
    const DAY = 86_400_000;
    const scored = workspace.map((s) => {
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
    const top = scored.slice(0, count).map((x) => x.s);
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

  async clearWorkspace(): Promise<number> {
    const wsId = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    if (!wsId) return 0;
    const before = this.db.sessions.length;
    const toRemove = this.db.sessions.filter((s) => s.workspaceId === wsId);
    for (const s of toRemove) this.removeFromIndex(s);
    this.db.sessions = this.db.sessions.filter((s) => s.workspaceId !== wsId);
    const removed = before - this.db.sessions.length;
    if (removed > 0) {
      this.db.lastUpdated = Date.now();
      await this.persist();
    }
    return removed;
  }

  async purgeSession(id: string): Promise<boolean> {
    return this.deleteSession(id);
  }

  async exportToJson(): Promise<string> {
    return JSON.stringify(this.db, null, 2);
  }

  async importFromJson(
    json: string,
    merge = true,
  ): Promise<{ imported: number; skippedInvalid: number }> {
    const parsed = JSON.parse(json) as ContextDatabase;
    if (!parsed || !Array.isArray(parsed.sessions)) {
      throw new Error('Invalid memory JSON format');
    }
    if (!merge) {
      this.db.sessions = [];
      this.index.clear();
    }
    const existingIds = new Set(this.db.sessions.map((s) => s.id));
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let imported = 0;
    let skippedInvalid = 0;
    const r = (txt: string) => redact(txt, { redactSecrets: true, honorPrivateTags: true }).text;
    for (const s of parsed.sessions) {
      // Skip sessions with missing or malformed IDs to prevent injection.
      if (typeof s.id !== 'string' || !uuidRe.test(s.id)) {
        skippedInvalid++;
        continue;
      }
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
    const today = new Date();
    const isSameLocalDay = (ts: number) => {
      const d = new Date(ts);
      return (
        d.getFullYear() === today.getFullYear() &&
        d.getMonth() === today.getMonth() &&
        d.getDate() === today.getDate()
      );
    };

    const todaySessions = this.db.sessions.filter((s) => isSameLocalDay(s.endTime));
    const todaySavings = aggregateTokenSavings(todaySessions);
    const lifetimeSavings = aggregateTokenSavings(this.db.sessions);

    const ratios = this.db.sessions
      .map((s) => aggregateTokenSavings([s]).compressionRatio)
      .filter((r) => r > 1);
    const avgCompressionRatio = ratios.length
      ? Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 10) / 10
      : 1;

    return {
      totalSessions: this.db.sessions.length,
      workspaceSessions: ws.length,
      todaySessions: todaySessions.length,
      todayEstimatedTokensSaved: Math.round(todaySavings.tokensSaved),
      todayEstimatedRawTokens: Math.round(todaySavings.rawTokens),
      todayEstimatedCompactTokens: Math.round(todaySavings.compactTokens),
      lifetimeEstimatedTokensSaved: Math.round(lifetimeSavings.tokensSaved),
      lifetimeEstimatedRawTokens: Math.round(lifetimeSavings.rawTokens),
      lifetimeEstimatedCompactTokens: Math.round(lifetimeSavings.compactTokens),
      avgCompressionRatio,
      totalCompactTokens: Math.round(lifetimeSavings.compactTokens),
      oldestSession: this.db.sessions.length ? this.db.sessions[0].startTime : null,
      newestSession: this.db.sessions.length
        ? this.db.sessions[this.db.sessions.length - 1].endTime
        : null,
      totalRedactions: this.db.sessions.reduce((a, s) => a + (s.redactionCount ?? 0), 0),
    };
  }

  // ── Internals ──

  /** Keyword-frequency score over weighted fields. Public-ish for tests. */
  keywordScore(
    s: CompressedSession,
    terms: Set<string>,
    wsId: string | undefined,
    avgDocLen?: number,
  ): number {
    return sharedKeywordScore(s, terms, wsId, avgDocLen);
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
    // Memoise BM25 term stats alongside the inverted index. Recomputed here on
    // every field-affecting mutation (add, dup-merge, tag/untag, sanitize).
    this.termStats.set(s.id, computeTermStats(s));
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
    this.termStats.delete(s.id);
  }

  /** Lazily fetch (and cache) the memoised term stats for a session. */
  private statsFor(s: CompressedSession): SessionTermStats {
    let st = this.termStats.get(s.id);
    if (!st) {
      st = computeTermStats(s);
      this.termStats.set(s.id, st);
    }
    return st;
  }

  private rebuildIndex(): void {
    this.index.clear();
    this.termStats.clear();
    for (const s of this.db.sessions) this.indexSession(s);
  }

  /**
   * Chunked async index rebuild — avoids blocking the extension host UI thread
   * when restoring a large store (500+ sessions) from backup or globalState.
   */
  private rebuildIndexAsync(): Promise<void> {
    this.index.clear();
    this.termStats.clear();
    const sessions = [...this.db.sessions];
    const CHUNK = 50;
    let i = 0;
    // Yield using a macrotask (setTimeout 0) so the index rebuild doesn't
    // starve the extension host UI thread on large stores. We use setTimeout
    // rather than setImmediate because setImmediate is not available in the
    // VS Code web extension host (browser context).
    return new Promise<void>((resolve) => {
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
   * Public flush — for callers that have mutated session fields in place and
   * need those mutations persisted without triggering every other write-side
   * effect on the hot path.
   *
   * Added in v1.11.0 for the weekly janitor. Before v1.11.0 the janitor wrote
   * `session.qualityScore = q.score` in a loop and the comment honestly said
   * "persisted on next mutation or prune" — but if a session's score drifted
   * within the floor (still below, still flagged) no flag flip happened and
   * the assignment was lost on next reload. Every weekly pass therefore
   * re-scored from scratch. Now the janitor calls `flush()` once after the
   * loop and the rescored values survive.
   */
  async flush(): Promise<void> {
    await this.persist();
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
      try {
        await fs.chmod(dir, 0o700);
      } catch {
        /* ignore on Windows */
      }
      const finalPath = path.join(dir, 'sessions.json');
      const tmpPath = `${finalPath}.${process.pid}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(this.db), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmpPath, finalPath);
      // Ensure permissions if the file already existed with wrong mode.
      try {
        await fs.chmod(finalPath, 0o600);
      } catch {
        /* ignore on Windows */
      }
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
    const sanitized = parsed.sessions.map(
      (s): CompressedSession => ({
        ...s,
        summary: r(s.summary),
        decisions: (s.decisions ?? []).map(r),
        problemsSolved: (s.problemsSolved ?? []).map(r),
        keyTopics: (s.keyTopics ?? []).map(r),
      }),
    );
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
