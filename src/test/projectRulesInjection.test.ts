/**
 * Integration tests for project-rule injection through ContextProvider:
 * rules must inject even with zero sessions, and a hand-edited secret in
 * rules.md must be redacted before it reaches the generated context.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as vscode from './__mocks__/vscode';
import { InMemoryMemento } from './__mocks__/vscode';
import { ContextStore } from '../contextStore';
import { ContextProvider } from '../contextProvider';

async function withRulesFile<T>(md: string, fn: () => Promise<T>): Promise<T> {
  const ws = vscode.workspace as unknown as {
    workspaceFolders: unknown;
    fs: { readFile: (uri: unknown) => Promise<Uint8Array> };
  };
  const savedFolders = ws.workspaceFolders;
  const savedReadFile = ws.fs.readFile;
  ws.workspaceFolders = [{ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }];
  ws.fs.readFile = async () => Buffer.from(md, 'utf-8');
  try {
    return await fn();
  } finally {
    ws.workspaceFolders = savedFolders;
    ws.fs.readFile = savedReadFile;
  }
}

test('buildStartupContext — injects project rules even with zero sessions', async () => {
  await withRulesFile('## Architecture\n- all writes go through contextStore\n', async () => {
    const store = new ContextStore(new InMemoryMemento() as never);
    const provider = new ContextProvider(store);
    await provider.refreshProjectRules();
    const md = provider.buildStartupContext();
    assert.match(md, /Project Memory Rules/);
    assert.match(md, /all writes go through contextStore/);
    // No sessions and no lessons → the routing primer should be absent.
    assert.doesNotMatch(md, /How to gather context cheaply/);
  });
});

test('buildStartupContext — rules appear before the routing primer is irrelevant when empty', async () => {
  await withRulesFile('- a top-level general rule\n', async () => {
    const store = new ContextStore(new InMemoryMemento() as never);
    const provider = new ContextProvider(store);
    await provider.refreshProjectRules();
    const md = provider.buildStartupContext();
    assert.match(md, /a top-level general rule/);
    assert.match(md, /\*\*General:\*\*/);
  });
});

test('project rules — a hand-edited secret is redacted on injection', async () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  await withRulesFile(`## Constraints\n- never hardcode keys like ${secret}\n`, async () => {
    const store = new ContextStore(new InMemoryMemento() as never);
    const provider = new ContextProvider(store);
    await provider.refreshProjectRules();
    const md = provider.buildStartupContext();
    assert.ok(!md.includes(secret), 'raw AWS key must not survive into the generated context');
    assert.match(md, /never hardcode keys/);
  });
});

test('buildProjectRulesBlock — empty when projectRules config is off', async () => {
  await withRulesFile('## Architecture\n- some rule\n', async () => {
    const cfg = vscode.workspace.getConfiguration as unknown as () => {
      get: (k: string, d: unknown) => unknown;
    };
    const saved = vscode.workspace.getConfiguration;
    (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = () => ({
      get: (k: string, d: unknown) => (k === 'projectRules' ? false : d),
    });
    try {
      const store = new ContextStore(new InMemoryMemento() as never);
      const provider = new ContextProvider(store);
      await provider.refreshProjectRules();
      assert.equal(provider.buildProjectRulesBlock(), '');
    } finally {
      (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = saved;
      void cfg;
    }
  });
});
