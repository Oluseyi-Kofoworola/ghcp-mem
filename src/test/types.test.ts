import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeContentHash, globToRegex, isPathExcluded } from '../types';

test('computeContentHash — deterministic for same inputs', () => {
  const a = computeContentHash({
    summary: 'fix bug',
    keyFiles: ['a.ts', 'b.ts'],
    keyTopics: ['x'],
    decisions: [],
    problemsSolved: [],
  });
  const b = computeContentHash({
    summary: 'fix bug',
    keyFiles: ['a.ts', 'b.ts'],
    keyTopics: ['x'],
    decisions: [],
    problemsSolved: [],
  });
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test('computeContentHash — invariant to array order', () => {
  const a = computeContentHash({
    summary: 'same',
    keyFiles: ['a.ts', 'b.ts', 'c.ts'],
    keyTopics: ['x', 'y'],
    decisions: ['d1', 'd2'],
    problemsSolved: [],
  });
  const b = computeContentHash({
    summary: 'same',
    keyFiles: ['c.ts', 'b.ts', 'a.ts'],
    keyTopics: ['y', 'x'],
    decisions: ['d2', 'd1'],
    problemsSolved: [],
  });
  assert.equal(a, b);
});

test('computeContentHash — differs when summary changes', () => {
  const a = computeContentHash({ summary: 'v1', keyFiles: [], keyTopics: [], decisions: [], problemsSolved: [] });
  const b = computeContentHash({ summary: 'v2', keyFiles: [], keyTopics: [], decisions: [], problemsSolved: [] });
  assert.notEqual(a, b);
});

test('globToRegex — star matches within segment', () => {
  const re = globToRegex('src/*.ts');
  assert.match('src/foo.ts', re);
  assert.doesNotMatch('src/sub/foo.ts', re);
});

test('globToRegex — double-star matches across segments', () => {
  const re = globToRegex('**/*.env');
  assert.match('.env', re);
  assert.match('config/.env', re);
  assert.match('a/b/c/.env', re);
});

test('globToRegex — question mark matches single char', () => {
  const re = globToRegex('file?.ts');
  assert.match('file1.ts', re);
  assert.doesNotMatch('file12.ts', re);
});

test('isPathExcluded — respects exclude patterns', () => {
  const excludes = ['**/*.env', '**/secrets/**'];
  assert.equal(isPathExcluded('config/.env', excludes), true);
  assert.equal(isPathExcluded('src/secrets/token.ts', excludes), true);
  assert.equal(isPathExcluded('src/app.ts', excludes), false);
});
