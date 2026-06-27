import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  getRepoScope,
  getRepoScopeSync,
  normalizeRemoteUrl,
  _clearRepoScopeCache,
} from '../repoScope';
import * as vscode from 'vscode';

test('normalizeRemoteUrl: SSH shorthand', () => {
  assert.equal(normalizeRemoteUrl('git@github.com:foo/bar.git'), 'github.com/foo/bar');
});

test('normalizeRemoteUrl: HTTPS', () => {
  assert.equal(normalizeRemoteUrl('https://github.com/foo/bar.git'), 'github.com/foo/bar');
});

test('normalizeRemoteUrl: ssh://', () => {
  assert.equal(normalizeRemoteUrl('ssh://git@github.com/foo/bar'), 'github.com/foo/bar');
});

test('normalizeRemoteUrl: trailing slash and case', () => {
  assert.equal(normalizeRemoteUrl('HTTPS://GitHub.com/Foo/Bar/'), 'github.com/foo/bar');
});

test('getRepoScope: no workspace → no-workspace sentinel', async () => {
  _clearRepoScopeCache();
  (vscode.workspace as any).workspaceFolders = undefined;
  const info = await getRepoScope();
  assert.equal(info.id, 'no-workspace');
  assert.equal(info.fromGitRemote, false);
});

test('getRepoScope: falls back to workspace hash when no .git/config', async () => {
  _clearRepoScopeCache();
  (vscode.workspace as any).workspaceFolders = [
    {
      uri: { toString: () => 'file:///ws', fsPath: '/ws', path: '/ws' },
      name: 'demo-ws',
      index: 0,
    },
  ];
  // Force the .git/config read to fail.
  const orig = (vscode.workspace.fs as any).readFile;
  (vscode.workspace.fs as any).readFile = async () => {
    throw new Error('ENOENT');
  };
  try {
    const info = await getRepoScope();
    assert.equal(info.fromGitRemote, false);
    assert.equal(info.label, 'demo-ws');
    assert.ok(info.id && info.id.length === 16);
  } finally {
    (vscode.workspace.fs as any).readFile = orig;
  }
});

test('getRepoScope: parses git remote origin', async () => {
  _clearRepoScopeCache();
  (vscode.workspace as any).workspaceFolders = [
    {
      uri: { toString: () => 'file:///ws', fsPath: '/ws', path: '/ws' },
      name: 'demo-ws',
      index: 0,
    },
  ];
  const config = `[core]
\tbare = false
[remote "origin"]
\turl = git@github.com:foo/bar.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
`;
  const orig = (vscode.workspace.fs as any).readFile;
  (vscode.workspace.fs as any).readFile = async () => new TextEncoder().encode(config);
  try {
    const info = await getRepoScope();
    assert.equal(info.fromGitRemote, true);
    assert.equal(info.label, 'github.com/foo/bar');
  } finally {
    (vscode.workspace.fs as any).readFile = orig;
  }
});

test('getRepoScopeSync: returns cached value after async resolution', async () => {
  _clearRepoScopeCache();
  (vscode.workspace as any).workspaceFolders = [
    {
      uri: { toString: () => 'file:///ws2', fsPath: '/ws2', path: '/ws2' },
      name: 'cached-ws',
      index: 0,
    },
  ];
  const orig = (vscode.workspace.fs as any).readFile;
  (vscode.workspace.fs as any).readFile = async () => {
    throw new Error('no .git');
  };
  try {
    const asyncInfo = await getRepoScope();
    const syncInfo = getRepoScopeSync();
    assert.equal(asyncInfo.id, syncInfo.id);
  } finally {
    (vscode.workspace.fs as any).readFile = orig;
  }
});
