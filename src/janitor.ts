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

export interface JanitorOptions {
  qualityFloor: number;
  pruneAfterDays: number;
}

export interface JanitorReport {
  rescored: number;
  flagged: number;
  unflagged: number;
  pruned: number;
}

export async function runJanitor(
  store: ContextStore,
  opts: JanitorOptions,
): Promise<JanitorReport> {
  const report: JanitorReport = { rescored: 0, flagged: 0, unflagged: 0, pruned: 0 };
  const sessions = store.getAllSessions();
  const now = Date.now();
  const DAY = 86_400_000;
  const toPrune: string[] = [];

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
    // Store qualityScore in-place; persisted on next mutation or prune.
    s.qualityScore = q.score;
    report.rescored++;

    if (
      opts.pruneAfterDays > 0 &&
      (s.lowQuality || isLow) &&
      (s.usage?.accepted ?? 0) === 0 &&
      now - s.endTime > opts.pruneAfterDays * DAY
    ) {
      toPrune.push(s.id);
    }
  }

  if (toPrune.length > 0) {
    report.pruned = await store.deleteSessions(toPrune);
  }
  return report;
}
