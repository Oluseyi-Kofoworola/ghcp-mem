/**
 * Derived "lessons" — the semantic + procedural memory layer.
 *
 * GHCP-MEM's session rows are *episodic* memory: "on this date, I did X to
 * file Y." That is exactly what the CoALA / LangChain memory taxonomy calls
 * episodic memory. The frontier direction (Mem0's extract→consolidate→retrieve
 * loop, Anthropic's file-backed memory tool, LangChain's continual learning)
 * is to distill those episodes into *durable* knowledge:
 *
 *   - semantic lessons   — facts about the project ("this repo uses bcrypt
 *                          cost 12", "the store has no native deps").
 *   - procedural lessons — how-to sequences ("to release: bump → changelog →
 *                          tag → push").
 *
 * This module is the pure consolidation step. It takes the raw episodic
 * sessions plus the previously-derived lessons and returns a merged set:
 * recurring decisions/problems get promoted to lessons; repeated observations
 * reinforce an existing lesson (bumping its support + confidence) instead of
 * creating a duplicate. No LM, no I/O — deterministic and unit-testable.
 *
 * Design constraints (mirrors the rest of the codebase):
 *   - Pure module: persistence is the ContextStore's problem.
 *   - Deterministic IDs: a lesson's id is a stable hash of its normalised
 *     text + kind, so re-deriving over a growing store reinforces rather than
 *     duplicates.
 *   - Bounded: at most `maxLessons` are retained; the lowest-value ones are
 *     dropped first (pinned lessons are never auto-dropped).
 */
import { createHash } from 'crypto';
import { CompressedSession } from './types';

export type LessonKind = 'semantic' | 'procedural';

export interface Lesson {
  id: string;
  kind: LessonKind;
  /** The lesson text — the longest/most complete observed phrasing. */
  text: string;
  /** repoScope shared by all supporting sessions, when uniform; else undefined (cross-repo). */
  scope?: string;
  /** Human-readable label for `scope`. */
  scopeLabel?: string;
  /** Topic/tag keywords aggregated from the supporting sessions. */
  tags: string[];
  /** Distinct session IDs that support this lesson (its evidence). */
  sources: string[];
  /** Number of distinct sessions that asserted this lesson. */
  supportCount: number;
  /** Confidence in [0,1] derived from support breadth + source trust. */
  confidence: number;
  createdAt: number;
  updatedAt: number;
  /**
   * `true` when the lesson was authored directly (hot-path "remember this"
   * write) rather than derived from episodic sessions. Pinned lessons are
   * never auto-pruned and always survive consolidation.
   */
  pinned?: boolean;
}

export interface DeriveOptions {
  /** Minimum distinct supporting sessions before a candidate becomes a lesson. Default 2. */
  minSupport?: number;
  /** Hard cap on retained lessons. Default 200. */
  maxLessons?: number;
  /** Clock injection for deterministic tests. Default Date.now(). */
  now?: number;
}

export interface DeriveResult {
  /** The merged, capped lesson set (sorted strongest-first). */
  lessons: Lesson[];
  /** How many brand-new lessons were promoted this round. */
  created: number;
  /** How many existing lessons were reinforced (support bumped). */
  reinforced: number;
}

/** Cues that mark a statement as a how-to (procedural) rather than a fact. */
const PROCEDURAL_CUE =
  /\b(first|then|next|finally|step|steps|run|install|execute|bump|tag|push|deploy|rebuild|always|never|before|after|in order to|make sure|don'?t forget|use\s+\S+\s+to)\b/i;
const NUMBERED_SEQUENCE = /(^|\s)\d+[.)]\s|->|→|\bthen\b/i;

/**
 * Normalise a statement into a dedup key: lowercase, collapse whitespace,
 * drop surrounding quotes/markdown, strip trailing punctuation. Two phrasings
 * that differ only in case/punctuation/whitespace collapse to one lesson.
 */
export function normalizeLessonKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^["'\s]+|["'.\s]+$/g, '')
    .trim()
    .slice(0, 240);
}

