import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAUSAL_WINDOW_MS,
  getCausalNeighbors,
  labelEdge,
  renderCausalNeighbors,
} from '../causalGraph';
import { CompressedSession, ObservationType } from '../types';

function makeSession(
  id: string,
  startTime: number,
  endTime: number,
  observationType: ObservationType,
  keyFiles: string[] = [],
): CompressedSession {
  return {
    id,
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime,
    endTime,
    summary: `session ${id}`,
    observationType,
    keyFiles,
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const T = 1_700_000_000_000;

test('getCausalNeighbors — returns undefined when center id is unknown', () => {
  const r = getCausalNeighbors('missing', []);
  assert.equal(r, undefined);
});

test('getCausalNeighbors — empty when center has no key files', () => {
  const center = makeSession('c', T, T + 100, 'feature', []);
  const r = getCausalNeighbors('c', [center]);
  assert.deepEqual(r, { centerId: 'c', predecessors: [], successors: [] });
});

test('getCausalNeighbors — finds predecessor that shares a key file in window', () => {
  const earlier = makeSession('p', T - 5 * DAY, T - 5 * DAY + 100, 'feature', ['src/auth.ts']);
  const center = makeSession('c', T, T + 100, 'bugfix', ['src/auth.ts']);
  const r = getCausalNeighbors('c', [earlier, center]);
  assert.equal(r!.predecessors.length, 1);
  assert.equal(r!.predecessors[0].sessionId, 'p');
  assert.equal(r!.predecessors[0].label, 'introduced_issue_fixed_by');
  assert.deepEqual(r!.predecessors[0].sharedFiles, ['src/auth.ts']);
  assert.equal(r!.successors.length, 0);
});

test('getCausalNeighbors — successor identification with extends label', () => {
  const center = makeSession('c', T, T + 100, 'feature', ['src/api.ts']);
  const later = makeSession('s', T + 3 * DAY, T + 3 * DAY + 100, 'refactor', ['src/api.ts']);
  const r = getCausalNeighbors('c', [center, later]);
  assert.equal(r!.successors.length, 1);
  assert.equal(r!.successors[0].sessionId, 's');
  assert.equal(r!.successors[0].label, 'extends');
});

test('getCausalNeighbors — sessions outside ±30 day window are excluded', () => {
  const tooOld = makeSession('old', T - 40 * DAY, T - 40 * DAY + 100, 'feature', ['src/a.ts']);
  const tooNew = makeSession('new', T + 40 * DAY, T + 40 * DAY + 100, 'bugfix', ['src/a.ts']);
  const center = makeSession('c', T, T + 100, 'refactor', ['src/a.ts']);
  const r = getCausalNeighbors('c', [tooOld, center, tooNew]);
  assert.equal(r!.predecessors.length, 0);
  assert.equal(r!.successors.length, 0);
  // sanity-check the constant is what we tested against.
  assert.equal(CAUSAL_WINDOW_MS, 30 * DAY);
});

test('getCausalNeighbors — retracted sessions are skipped', () => {
  const earlier = makeSession('p', T - DAY, T - DAY + 100, 'feature', ['src/x.ts']);
  earlier.retracted = true;
  const center = makeSession('c', T, T + 100, 'bugfix', ['src/x.ts']);
  const r = getCausalNeighbors('c', [earlier, center]);
  assert.equal(r!.predecessors.length, 0);
});

test('getCausalNeighbors — sessions without shared files are excluded', () => {
  const earlier = makeSession('p', T - DAY, T - DAY + 100, 'feature', ['src/other.ts']);
  const center = makeSession('c', T, T + 100, 'bugfix', ['src/auth.ts']);
  const r = getCausalNeighbors('c', [earlier, center]);
  assert.equal(r!.predecessors.length, 0);
});

test('labelEdge — semantic labels for known transitions', () => {
  const f = (t: ObservationType) => makeSession('x', 0, 0, t);
  assert.equal(labelEdge(f('feature'), f('bugfix')), 'introduced_issue_fixed_by');
  assert.equal(labelEdge(f('refactor'), f('bugfix')), 'introduced_issue_fixed_by');
  assert.equal(labelEdge(f('feature'), f('refactor')), 'extends');
  assert.equal(labelEdge(f('feature'), f('test')), 'tests');
  assert.equal(labelEdge(f('refactor'), f('test')), 'tests');
  assert.equal(labelEdge(f('chore'), f('chore')), 'continues_work_from');
});

test('getCausalNeighbors — limit caps each side independently', () => {
  const center = makeSession('c', T, T + 100, 'bugfix', ['src/x.ts']);
  const sessions: CompressedSession[] = [center];
  for (let i = 1; i <= 8; i++) {
    sessions.push(makeSession(`p${i}`, T - i * DAY, T - i * DAY + 50, 'feature', ['src/x.ts']));
  }
  const r = getCausalNeighbors('c', sessions, 3);
  assert.equal(r!.predecessors.length, 3);
  // Newest predecessor (smallest gap) listed first.
  assert.equal(r!.predecessors[0].sessionId, 'p1');
});

test('renderCausalNeighbors — empty neighbours renders a polite fallback', () => {
  const md = renderCausalNeighbors({ centerId: 'abcdef1234', predecessors: [], successors: [] });
  assert.ok(md.includes('No causal neighbours found'));
});
