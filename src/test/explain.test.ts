import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainScore, renderExplanation } from '../explain';
import { CompressedSession } from '../types';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: 'sess-abc12345',
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    summary: 'authentication module refactor with bcrypt',
    observationType: 'refactor',
    keyFiles: ['src/auth.ts'],
    keyTopics: ['auth', 'bcrypt'],
    decisions: ['picked bcrypt cost 12'],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
    confidence: 0.8,
    ...overrides,
  };
}

const EXPECTED_LABELS = [
  'keyword',
  'recency',
  'workspace',
  'match-ratio',
  'confidence',
  'decision-boost',
  'problem-boost',
  'reinforcement',
  'feedback',
  'superseded',
];

test('explainScore — produces breakdown with every expected component label', () => {
  const session = makeSession();
  const result = explainScore(session, 'why did we pick bcrypt', { allSessions: [session] });
  const labels = result.contributions.map((c) => c.label);
  for (const expected of EXPECTED_LABELS) {
    assert.ok(labels.includes(expected), `missing component label ${expected}`);
  }
  // Total equals sum of components (within float noise).
  const summed = result.contributions.reduce((acc, c) => acc + c.value, 0);
  assert.ok(Math.abs(summed - result.total) < 1e-9);
});

test('explainScore — decision intent boost fires only when session has decisions', () => {
  const withDecisions = makeSession({ id: 'with', decisions: ['choose A over B'] });
  const without = makeSession({ id: 'without', decisions: [] });
  const allSessions = [withDecisions, without];
  const r1 = explainScore(withDecisions, 'what did we decide about auth', { allSessions });
  const r2 = explainScore(without, 'what did we decide about auth', { allSessions });
  const db1 = r1.contributions.find((c) => c.label === 'decision-boost')!;
  const db2 = r2.contributions.find((c) => c.label === 'decision-boost')!;
  assert.equal(r1.intent, 'decision');
  assert.ok(db1.value > 0, `expected positive decision-boost, got ${db1.value}`);
  assert.equal(db2.value, 0);
});

test('explainScore — supersession applies a negative penalty', () => {
  const session = makeSession({ supersededBy: 'newer-session-id' });
  const result = explainScore(session, 'bcrypt', { allSessions: [session] });
  const sp = result.contributions.find((c) => c.label === 'superseded')!;
  assert.ok(sp.value < 0);
  assert.equal(sp.value, -0.3);
});

test('explainScore — workspace boost is +0.15 when active workspace matches', () => {
  const session = makeSession({ workspaceId: 'active' });
  const result = explainScore(session, 'bcrypt', {
    allSessions: [session],
    activeWorkspaceId: 'active',
  });
  const ws = result.contributions.find((c) => c.label === 'workspace')!;
  assert.equal(ws.value, 0.15);
});

test('renderExplanation — markdown header and signal row format', () => {
  const session = makeSession();
  const r = explainScore(session, 'bcrypt password hashing', { allSessions: [session] });
  const md = renderExplanation(r);
  assert.ok(md.includes('## 🔎 Why did'));
  assert.ok(md.includes('**Query:**'));
  assert.ok(md.includes('| Signal | Contribution | Detail |'));
});
