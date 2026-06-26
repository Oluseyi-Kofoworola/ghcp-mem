import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntityRecord, sessionTouchesEntity, walkSupersedesChain } from '../entity';
import { CompressedSession } from '../types';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: overrides.startTime ?? 1_700_000_000_000,
    endTime: overrides.endTime ?? 1_700_000_100_000,
    summary: 'sess',
    observationType: 'feature',
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
    ...overrides,
  };
}

test('buildEntityRecord — returns undefined when no session touches the key', () => {
  const r = buildEntityRecord('src/missing.ts', []);
  assert.equal(r, undefined);
});

test('buildEntityRecord — rolls up decisions/problems/topics across sessions', () => {
  const s1 = makeSession({
    id: 's1',
    keyFiles: ['src/auth.ts'],
    keyTopics: ['auth', 'bcrypt'],
    decisions: ['picked bcrypt'],
    problemsSolved: ['timing attack'],
    startTime: 100,
    endTime: 200,
  });
  const s2 = makeSession({
    id: 's2',
    keyFiles: ['src/auth.ts'],
    keyTopics: ['auth', 'jwt'],
    decisions: ['use RS256'],
    startTime: 300,
    endTime: 400,
    observationType: 'refactor',
  });
  const r = buildEntityRecord('src/auth.ts', [s1, s2]);
  assert.ok(r);
  assert.equal(r!.sessionCount, 2);
  assert.equal(r!.firstSeenAt, 100);
  assert.equal(r!.lastTouchedAt, 400);
  assert.equal(r!.decisions.length, 2);
  assert.equal(r!.problems.length, 1);
  // Topics aggregated, ranked by frequency — auth appears twice.
  assert.equal(r!.topTopics[0], 'auth');
  assert.equal(r!.observationTypes.feature, 1);
  assert.equal(r!.observationTypes.refactor, 1);
  // Sessions sorted newest-first.
  assert.equal(r!.sessions[0].id, 's2');
});

test('buildEntityRecord — decisionLineage chain reflects supersession order', () => {
  const original = makeSession({
    id: 'orig',
    keyFiles: ['src/a.ts'],
    decisions: ['v1 choice'],
    endTime: 100,
    supersededBy: 'mid',
  });
  const mid = makeSession({
    id: 'mid',
    keyFiles: ['src/a.ts'],
    decisions: ['v2 choice'],
    endTime: 200,
    supersedes: 'orig',
    supersededBy: 'latest',
  });
  const latest = makeSession({
    id: 'latest',
    keyFiles: ['src/a.ts'],
    decisions: ['v3 choice'],
    endTime: 300,
    supersedes: 'mid',
  });
  const r = buildEntityRecord('src/a.ts', [original, mid, latest]);
  assert.ok(r);
  // Live decision-bearing session is `latest`; lineage oldest → newest.
  assert.deepEqual(r!.decisionLineage, ['orig', 'mid', 'latest']);
  assert.equal(r!.allSupersededOrRetracted, false);
});

test('buildEntityRecord — allSupersededOrRetracted flag fires when no live session remains', () => {
  const a = makeSession({
    id: 'a',
    keyFiles: ['src/x.ts'],
    decisions: ['d'],
    retracted: true,
  });
  const b = makeSession({
    id: 'b',
    keyFiles: ['src/x.ts'],
    decisions: ['d2'],
    supersededBy: 'somewhere',
  });
  const r = buildEntityRecord('src/x.ts', [a, b]);
  assert.equal(r!.allSupersededOrRetracted, true);
});

test('sessionTouchesEntity — file match is case-insensitive and basename-friendly', () => {
  const s = makeSession({ keyFiles: ['src/Auth.ts'] });
  assert.equal(sessionTouchesEntity(s, 'src/auth.ts', 'file'), true);
  assert.equal(sessionTouchesEntity(s, 'auth.ts', 'file'), true);
  assert.equal(sessionTouchesEntity(s, 'src/other.ts', 'file'), false);
});

test('sessionTouchesEntity — symbol match requires symbolId in evidence', () => {
  const s = makeSession({
    keyFiles: ['src/auth.ts'],
    decisions: ['d'],
    decisionEvidence: [[{ kind: 'file_edit', symbolId: 'src/auth.ts#hashPassword' }]],
  });
  assert.equal(sessionTouchesEntity(s, 'src/auth.ts#hashPassword', 'symbol'), true);
  assert.equal(sessionTouchesEntity(s, 'src/auth.ts#missing', 'symbol'), false);
});

test('buildEntityRecord — infers kind=symbol when key has # marker', () => {
  const s = makeSession({
    keyFiles: ['src/auth.ts'],
    decisions: ['picked bcrypt cost 12'],
    decisionEvidence: [[{ kind: 'file_edit', symbolId: 'src/auth.ts#hashPassword' }]],
  });
  const r = buildEntityRecord('src/auth.ts#hashPassword', [s]);
  assert.ok(r);
  assert.equal(r!.kind, 'symbol');
});

test('walkSupersedesChain — defensive against cycles', () => {
  const a = makeSession({ id: 'a', supersedes: 'b' });
  const b = makeSession({ id: 'b', supersedes: 'a' });
  const map = new Map([
    ['a', a],
    ['b', b],
  ]);
  const chain = walkSupersedesChain('a', map);
  // Cycle should terminate without infinite loop; chain has both items at most.
  assert.ok(chain.length <= 2);
});