/** Classify a statement as procedural (how-to) or semantic (fact). */
export function classifyLesson(text: string): LessonKind {
  return PROCEDURAL_CUE.test(text) || NUMBERED_SEQUENCE.test(text) ? 'procedural' : 'semantic';
}

/** Stable, deterministic lesson id from its kind + normalised key. */
export function lessonId(kind: LessonKind, normalizedKey: string): string {
  return createHash('sha256').update(`${kind}\n${normalizedKey}`).digest('hex').slice(0, 12);
}

interface Candidate {
  key: string;
  kind: LessonKind;
  bestText: string;
  sources: Set<string>;
  tags: Set<string>;
  scopes: Set<string>;
  scopeLabels: Map<string, string>;
  confidenceSum: number;
  firstSeen: number;
  lastSeen: number;
}

/** A statement worth distilling, with the session that produced it. */
function* statementsOf(s: CompressedSession): Generator<string> {
  for (const d of s.decisions ?? []) if (d && d.trim().length >= 8) yield d.trim();
  for (const p of s.problemsSolved ?? []) if (p && p.trim().length >= 8) yield p.trim();
}

/**
 * Consolidate episodic sessions into durable lessons, merging with the
 * lessons derived on previous rounds.
 */
export function deriveLessons(
  sessions: readonly CompressedSession[],
  existing: readonly Lesson[] = [],
  opts: DeriveOptions = {},
): DeriveResult {
  const minSupport = Math.max(1, opts.minSupport ?? 2);
  const maxLessons = Math.max(1, opts.maxLessons ?? 200);
  const now = opts.now ?? Date.now();

  // 1. Tally candidates across every session's decisions + problems.
  const candidates = new Map<string, Candidate>();
  for (const s of sessions) {
    if (s.retracted) continue; // retracted episodes don't teach anything.
    const trust = typeof s.confidence === 'number' ? s.confidence : 0.5;
    for (const stmt of statementsOf(s)) {
      const key = normalizeLessonKey(stmt);
      if (key.length < 6) continue;
      const kind = classifyLesson(stmt);
      const ck = `${kind}\n${key}`;
      let c = candidates.get(ck);
      if (!c) {
        c = {
          key,
          kind,
          bestText: stmt,
          sources: new Set(),
          tags: new Set(),
          scopes: new Set(),
          scopeLabels: new Map(),
          confidenceSum: 0,
          firstSeen: s.startTime,
          lastSeen: s.endTime,
        };
        candidates.set(ck, c);
      }
      // Prefer the longest phrasing as the canonical lesson text.
      if (stmt.length > c.bestText.length) c.bestText = stmt;
      if (!c.sources.has(s.id)) c.confidenceSum += trust;
      c.sources.add(s.id);
      for (const t of s.keyTopics ?? []) if (t) c.tags.add(t);
      for (const t of s.userTags ?? []) if (t && !t.startsWith('pack:')) c.tags.add(t);
      if (s.repoScope) {
        c.scopes.add(s.repoScope);
        if (s.repoScopeLabel) c.scopeLabels.set(s.repoScope, s.repoScopeLabel);
      }
      c.firstSeen = Math.min(c.firstSeen, s.startTime);
      c.lastSeen = Math.max(c.lastSeen, s.endTime);
    }
  }

  // 2. Index existing lessons by id so we can reinforce instead of duplicate.
  const byId = new Map<string, Lesson>();
  for (const l of existing) byId.set(l.id, { ...l, sources: [...l.sources], tags: [...l.tags] });

  let created = 0;
  let reinforced = 0;

  for (const c of candidates.values()) {
    const id = lessonId(c.kind, c.key);
    const support = c.sources.size;
    const existingLesson = byId.get(id);

    // A candidate qualifies if it recurs (>= minSupport) or already exists.
    if (!existingLesson && support < minSupport) continue;

    const avgTrust = c.confidenceSum / Math.max(1, support);
    // Confidence: breadth of support (saturating at 3) blended with source trust.
    const confidence = Math.min(1, (Math.min(support, 3) / 3) * 0.6 + avgTrust * 0.4);
    const scope = c.scopes.size === 1 ? [...c.scopes][0] : undefined;
    const scopeLabel = scope ? c.scopeLabels.get(scope) : undefined;

    if (existingLesson) {
      const mergedSources = new Set([...existingLesson.sources, ...c.sources]);
      const mergedTags = new Set([...existingLesson.tags, ...c.tags]);
      existingLesson.sources = [...mergedSources];
      existingLesson.supportCount = mergedSources.size;
      existingLesson.tags = [...mergedTags].slice(0, 12);
      existingLesson.text =
        c.bestText.length > existingLesson.text.length ? c.bestText : existingLesson.text;
      existingLesson.confidence = Math.max(
        existingLesson.confidence,
        Math.min(1, (Math.min(mergedSources.size, 3) / 3) * 0.6 + avgTrust * 0.4),
      );
      existingLesson.scope = scope ?? existingLesson.scope;
      existingLesson.scopeLabel = scopeLabel ?? existingLesson.scopeLabel;
      existingLesson.updatedAt = now;
      reinforced++;
    } else {
      byId.set(id, {
        id,
        kind: c.kind,
        text: c.bestText.slice(0, 280),
        scope,
        scopeLabel,
        tags: [...c.tags].slice(0, 12),
        sources: [...c.sources],
        supportCount: support,
        confidence,
        createdAt: now,
        updatedAt: now,
      });
      created++;
    }
  }

  // 3. Sort strongest-first and cap. Pinned lessons are immune to the cap.
  const all = [...byId.values()];
  const ranked = rankLessons(all);
  const pinned = ranked.filter((l) => l.pinned);
  const derived = ranked.filter((l) => !l.pinned).slice(0, Math.max(0, maxLessons - pinned.length));
  const lessons = rankLessons([...pinned, ...derived]);

  return { lessons, created, reinforced };
}

