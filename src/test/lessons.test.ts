import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveLessons,
  classifyLesson,
  normalizeLessonKey,
  lessonId,
  rankLessons,
  renderLessonsForInjection,
  makePinnedLesson,
  Lesson,
} from '../lessons';
import { CompressedSession } from '../types';

let seq = 0;
function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const now = Date.now();
  return {
    id: overrides.id ?? `s${seq++}`,
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: overrides.startTime ?? now,
    endTime: overrides.endTime ?? now,
    summary: overrides.summary ?? 'a session',
    observationType: overrides.observationType ?? 'feature',
    keyFiles: overrides.keyFiles ?? [],
    keyTopics: overrides.keyTopics ?? [],
    decisions: overrides.decisions ?? [],
    problemsSolved: overrides.problemsSolved ?? [],
    rawEventCount: overrides.rawEventCount ?? 5,
    userTags: overrides.userTags ?? [],
    redactionCount: 0,
    confidence: overrides.confidence,
    repoScope: overrides.repoScope,
    repoScopeLabel: overrides.repoScopeLabel,
    retracted: overrides.retracted,
  };
}

test('classifyLesson — procedural cues vs facts', () => {
  assert.equal(classifyLesson('To release: bump the version then push the tag'), 'procedural');
  assert.equal(classifyLesson('Always run the janitor after lowering the floor'), 'procedural');
  assert.equal(classifyLesson('The store uses bcrypt cost 12 for password hashing'), 'semantic');
});

test('normalizeLessonKey — collapses case, whitespace, punctuation', () => {
  const a = normalizeLessonKey('  Use **bcrypt** cost 12.  ');
  const b = normalizeLessonKey('use bcrypt cost 12');
  assert.equal(a, b);
});

test('lessonId — stable + kind-sensitive', () => {
  const k = normalizeLessonKey('use bcrypt cost 12');
  assert.equal(lessonId('semantic', k), lessonId('semantic', k));
  assert.notEqual(lessonId('semantic', k), lessonId('procedural', k));
});

test('deriveLessons — a single occurrence does not become a lesson', () => {
  const sessions = [makeSession({ decisions: ['use bcrypt cost 12 for hashing'] })];
  const { lessons, created } = deriveLessons(sessions, [], { minSupport: 2 });
  assert.equal(created, 0);
  assert.equal(lessons.length, 0);
});

test('deriveLessons — a decision repeated across sessions is promoted', () => {
  const sessions = [
    makeSession({ decisions: ['Use bcrypt cost 12 for hashing'], keyTopics: ['auth'] }),
    makeSession({ decisions: ['use bcrypt cost 12 for hashing.'], keyTopics: ['security'] }),
  ];
  const { lessons, created } = deriveLessons(sessions, [], { minSupport: 2 });
  assert.equal(created, 1);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].kind, 'semantic');
  assert.equal(lessons[0].supportCount, 2);
  assert.deepEqual(new Set(lessons[0].tags), new Set(['auth', 'security']));
});

test('deriveLessons — re-running reinforces, does not duplicate', () => {
  const first = [
    makeSession({ id: 'a', decisions: ['Always redact before persisting'] }),
    makeSession({ id: 'b', decisions: ['always redact before persisting'] }),
  ];
  const round1 = deriveLessons(first, [], { minSupport: 2 });
  assert.equal(round1.created, 1);

  const second = [
    ...first,
    makeSession({ id: 'c', decisions: ['always redact before persisting'] }),
  ];
  const round2 = deriveLessons(second, round1.lessons, { minSupport: 2 });
  assert.equal(round2.created, 0);
  assert.equal(round2.reinforced, 1);
  assert.equal(round2.lessons.length, 1);
  assert.equal(round2.lessons[0].supportCount, 3);
});

test('deriveLessons — retracted sessions teach nothing', () => {
  const sessions = [
    makeSession({ id: 'a', decisions: ['use redis for the cache'] }),
    makeSession({ id: 'b', decisions: ['use redis for the cache'], retracted: true }),
  ];
  const { created } = deriveLessons(sessions, [], { minSupport: 2 });
  assert.equal(created, 0);
});

test('deriveLessons — uniform repoScope is carried onto the lesson', () => {
  const sessions = [
    makeSession({
      id: 'a',
      decisions: ['ship via azd up'],
      repoScope: 'repo1',
      repoScopeLabel: 'org/repo1',
    }),
    makeSession({
      id: 'b',
      decisions: ['ship via azd up'],
      repoScope: 'repo1',
      repoScopeLabel: 'org/repo1',
    }),
  ];
  const { lessons } = deriveLessons(sessions, [], { minSupport: 2 });
  assert.equal(lessons[0].scope, 'repo1');
  assert.equal(lessons[0].scopeLabel, 'org/repo1');
});

test('deriveLessons — mixed repoScope leaves the lesson cross-repo', () => {
  const sessions = [
    makeSession({ id: 'a', decisions: ['prefer composition over inheritance'], repoScope: 'r1' }),
    makeSession({ id: 'b', decisions: ['prefer composition over inheritance'], repoScope: 'r2' }),
  ];
  const { lessons } = deriveLessons(sessions, [], { minSupport: 2 });
  assert.equal(lessons[0].scope, undefined);
});

test('deriveLessons — maxLessons cap keeps the strongest, never drops pinned', () => {
  const pinned = makePinnedLesson('Never commit secrets', 'procedural', ['security']);
  const sessions: CompressedSession[] = [];
  for (let i = 0; i < 5; i++) {
    sessions.push(makeSession({ id: `x${i}a`, decisions: [`fact number ${i} about the system`] }));
    sessions.push(makeSession({ id: `x${i}b`, decisions: [`fact number ${i} about the system`] }));
  }
  const { lessons } = deriveLessons(sessions, [pinned], { minSupport: 2, maxLessons: 3 });
  assert.equal(lessons.length, 3);
  assert.ok(lessons.some((l) => l.pinned && l.text === 'Never commit secrets'));
});

test('rankLessons — pinned lessons rank first', () => {
  const a: Lesson = makePinnedLesson('pinned thing', 'semantic');
  const b: Lesson = {
    id: 'z',
    kind: 'semantic',
    text: 'derived thing',
    tags: [],
    sources: ['s1', 's2', 's3'],
    supportCount: 3,
    confidence: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const ranked = rankLessons([b, a]);
  assert.equal(ranked[0].id, a.id);
});

test('renderLessonsForInjection — groups facts and how-tos', () => {
  const lessons: Lesson[] = [
    makePinnedLesson('The API base path is /v2', 'semantic'),
    makePinnedLesson('To deploy: run azd up then verify health', 'procedural'),
  ];
  const md = renderLessonsForInjection(lessons, 8);
  assert.match(md, /Durable lessons/);
  assert.match(md, /\*\*Facts:\*\*/);
  assert.match(md, /\*\*How-to:\*\*/);
});

test('renderLessonsForInjection — empty set renders nothing', () => {
  assert.equal(renderLessonsForInjection([], 8), '');
});

test('makePinnedLesson — derives kind when not given and is pinned', () => {
  const l = makePinnedLesson('Always run lint before pushing');
  assert.equal(l.kind, 'procedural');
  assert.equal(l.pinned, true);
  assert.equal(l.confidence, 0.9);
});
