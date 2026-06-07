/**
 * Phase 9 tests — router/intent classifier, cost estimator, recommender,
 * and the startup routing primer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyRequest, extractMentionedPaths, estimateAttachTokens, recommend } from '../router';
import { TOOLS } from '../mcpServer';
import { InMemoryMemento } from './__mocks__/vscode';
import { ContextStore } from '../contextStore';
import { ContextProvider } from '../contextProvider';
import { CompressedSession, computeContentHash } from '../types';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const summary = overrides.summary ?? 's';
  const keyFiles = overrides.keyFiles ?? ['src/foo.ts'];
  const keyTopics = overrides.keyTopics ?? [];
  const decisions = overrides.decisions ?? [];
  const problemsSolved = overrides.problemsSolved ?? [];
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    workspaceId: overrides.workspaceId ?? 'ws1',
    workspaceName: overrides.workspaceName ?? 'ws',
    startTime: overrides.startTime ?? Date.now() - 1000,
    endTime: overrides.endTime ?? Date.now(),
    summary,
    observationType: overrides.observationType ?? 'refactor',
    keyFiles,
    keyTopics,
    decisions,
    problemsSolved,
    rawEventCount: overrides.rawEventCount ?? 10,
    userTags: overrides.userTags ?? [],
    redactionCount: overrides.redactionCount ?? 0,
    contentHash:
      overrides.contentHash ??
      computeContentHash({ summary, keyFiles, keyTopics, decisions, problemsSolved }),
  };
}

// ─── classifyRequest ────────────────────────────────────────────────────────

test('classifyRequest — lookup verbs', () => {
  assert.equal(classifyRequest('why did we choose Postgres'), 'lookup');
  assert.equal(classifyRequest('what was decided about auth'), 'lookup');
  assert.equal(classifyRequest('how does the cache work'), 'lookup');
  assert.equal(classifyRequest('explain the routing decision'), 'lookup');
});

test('classifyRequest — modify verbs', () => {
  assert.equal(classifyRequest('add a new field to FileEditData'), 'modify');
  assert.equal(classifyRequest('refactor the auth module'), 'modify');
  assert.equal(classifyRequest('fix the regression in payments.ts'), 'modify');
  assert.equal(classifyRequest('write a test for this function'), 'modify');
});

test('classifyRequest — investigate verbs', () => {
  assert.equal(classifyRequest('find where hashPassword is used'), 'investigate');
  assert.equal(classifyRequest('show me where the rate limiter is'), 'investigate');
});

test('classifyRequest — mixed verbs', () => {
  assert.equal(classifyRequest('explain the bug then fix it'), 'mixed');
  assert.equal(classifyRequest('show me why the test fails and update the assertion'), 'mixed');
});

test('classifyRequest — empty / unknown', () => {
  assert.equal(classifyRequest(''), 'unknown');
  assert.equal(classifyRequest('random gibberish here'), 'unknown');
});

// ─── extractMentionedPaths ──────────────────────────────────────────────────

test('extractMentionedPaths — pulls file paths and symbol IDs from prose', () => {
  const out = extractMentionedPaths('explain src/auth.ts#hashPassword and update package.json');
  assert.ok(out.includes('src/auth.ts#hashPassword'));
  assert.ok(out.includes('package.json'));
});

test('extractMentionedPaths — empty for paths-free query', () => {
  assert.deepEqual(extractMentionedPaths('why did we pick this approach'), []);
});

// ─── estimateAttachTokens ───────────────────────────────────────────────────

test('estimateAttachTokens — ~4 chars per token', () => {
  assert.equal(estimateAttachTokens(4000), 1000);
  assert.equal(estimateAttachTokens(0), 2000); // default
  assert.equal(estimateAttachTokens(undefined), 2000);
});

// ─── recommend ──────────────────────────────────────────────────────────────

test('recommend — lookup intent picks MCP and shows savings', () => {
  const rec = recommend('why did we choose bcrypt', { fileSizes: { 'src/auth.ts': 12000 } });
  assert.equal(rec.intent, 'lookup');
  assert.ok(rec.actions.length >= 1);
  assert.equal(rec.actions[0].kind, 'mcp');
  assert.ok(
    rec.estimatedTotalTokens < rec.naiveAttachTokens,
    'MCP route must be cheaper than attach',
  );
});

test('recommend — modify intent suggests file pull (and a memory probe)', () => {
  const rec = recommend('add a new field to FileEditData in src/types.ts', {
    fileSizes: { 'src/types.ts': 8000 },
  });
  assert.equal(rec.intent, 'modify');
  const hasFile = rec.actions.some((a) => a.kind === 'attach');
  assert.ok(hasFile, 'modification intent must include a file action');
});

test('recommend — mixed intent emits a multi-step plan', () => {
  const rec = recommend('explain the bug then fix it in payments.ts', {
    fileSizes: { 'payments.ts': 4000 },
  });
  assert.equal(rec.intent, 'mixed');
  assert.ok(rec.actions.length >= 2, 'mixed intent should propose more than one action');
});

test('recommend — unknown intent falls back to cheap search probe', () => {
  const rec = recommend('random gibberish here');
  assert.equal(rec.intent, 'unknown');
  assert.equal(rec.actions[0].kind, 'mcp');
});

test('recommend — mcpAvailable=false degrades to attach-only', () => {
  const rec = recommend('why did we pick bcrypt', { mcpAvailable: false });
  assert.equal(rec.actions[0].kind, 'attach');
});

test('recommend — token total never exceeds naive attach for lookup intents', () => {
  // Lookup over a 50K-token file: MCP estimate should be a tiny fraction.
  const rec = recommend('what decisions exist for src/big.ts', {
    fileSizes: { 'src/big.ts': 200_000 },
  });
  assert.ok(
    rec.estimatedTotalTokens < rec.naiveAttachTokens / 10,
    `expected ≥10× saving, got ${rec.estimatedTotalTokens} vs ${rec.naiveAttachTokens}`,
  );
});

// ─── MCP catalog wiring ─────────────────────────────────────────────────────

test('mcpServer — baton_route tool is declared with `query` required', () => {
  const t = TOOLS.find((t) => t.name === 'baton_route');
  assert.ok(t, 'baton_route must be in the MCP catalog');
  assert.deepEqual(t!.inputSchema.required, ['query']);
});

test('mcpServer — strengthened descriptions mention PREFER routing guidance', () => {
  for (const name of ['baton_search', 'baton_entity', 'baton_snippets']) {
    const t = TOOLS.find((t) => t.name === name);
    assert.ok(t, `tool ${name} must exist`);
    assert.match(
      t!.description,
      /PREFER THIS|tokens vs/i,
      `tool ${name} description should include explicit routing guidance for agents`,
    );
  }
});

// ─── Routing primer in startup context ──────────────────────────────────────

test('buildStartupContext — emits a routing primer that teaches MCP-first behaviour', () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  // Need at least one session for buildStartupContext to emit anything.
  return store
    .addSession(
      makeSession({
        id: 'a',
        summary: 'auth refactor',
        keyTopics: ['authentication'],
      }),
    )
    .then(() => {
      const provider = new ContextProvider(store);
      const md = provider.buildStartupContext();
      assert.match(md, /How to gather context cheaply/, 'primer header missing');
      assert.match(md, /@baton \/entity/, 'primer must teach the /entity command');
      assert.match(md, /@baton \/search/, 'primer must teach the /search command');
      assert.match(md, /@baton \/route/, 'primer must teach the /route command');
      assert.match(md, /MODIFY/, 'primer must distinguish modify from lookup intent');
    });
});

test('buildStartupContext — primer absent when there are no sessions', () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const provider = new ContextProvider(store);
  assert.equal(provider.buildStartupContext(), '');
});
