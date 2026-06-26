/**
 * Weekly janitor: re-score every stored session against the current
 * quality heuristic and refresh its `qualityScore` / `lowQuality` flags.
 * Optionally prunes sessions that have been low-quality for longer than
 * `pruneAfterDays` AND were never accepted by the user.
 *
 * Pure helper module — the timer is wired up in extension.ts.
 */
import { ContextStore } from './contextStore';
import { scoreSessionQuality } from './quality';
import { deriveLessons } from './lessons';

export interface JanitorOptions {
  qualityFloor: number;
  pruneAfterDays: number;
  /** Minimum distinct sessions before a recurring decision becomes a lesson. Default 2. */
  lessonMinSupport?: number;
}

export interface JanitorReport {
  rescored: number;
  flagged: number;
  unflagged: number;
  pruned: number;
  lessonsCreated: number;
  lessonsReinforced: number;
}

export async function runJanitor(
  store: ContextStore,
  opts: JanitorOptions,
): Promise<JanitorReport> {
  const report: JanitorReport = {
    rescored: 0,
    flagged: 0,
    unflagged: 0,
    pruned: 0,
    lessonsCreated: 0,
    lessonsReinforced: 0,
  };
  const sessions = store.getAllSessions();
  const now = Date.now();
  const DAY = 86_400_000;
  const toPrune: string[] = [];

  // Track whether any qualityScore actually drifted — only the drifted-but-
  // flag-unchanged case is missed by setNoise/undoNoise, so we don't want
  // to write an unnecessary backup snapshot in the steady state.
  let anyScoreDrift = false;
  for (const s of sessions) {
    const q = scoreSessionQuality(s);
    const wasLow = !!s.lowQuality;
    const isLow = q.score < opts.qualityFloor;
    if (wasLow !== isLow) {
      if (isLow) {
        await store.setNoise(s.id);
        report.flagged++;
      } else {
        await store.undoNoise(s.id);
        report.unflagged++;
      }
    }
    // v1.11.0 perf fix (review item #11): persist qualityScore drift.
    // Before v1.11.0 the in-place assignment relied on "next mutation or
    // prune" to hit disk — but a session whose score moved from 0.42→0.41
    // (still below floor, still flagged) never triggered a flag flip, so
    // the assignment was lost on next reload and the next weekly pass
    // re-scored from scratch. We now bulk-flush once after the loop.
    if (s.qualityScore !== q.score) {
      s.qualityScore = q.score;
      anyScoreDrift = true;
    }
    report.rescored++;

    // Age the session from whichever happened later — original capture or the
    // user's most recent interaction with it. Using `endTime` alone meant a
    // session captured 90 days ago but retrieved/accepted yesterday would still
    // be eligible for pruning. That was a real footgun: pruneAfterDays=30 plus
    // a low-quality flag could delete sessions the user is actively using.
    const lastTouched = Math.max(s.endTime, s.usage?.lastInteractionAt ?? 0);
    if (
      opts.pruneAfterDays > 0 &&
      (s.lowQuality || isLow) &&
      (s.usage?.accepted ?? 0) === 0 &&
      now - lastTouched > opts.pruneAfterDays * DAY
    ) {
      toPrune.push(s.id);
    }
  }

  if (toPrune.length > 0) {
    report.pruned = await store.deleteSessions(toPrune);
  } else if (anyScoreDrift) {
    // No prune (which would have persisted anyway) and no flag flip; flush
    // the in-place qualityScore mutations explicitly. deleteSessions already
    // persists, so the else-if avoids a redundant disk write in the common
    // "things changed" case.
    await store.flush();
  }

  // Consolidation pass: distill recurring decisions/problems from the
  // (surviving) episodic sessions into durable semantic + procedural lessons,
  // reinforcing any previously-derived ones instead of duplicating.
  const surviving = store.getAllSessions();
  const { lessons, created, reinforced } = deriveLessons(surviving, store.getLessons(), {
    minSupport: opts.lessonMinSupport ?? 2,
  });
  if (created > 0 || reinforced > 0) {
    await store.setLessons(lessons);
  }
  report.lessonsCreated = created;
  report.lessonsReinforced = reinforced;

  return report;
}
