import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { exportSessionMarkdown, exportSessionsMarkdown } from '../markdownExport';
import { CompressedSession } from '../types';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    workspaceName: 'demo',
    startTime: Date.UTC(2026, 0, 1, 12, 0, 0),
    endTime: Date.UTC(2026, 0, 1, 12, 30, 0),
    summary: 'Worked on tests.',
    observationType: 'feature',
    keyFiles: ['src/b.ts', 'src/a.ts'],
    keyTopics: ['testing', 'ci'],
    decisions: ['Use node:test'],
    problemsSolved: ['Mock vscode module'],
    rawEventCount: 5,
    userTags: ['demo'],
    redactionCount: 0,
    ...overrides,
  };
}

test('exportSessionMarkdown: deterministic output', () => {
  const s = makeSession();
  const a = exportSessionMarkdown(s);
  const b = exportSessionMarkdown(s);
  assert.equal(a, b);
});

test('exportSessionMarkdown: keyFiles sorted', () => {
  const s = makeSession({ keyFiles: ['z.ts', 'a.ts', 'm.ts'] });
  const out = exportSessionMarkdown(s);
  const idxA = out.indexOf('- a.ts');
  const idxM = out.indexOf('- m.ts');
  const idxZ = out.indexOf('- z.ts');
  assert.ok(idxA < idxM && idxM < idxZ, 'files should be sorted alphabetically');
});

test('exportSessionMarkdown: emits ISO timestamps', () => {
  const out = exportSessionMarkdown(makeSession());
  assert.match(out, /- start: 2026-01-01T12:00:00\.000Z/);
  assert.match(out, /- end: 2026-01-01T12:30:00\.000Z/);
});

test('exportSessionMarkdown: includes repoScope label when present', () => {
  const out = exportSessionMarkdown(makeSession({
    repoScope: 'abcd1234',
    repoScopeLabel: 'github.com/foo/bar',
  }));
  assert.match(out, /- repo: github\.com\/foo\/bar/);
  assert.match(out, /- repoScope: abcd1234/);
});

test('exportSessionsMarkdown: sorts by startTime ascending', () => {
  const newer = makeSession({ id: 'newer', startTime: Date.UTC(2026, 5, 1) });
  const older = makeSession({ id: 'older', startTime: Date.UTC(2026, 0, 1) });
  const out = exportSessionsMarkdown([newer, older]);
  assert.ok(out.indexOf('Session older') < out.indexOf('Session newer'));
});

// Pin the exact byte-level output of a fixed session. This is the regression
// guard for the "diff-friendly stable output" contract — if anyone tweaks the
// formatter (adds a heading, changes spacing, reorders fields) this test
// breaks loudly and forces a deliberate review of consumers (e.g. exports
// committed into a repo, scripts that grep the output).
test('exportSessionMarkdown: byte-identical to pinned fixture', () => {
  const s = makeSession();
  const expected = [
    '# Session sess-1',
    '',
    '- type: feature',
    '- start: 2026-01-01T12:00:00.000Z',
    '- end: 2026-01-01T12:30:00.000Z',
    '- workspace: demo',
    '- redactions: 0',
    '',
    '## Summary',
    '',
    'Worked on tests.',
    '',
    '## Key Files',
    '',
    '- src/a.ts',
    '- src/b.ts',
    '',
    '## Key Topics',
    '',
    '- ci',
    '- testing',
    '',
    '## Decisions',
    '',
    '- Use node:test',
    '',
    '## Problems Solved',
    '',
    '- Mock vscode module',
    '',
    '## User Tags',
    '',
    '- demo',
    '',
  ].join('\n');
  assert.equal(exportSessionMarkdown(s), expected);
});

test('exportSessionMarkdown: repeated calls produce identical strings (no clock/randomness)', () => {
  const s = makeSession({ keyTopics: ['a', 'b', 'c'], decisions: ['x'] });
  const runs = Array.from({ length: 5 }, () => exportSessionMarkdown(s));
  for (let i = 1; i < runs.length; i++) assert.equal(runs[i], runs[0]);
});
