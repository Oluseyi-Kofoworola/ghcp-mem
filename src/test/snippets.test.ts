import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avgSnippetLen, snippetScore, snippetsFromSession, tokenizeSnippet } from '../snippets';
import { CompressedSession } from '../types';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: overrides.id ?? 'sess-1',
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: 100,
    endTime: 200,
    summary: '',
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

test('snippetsFromSession — decomposes summary + decisions + problems + topics into typed snippets', () => {
  const s = makeSession({
    summary: 'Refactored auth layer with bcrypt',
    decisions: ['use bcrypt cost 12', 'remove md5 fallback'],
    problemsSolved: ['timing side channel'],
    keyTopics: ['auth', 'bcrypt'],
    decisionEvidence: [
      [{ kind: 'file_edit', filePath: 'src/auth.ts' }],
      [{ kind: 'file_edit', filePath: 'src/auth.ts' }],
    ],
    problemEvidence: [[{ kind: 'file_edit', filePath: 'src/auth.ts' }]],
  });
  const snips = snippetsFromSession(s);
  const byKind = (k: string) => snips.filter((sn) => sn.kind === k);
  assert.equal(byKind('summary').length, 1);
  assert.equal(byKind('decision').length, 2);
  assert.equal(byKind('problem').length, 1);
  assert.equal(byKind('topic').length, 2);
  // Composite IDs follow the documented pattern.
  assert.equal(byKind('decision')[0].id, 'sess-1#decision:0');
  // Evidence flows through onto decision/problem snippets.
  assert.ok(byKind('decision')[0].evidence);
  assert.ok(byKind('problem')[0].evidence);
});

test('snippetsFromSession — empty session yields empty array', () => {
  const s = makeSession();
  assert.deepEqual(snippetsFromSession(s), []);
});

test('snippetsFromSession — blank/whitespace strings are skipped', () => {
  const s = makeSession({
    summary: '   ',
    decisions: ['', '  ', 'real decision'],
    keyTopics: ['', 'auth'],
  });
  const snips = snippetsFromSession(s);
  assert.equal(snips.filter((x) => x.kind === 'summary').length, 0);
  assert.equal(snips.filter((x) => x.kind === 'decision').length, 1);
  assert.equal(snips.filter((x) => x.kind === 'topic').length, 1);
});

test('snippetsFromSession — retracted/superseded state propagates onto snippets', () => {
  const s = makeSession({
    summary: 'thing',
    decisions: ['d'],
    retracted: true,
    supersededBy: 'newer',
  });
  const snips = snippetsFromSession(s);
  assert.ok(snips.length > 0);
  for (const sn of snips) {
    assert.equal(sn.retracted, true);
    assert.equal(sn.supersededBy, 'newer');
  }
});

test('tokenizeSnippet — filters tokens shorter than 3 chars and normalises case', () => {
  const tokens = tokenizeSnippet('Use bcrypt to hash a password!!');
  assert.ok(tokens.has('bcrypt'));
  assert.ok(tokens.has('password'));
  assert.ok(!tokens.has('to'));
  assert.ok(!tokens.has('a'));
});

test('snippetScore — query term in decision text scores higher than no match', () => {
  const s = makeSession({ summary: 'auth', decisions: ['picked bcrypt cost 12'] });
  const snips = snippetsFromSession(s);
  const decisionSnip = snips.find((x) => x.kind === 'decision')!;
  const hit = snippetScore(decisionSnip, new Set(['bcrypt']));
  const miss = snippetScore(decisionSnip, new Set(['typescript']));
  assert.ok(hit > 0);
  assert.equal(miss, 0);
});

test('snippetScore — empty query returns 0', () => {
  const s = makeSession({ decisions: ['bcrypt'] });
  const snip = snippetsFromSession(s)[0];
  assert.equal(snippetScore(snip, new Set()), 0);
});

test('avgSnippetLen — sane default for empty array', () => {
  assert.equal(avgSnippetLen([]), 20);
});
