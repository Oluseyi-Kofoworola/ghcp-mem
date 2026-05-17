import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { validateSession, validateSessions, _clearValidationCache } from '../validator';
import { CompressedSession } from '../types';
import * as vscode from 'vscode';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    workspaceName: 'demo',
    startTime: Date.now() - 60_000,
    endTime: Date.now() - 30_000,
    summary: 'demo session',
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

test('validator: empty keyFiles yields freshness 1 with emptyKeyFiles=true', async () => {
  _clearValidationCache();
  const r = await validateSession(makeSession({ id: 'a', keyFiles: [] }));
  assert.equal(r.freshness, 1);
  assert.equal(r.emptyKeyFiles, true);
  assert.deepEqual(r.missing, []);
});

test('validator: no workspace open returns neutral freshness', async () => {
  _clearValidationCache();
  (vscode.workspace as any).workspaceFolders = undefined;
  const r = await validateSession(makeSession({ id: 'b', keyFiles: ['src/foo.ts'] }));
  assert.equal(r.freshness, 1);
  assert.equal(r.emptyKeyFiles, false);
});

test('validator: missing files reduce freshness', async () => {
  _clearValidationCache();
  (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws', path: '/ws' } }];
  // Stub stat: throw for every path so all files are "missing".
  const origStat = (vscode.workspace.fs as any).stat;
  (vscode.workspace.fs as any).stat = async () => { throw new Error('not found'); };
  try {
    const r = await validateSession(makeSession({ id: 'c', keyFiles: ['src/a.ts', 'src/b.ts'] }));
    assert.equal(r.freshness, 0);
    assert.equal(r.missing.length, 2);
  } finally {
    (vscode.workspace.fs as any).stat = origStat;
  }
});

test('validator: partial freshness with mixed present/missing', async () => {
  _clearValidationCache();
  (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws', path: '/ws' } }];
  const origStat = (vscode.workspace.fs as any).stat;
  (vscode.workspace.fs as any).stat = async (uri: any) => {
    if (String(uri.path ?? uri.fsPath ?? '').endsWith('a.ts')) return {};
    throw new Error('missing');
  };
  try {
    const r = await validateSession(makeSession({ id: 'd', keyFiles: ['src/a.ts', 'src/b.ts'] }));
    assert.equal(r.freshness, 0.5);
    assert.equal(r.present.length, 1);
    assert.equal(r.missing.length, 1);
  } finally {
    (vscode.workspace.fs as any).stat = origStat;
  }
});

test('validator: results cached within TTL', async () => {
  _clearValidationCache();
  (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws', path: '/ws' } }];
  let statCalls = 0;
  const origStat = (vscode.workspace.fs as any).stat;
  (vscode.workspace.fs as any).stat = async () => { statCalls++; throw new Error('missing'); };
  try {
    const s = makeSession({ id: 'cache-1', keyFiles: ['src/x.ts'] });
    await validateSession(s);
    await validateSession(s);
    assert.equal(statCalls, 1, 'second call should hit cache');
  } finally {
    (vscode.workspace.fs as any).stat = origStat;
  }
});

test('validator: validateSessions returns a map keyed by id', async () => {
  _clearValidationCache();
  (vscode.workspace as any).workspaceFolders = undefined;
  const map = await validateSessions([
    makeSession({ id: 'x', keyFiles: [] }),
    makeSession({ id: 'y', keyFiles: [] }),
  ]);
  assert.equal(map.size, 2);
  assert.ok(map.get('x'));
  assert.ok(map.get('y'));
});

test('validator: multi-root resolves root from session.workspaceId', async () => {
  _clearValidationCache();
  (vscode.workspace as any).workspaceFolders = [
    { uri: { fsPath: '/ws-a', path: '/ws-a', toString: () => 'file:///ws-a' } },
    { uri: { fsPath: '/ws-b', path: '/ws-b', toString: () => 'file:///ws-b' } },
  ];
  const origStat = (vscode.workspace.fs as any).stat;
  const seen: string[] = [];
  (vscode.workspace.fs as any).stat = async (uri: any) => {
    const p = String(uri.path ?? uri.fsPath ?? '');
    seen.push(p);
    if (p.startsWith('/ws-b/')) return {};
    throw new Error('missing');
  };
  try {
    const r = await validateSession(makeSession({
      id: 'mr-1',
      workspaceId: 'file:///ws-b',
      keyFiles: ['src/ok.ts'],
    }));
    assert.equal(r.freshness, 1);
    assert.ok(seen.some(p => p.startsWith('/ws-b/')));
    assert.ok(!seen.some(p => p.startsWith('/ws-a/')));
  } finally {
    (vscode.workspace.fs as any).stat = origStat;
  }
});
