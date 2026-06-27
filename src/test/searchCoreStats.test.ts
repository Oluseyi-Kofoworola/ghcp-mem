import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTermStats,
  keywordScore,
  keywordScoreFromStats,
  computeAvgDocLen,
  extractTerms,
  ScorableSession,
} from '../searchCore';

function mk(partial: Partial<ScorableSession>): ScorableSession {
  return {
    workspaceId: 'ws1',
    summary: '',
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
    userTags: [],
    observationType: 'general',
    ...partial,
  };
}

const corpus: ScorableSession[] = [
  mk({
    summary: 'refactor the authentication module to use JWT tokens',
    keyTopics: ['auth', 'jwt'],
    keyFiles: ['src/auth.ts'],
    decisions: ['use bcrypt for hashing'],
  }),
  mk({
    summary: 'fix database connection pool timeout under load',
    keyTopics: ['database', 'performance'],
    problemsSolved: ['pool exhaustion'],
  }),
  mk({ summary: 'update marketing landing page copy', keyTopics: ['marketing'] }),
];

test('keywordScoreFromStats matches keywordScore exactly across a corpus', () => {
  const queries = [
    'authentication jwt',
    'database pool timeout',
    'marketing copy',
    'bcrypt hashing',
  ];
  const avgDocLen = computeAvgDocLen(corpus);
  for (const q of queries) {
    const terms = extractTerms(q);
    for (const s of corpus) {
      const direct = keywordScore(s, terms, 'ws1', avgDocLen);
      const cached = keywordScoreFromStats(
        computeTermStats(s),
        terms,
        s.workspaceId === 'ws1',
        avgDocLen,
      );
      assert.equal(cached, direct, `mismatch for query "${q}"`);
    }
  }
});

test('computeTermStats docLenWeighted feeds an identical avgDocLen', () => {
  const fromStats =
    corpus.reduce((sum, s) => sum + computeTermStats(s).docLenWeighted, 0) / corpus.length;
  assert.equal(fromStats, computeAvgDocLen(corpus));
});

test('keywordScoreFromStats applies the workspace boost only on match', () => {
  const s = corpus[0];
  const terms = extractTerms('authentication');
  const withBoost = keywordScoreFromStats(computeTermStats(s), terms, true, 50);
  const without = keywordScoreFromStats(computeTermStats(s), terms, false, 50);
  assert.ok(withBoost > without);
  assert.ok(Math.abs(withBoost - without - 2) < 1e-9); // WORKSPACE_BOOST
});
