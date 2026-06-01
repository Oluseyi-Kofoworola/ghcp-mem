import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import {
  versionDriftRule,
  runWorkspaceAudit,
  formatAuditReport,
  hasBlockingIssues,
} from '../integrityChecker';

/**
 * Mock the workspace by monkey-patching `vscode.workspace.fs.readFile` so
 * each test can serve its own synthetic files. This is much simpler than
 * the temp-dir dance, and it isolates each test from the real filesystem.
 */
function withMockFiles<T>(files: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const origFs = (vscode.workspace.fs as any).readFile;
  const origFolders = (vscode.workspace as any).workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [
    { uri: vscode.Uri.file('/ws'), name: 'mock', index: 0 },
  ];
  (vscode.workspace.fs as any).readFile = async (uri: vscode.Uri) => {
    // Strip the workspace root so the rule's relative path matches.
    const path = uri.fsPath.replace(/^\/ws\//, '');
    if (path in files) return Buffer.from(files[path], 'utf-8');
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  return (async () => {
    try {
      return await fn();
    } finally {
      (vscode.workspace.fs as any).readFile = origFs;
      (vscode.workspace as any).workspaceFolders = origFolders;
    }
  })();
}

test('integrity audit: clean workspace = no issues', () =>
  withMockFiles(
    {
      'package.json': JSON.stringify({ name: 't', version: '1.5.0' }),
      'README.md': '<sub>**v1.5.0**</sub>',
      'docs/DEMO.md': '# Demo v1.5.0',
      'CHANGELOG.md': '## [1.5.0] — 2026-01-01',
    },
    async () => {
      const issues = await versionDriftRule.check(vscode.Uri.file('/ws'));
      assert.equal(issues.length, 0, 'clean workspace must produce zero issues');
    },
  ));

test("integrity audit: catches README ≠ package.json (the reviewer's exact bug)", () =>
  withMockFiles(
    {
      'package.json': JSON.stringify({ name: 't', version: '1.5.1' }),
      'README.md': '<sub>**v1.5.0**</sub>',
      'docs/DEMO.md': '# Demo v1.5.1',
      'CHANGELOG.md': '## [1.5.1] — 2026-01-01',
    },
    async () => {
      const issues = await versionDriftRule.check(vscode.Uri.file('/ws'));
      const readme = issues.find((i) => i.file === 'README.md');
      assert.ok(readme, 'must report README drift');
      assert.equal(readme.severity, 'error');
      assert.match(readme.message, /1\.5\.0.*1\.5\.1|1\.5\.1.*1\.5\.0/);
      assert.ok(readme.fix?.includes('bump:version'), 'fix should suggest the bumper');
    },
  ));

test('integrity audit: catches CHANGELOG drift', () =>
  withMockFiles(
    {
      'package.json': JSON.stringify({ name: 't', version: '1.5.1' }),
      'README.md': '<sub>**v1.5.1**</sub>',
      'docs/DEMO.md': 'v1.5.1',
      'CHANGELOG.md': '## [1.4.9] — 2026-01-01', // old top entry
    },
    async () => {
      const issues = await versionDriftRule.check(vscode.Uri.file('/ws'));
      const cl = issues.find((i) => i.file === 'CHANGELOG.md');
      assert.ok(cl, 'must report CHANGELOG drift');
      assert.equal(cl.severity, 'error');
      assert.match(cl.message, /\[1\.4\.9\].*1\.5\.1/);
    },
  ));

test('integrity audit: catches multiple drifting versions in DEMO.md', () =>
  withMockFiles(
    {
      'package.json': JSON.stringify({ name: 't', version: '1.5.1' }),
      'README.md': '<sub>**v1.5.1**</sub>',
      'docs/DEMO.md': '# Demo v1.5.0\n\nLater: v1.4.10',
      'CHANGELOG.md': '## [1.5.1] — 2026-01-01',
    },
    async () => {
      const issues = await versionDriftRule.check(vscode.Uri.file('/ws'));
      const demo = issues.find((i) => i.file === 'docs/DEMO.md');
      assert.ok(demo, 'must flag DEMO.md');
      assert.equal(demo.severity, 'error');
      assert.match(demo.message, /multiple versions/);
    },
  ));

test('integrity audit: invalid package.json is reported as error', () =>
  withMockFiles(
    {
      'package.json': '{ "version": "not-semver" }',
    },
    async () => {
      const issues = await versionDriftRule.check(vscode.Uri.file('/ws'));
      assert.equal(issues.length, 1);
      assert.equal(issues[0].file, 'package.json');
      assert.equal(issues[0].severity, 'error');
    },
  ));

test('integrity audit: runWorkspaceAudit with no open folder returns empty', async () => {
  const orig = (vscode.workspace as any).workspaceFolders;
  (vscode.workspace as any).workspaceFolders = undefined;
  try {
    const { issues, rulesRun } = await runWorkspaceAudit();
    assert.equal(issues.length, 0);
    assert.equal(rulesRun.length, 0);
  } finally {
    (vscode.workspace as any).workspaceFolders = orig;
  }
});

test('formatAuditReport: clean state produces success markdown', () => {
  const md = formatAuditReport([], ['version-drift']);
  assert.match(md, /All checks passed/);
});

test('formatAuditReport: groups by severity', () => {
  const md = formatAuditReport(
    [
      { rule: 'r', severity: 'error', file: 'a', message: 'm1' },
      { rule: 'r', severity: 'warning', file: 'b', message: 'm2' },
    ],
    ['r'],
  );
  assert.match(md, /❌ Errors \(1\)/);
  assert.match(md, /⚠️ Warnings \(1\)/);
});

test('hasBlockingIssues: true iff any error', () => {
  assert.equal(hasBlockingIssues([]), false);
  assert.equal(
    hasBlockingIssues([{ rule: 'r', severity: 'warning', file: 'a', message: 'm' }]),
    false,
  );
  assert.equal(
    hasBlockingIssues([{ rule: 'r', severity: 'error', file: 'a', message: 'm' }]),
    true,
  );
});
