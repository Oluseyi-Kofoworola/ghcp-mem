import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchSessions, TOOLS } from '../mcpServer';

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

test('mcpServer — TOOLS catalog exposes 4 tools', () => {
  const names = TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, ['ghcpMem_get', 'ghcpMem_recent', 'ghcpMem_search', 'ghcpMem_timeline']);
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
  assert.ok(hits.every(h => h.observationType === 'bugfix'));
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
  assert.ok(hits.every(h => h.summary !== 'old'));
});