/** Rank lessons by a blend of confidence, support breadth, and recency. */
export function rankLessons(lessons: readonly Lesson[]): Lesson[] {
  const now = Date.now();
  const HALF_LIFE = 60 * 24 * 60 * 60 * 1000; // 60-day half life — lessons age slowly.
  return [...lessons].sort((a, b) => {
    const score = (l: Lesson) => {
      const recency = Math.pow(2, -(now - l.updatedAt) / HALF_LIFE);
      const pin = l.pinned ? 1 : 0;
      return pin * 100 + l.confidence + Math.min(l.supportCount, 5) * 0.15 + recency * 0.3;
    };
    return score(b) - score(a);
  });
}

/**
 * Render the strongest lessons as a compact markdown block for startup
 * injection. Progressive-disclosure friendly: short, high-signal, the
 * durable knowledge the agent should see before any session cards.
 */
export function renderLessonsForInjection(lessons: readonly Lesson[], limit = 8): string {
  const top = rankLessons(lessons).slice(0, Math.max(0, limit));
  if (top.length === 0) return '';
  const lines: string[] = ['### Durable lessons (consolidated from past sessions)', ''];
  const semantic = top.filter((l) => l.kind === 'semantic');
  const procedural = top.filter((l) => l.kind === 'procedural');
  if (semantic.length) {
    lines.push('**Facts:**');
    for (const l of semantic) lines.push(`- ${l.text}${supportSuffix(l)}`);
    lines.push('');
  }
  if (procedural.length) {
    lines.push('**How-to:**');
    for (const l of procedural) lines.push(`- ${l.text}${supportSuffix(l)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function supportSuffix(l: Lesson): string {
  if (l.pinned) return ' _(pinned)_';
  if (l.supportCount >= 2) return ` _(seen ×${l.supportCount})_`;
  return '';
}

/** Build a freshly-authored (pinned) lesson — used by the hot-path write tool. */
export function makePinnedLesson(
  text: string,
  kind?: LessonKind,
  tags: string[] = [],
  now = Date.now(),
): Lesson {
  const clean = text.trim().slice(0, 280);
  const k = kind ?? classifyLesson(clean);
  return {
    id: lessonId(k, normalizeLessonKey(clean)),
    kind: k,
    text: clean,
    tags: tags.filter(Boolean).slice(0, 12),
    sources: [],
    supportCount: 0,
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
    pinned: true,
  };
}
