import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchSessions, timelineSessions, TOOLS, redactPersistedStrings } from '../mcpServer';

function mkSession(o: any = {}) {
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: o.startTime ?? Date.now() - 1000,
    endTime: o.endTime ?? Date.now(),
    summary: o.summary ?? 'demo',
    observationType: o.observationType ?? 'feature',
    keyFiles: o.keyFiles ?? ['a.ts'],
    keyTopics: o.keyTopics ?? ['x'],
    decisions: o.decisions ?? [],
    problemsSolved: o.problemsSolved ?? [],
    userTags: o.userTags ?? [],
    redactionCount: 0,
    rawEventCount: 0,
  };
}

test('mcpServer — TOOLS catalog exposes the full surface', () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'ghcpMem_conflicts',
    'ghcpMem_delete',
    'ghcpMem_entity',
    'ghcpMem_explain',
    'ghcpMem_get',
    'ghcpMem_graph',
    'ghcpMem_lessons',
    'ghcpMem_lineage',
    'ghcpMem_recent',
    'ghcpMem_route',
    'ghcpMem_search',
    'ghcpMem_snippets',
    'ghcpMem_store',
    'ghcpMem_timeline',
  ]);
});

test('mcpServer — searchSessions ranks exact topic match above noise', () => {
  const db = {
    version: 2,
    lastUpdated: Date.now(),
    sessions: [
      mkSession({ summary: 'authentication rework', keyTopics: ['auth'] }),
      mkSession({ summary: 'ui tweaks', keyTopics: ['colors'] }),
    ],
  };
  const hits = searchSessions(db, 'authentication', {}, 5);
  assert.ok(hits.length >= 1);
  assert.match(hits[0].summary, /authentication/);
});

test('mcpServer — searchSessions respects type filter', () => {
  const db = {
    version: 2,
    lastUpdated: Date.now(),
    sessions: [
      mkSession({ summary: 'bug', observationType: 'bugfix' }),
      mkSession({ summary: 'feat', observationType: 'feature' }),
    ],
  };
  const hits = searchSessions(db, '', { type: 'bugfix' }, 5);
  assert.ok(hits.every((h) => h.observationType === 'bugfix'));
});

test('mcpServer — searchSessions respects sinceDays filter', () => {
  const db = {
    version: 2,
    lastUpdated: Date.now(),
    sessions: [
      mkSession({ summary: 'old', endTime: Date.now() - 40 * 24 * 60 * 60 * 1000 }),
      mkSession({ summary: 'new' }),
    ],
  };
  const hits = searchSessions(db, '', { sinceDays: 7 }, 5);
  assert.ok(hits.every((h) => h.summary !== 'old'));
});

test('mcpServer — timelineSessions returns most recent first', () => {
  const now = Date.now();
  const db = {
    version: 2,
    lastUpdated: now,
    sessions: [
      mkSession({ id: 'old', summary: 'old', endTime: now - 3 * 24 * 60 * 60 * 1000 }),
      mkSession({ id: 'mid', summary: 'mid', endTime: now - 2 * 24 * 60 * 60 * 1000 }),
      mkSession({ id: 'new', summary: 'new', endTime: now - 1 * 24 * 60 * 60 * 1000 }),
    ],
  };
  const hits = timelineSessions(db as any, 7, 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'new');
  assert.equal(hits[1].id, 'mid');
});

// ---------------------------------------------------------------------------
// v1.10.2 — MCP write path redaction (ghcpMem_store no longer persists raw).
// Before v1.10.2 the MCP `ghcpMem_store` handler took external-client input
// (Cursor / Claude Desktop / Cline) verbatim and pushed it into sessions.json,
// bypassing every secret rule that the in-process VS Code surface enforces.
// These tests pin the new behaviour: the same redactor that protects the
// in-process write surface also gates every MCP write.
// ---------------------------------------------------------------------------

test('mcpServer.redactPersistedStrings — masks an AWS key in summary', () => {
  const { redacted, count } = redactPersistedStrings({
    summary: 'Set AKIAIOSFODNN7EXAMPLE on the build runner',
    keyFiles: ['ci/setup.sh'],
  });
  assert.match(redacted.summary as string, /\[REDACTED:aws-access-key\]/);
  assert.deepEqual(redacted.keyFiles, ['ci/setup.sh']);
  assert.ok(count >= 1, 'redactionCount should reflect the AWS hit');
});

test('mcpServer.redactPersistedStrings — masks secrets inside an array', () => {
  const { redacted, count } = redactPersistedStrings({
    summary: 'innocent',
    decisions: [
      'use bcrypt cost 12',
      'rotate ghp_1234567890abcdefghijklmnopqrstuvwxyzAB last sprint',
    ],
  });
  const decs = redacted.decisions as string[];
  assert.equal(decs[0], 'use bcrypt cost 12');
  assert.match(decs[1], /\[REDACTED:github-token\]/);
  assert.ok(count >= 1);
});

test('mcpServer.redactPersistedStrings — pass-through preserves clean input + 0 count', () => {
  const { redacted, count } = redactPersistedStrings({
    summary: 'refactor cart checkout',
    keyFiles: ['src/cart.ts'],
    keyTopics: ['cart'],
    decisions: ['extract usePricing()'],
    problemsSolved: ['shipping address race'],
    userTags: ['demo'],
  });
  assert.equal(count, 0);
  assert.equal(redacted.summary, 'refactor cart checkout');
  assert.deepEqual(redacted.keyTopics, ['cart']);
});

test('mcpServer.redactPersistedStrings — drops non-string array entries', () => {
  const { redacted } = redactPersistedStrings({
    decisions: ['fine', 42, null, undefined, 'also fine'] as unknown as string[],
  });
  // Implementation skips non-strings rather than passing them through —
  // protects against MCP clients sending malformed array items.
  assert.deepEqual(redacted.decisions, ['fine', 'also fine']);
});
