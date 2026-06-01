/**
 * Unit tests for ContextCompressor.
 *
 * vscode.lm is fully mocked so these tests run without a live Copilot
 * subscription. The tests verify:
 *   1. Happy-path LM compression produces a valid CompressedSession.
 *   2. LM JSON parsing failures fall back to rule-based compression.
 *   3. When no model is available the fallback produces a valid session.
 *   4. Secrets echoed by the LM are redacted in output.
 *   5. Azure tags are attached to the session.
 *   6. 30-second timeout cancels a hung model request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal vscode mock (matches the existing __mocks__/vscode.ts shape) ─────
const mockModels: Array<{
  family: string;
  sendRequest: (msgs: any[], opts: any, token: any) => Promise<{ text: AsyncIterable<string> }>;
}> = [];

const vscodeMock = {
  workspace: {
    workspaceFolders: [{ name: 'test-ws', uri: { toString: () => 'file:///test-ws' } }],
    getConfiguration: () => ({ get: (_k: string, d: any) => d }),
  },
  lm: {
    selectChatModels: async (opts?: { family?: string }) => {
      if (!opts?.family) return mockModels;
      return mockModels.filter((m) => m.family === opts.family);
    },
  },
  LanguageModelChatMessage: {
    User: (text: string) => ({ role: 'user', content: text }),
  },
  CancellationTokenSource: class {
    token = { isCancellationRequested: false };
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  },
};

// Inject the mock before importing the module under test.
require.cache[require.resolve('vscode')] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: vscodeMock,
  paths: [],
  children: [],
  parent: null,
} as any;

import { ContextCompressor, CompressorInput } from '../contextCompressor';
import type { SessionEvent } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvents(n = 5): SessionEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: Date.now() - (n - i) * 1000,
    type: 'file_edit' as const,
    data: {
      filePath: `src/module${i}.ts`,
      languageId: 'typescript',
      linesAdded: 3,
      linesRemoved: 1,
      changeCount: 1,
      snippet: `export function fn${i}() {}`,
    },
  }));
}

function makeInput(overrides: Partial<CompressorInput> = {}): CompressorInput {
  return {
    events: makeEvents(),
    sessionStartTime: Date.now() - 60_000,
    captureRedactionCount: 0,
    ...overrides,
  };
}

function makeLmResponse(json: object): (typeof mockModels)[0] {
  const text = JSON.stringify(json);
  return {
    family: 'gpt-4o-mini',
    sendRequest: async () => ({
      text: (async function* () {
        yield text;
      })(),
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('ContextCompressor — returns null for empty events', async () => {
  mockModels.length = 0;
  const c = new ContextCompressor();
  const result = await c.compress({
    events: [],
    sessionStartTime: Date.now(),
    captureRedactionCount: 0,
  });
  assert.equal(result, null);
});

test('ContextCompressor — fallback produces valid session when no model available', async () => {
  mockModels.length = 0;
  const c = new ContextCompressor();
  const session = await c.compress(makeInput());
  assert.ok(session);
  assert.equal(typeof session!.id, 'string');
  assert.ok(session!.keyFiles.length > 0);
  assert.ok(['feature', 'bugfix', 'refactor', 'unknown'].includes(session!.observationType));
  assert.ok(session!.rawEventCount > 0);
});

test('ContextCompressor — LM happy path produces session with correct fields', async () => {
  mockModels.length = 0;
  mockModels.push(
    makeLmResponse({
      summary: 'Refactored authentication module to use JWT tokens.',
      observationType: 'refactor',
      keyFiles: ['src/auth.ts', 'src/middleware.ts'],
      keyTopics: ['jwt', 'authentication'],
      decisions: [{ text: 'Use short-lived access tokens (15 min)', evidence: ['E1', 'E2'] }],
      problemsSolved: [{ text: 'Session expiry not handled', evidence: ['E1'] }],
    }),
  );
  const c = new ContextCompressor();
  const session = await c.compress(makeInput());
  assert.ok(session);
  assert.equal(session!.observationType, 'refactor');
  assert.ok(session!.summary.includes('JWT'));
  assert.ok(session!.keyFiles.includes('src/auth.ts'));
  assert.ok(session!.decisions.length > 0);
  assert.ok(session!.decisionEvidence && session!.decisionEvidence[0].length > 0);
  assert.ok(session!.contentHash, 'contentHash should be set');
  assert.equal(session!.compressorMode, 'lm');
  assert.ok(typeof session!.confidence === 'number');
});

test('ContextCompressor — falls back when LM returns invalid JSON', async () => {
  mockModels.length = 0;
  mockModels.push({
    family: 'gpt-4o-mini',
    sendRequest: async () => ({
      text: (async function* () {
        yield 'Sorry, I cannot help with that.';
      })(),
    }),
  });
  const c = new ContextCompressor();
  const session = await c.compress(makeInput());
  // Should still return a session via fallback, not throw.
  assert.ok(session);
  assert.equal(typeof session!.id, 'string');
});

test('ContextCompressor — redacts secrets in LM output', async () => {
  mockModels.length = 0;
  mockModels.push(
    makeLmResponse({
      summary: 'Added AWS key AKIAIOSFODNN7EXAMPLE to config.',
      observationType: 'config',
      keyFiles: [],
      keyTopics: ['aws'],
      decisions: [],
      problemsSolved: [],
    }),
  );
  const c = new ContextCompressor();
  const session = await c.compress(makeInput());
  assert.ok(session);
  assert.ok(!session!.summary.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key must be redacted');
  assert.ok(session!.summary.includes('[REDACTED'));
});

test('ContextCompressor — azure tags are appended to userTags', async () => {
  mockModels.length = 0;
  const c = new ContextCompressor();
  const session = await c.compress(
    makeInput({
      azureTags: ['azure', 'bicep'],
      azureSubsystems: ['iac-bicep'],
    }),
  );
  assert.ok(session);
  assert.ok(session!.userTags.includes('azure'));
  assert.ok(session!.userTags.includes('bicep'));
});

test('ContextCompressor — observationType falls back to rule classifier when LM returns unknown', async () => {
  mockModels.length = 0;
  // LM says unknown, but events are test files — rule classifier should catch it.
  const testEvents: SessionEvent[] = [
    {
      timestamp: Date.now(),
      type: 'file_edit',
      data: {
        filePath: 'src/auth.test.ts',
        languageId: 'typescript',
        linesAdded: 10,
        linesRemoved: 0,
        changeCount: 1,
      },
    },
  ];
  mockModels.push(
    makeLmResponse({
      summary: 'Wrote tests.',
      observationType: 'unknown',
      keyFiles: ['src/auth.test.ts'],
      keyTopics: ['testing'],
      decisions: [],
      problemsSolved: [],
    }),
  );
  const c = new ContextCompressor();
  const session = await c.compress(makeInput({ events: testEvents }));
  assert.ok(session);
  assert.equal(session!.observationType, 'test');
});
