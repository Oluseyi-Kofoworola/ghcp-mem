/**
 * Heuristic session quality gate. Pure module, no vscode/lm.
 *
 * The capture pipeline can produce thin or noisy sessions (e.g. a single
 * file_open with no real progress). Persisting and re-injecting those
 * degrades future suggestions. We score each session on cheap, local
 * signals and let callers drop or down-weight low-quality memories
 * before they hit the store or the startup context.
 */
import { CompressedSession } from './types';

export interface QualityResult {
  score: number;
  reasons: string[];
}

interface Signal {
  label: string;
  weight: number;
  test: (s: CompressedSession) => boolean;
}

const SIGNALS: Signal[] = [
  {
    label: 'summary>=60chars',
    weight: 0.15,
    test: (s) => (s.summary?.trim().length ?? 0) >= 60,
  },
  {
    label: 'hasGroundedDecision',
    weight: 0.25,
    test: (s) =>
      (s.decisions?.length ?? 0) > 0 &&
      Array.isArray(s.decisionEvidence) &&
      s.decisionEvidence.some((ev) => Array.isArray(ev) && ev.length > 0),
  },
  {
    label: 'hasProblemOrKeyFile',
    weight: 0.15,
    test: (s) => (s.problemsSolved?.length ?? 0) > 0 || (s.keyFiles?.length ?? 0) > 0,
  },
  {
    label: 'rawEvents>=3',
    weight: 0.1,
    test: (s) => (s.rawEventCount ?? 0) >= 3,
  },
  {
    label: 'observationTypeKnown',
    weight: 0.1,
    test: (s) => s.observationType !== 'unknown',
  },
  {
    label: 'lmCompressed',
    weight: 0.1,
    test: (s) => s.compressorMode === 'lm',
  },
  {
    label: 'keyTopics>=1',
    weight: 0.1,
    test: (s) => (s.keyTopics?.length ?? 0) >= 1,
  },
  {
    label: 'notTruncated',
    weight: 0.05,
    test: (s) => !s.eventLogTruncated,
  },
];

export function scoreSessionQuality(session: CompressedSession): QualityResult {
  let score = 0;
  const reasons: string[] = [];
  for (const sig of SIGNALS) {
    if (sig.test(session)) {
      score += sig.weight;
      reasons.push(`+${sig.weight} ${sig.label}`);
    }
  }
  return { score: Math.min(1, Math.max(0, score)), reasons };
}
