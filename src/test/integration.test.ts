/**
 * Integration tests: SessionCapture → ContextCompressor → ContextStore pipeline.
 *
 * These tests use the same vscode stub as the unit tests and exercise the full
 * flow without a live VS Code instance or LM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── vscode mock ───────────────────────────────────────────────────────────────
import { InMemoryMemento } from './__mocks__/vscode';

// Minimal vscode mock for pipeline tests (no LM — exercises fallback path).
const vscodeMock = {
  workspace: {
    workspaceFolders: [{ name: 'integration-ws', uri: { toString: () => 'file:///integration-ws' } }],
    getConfiguration: () => ({ get: (_k: string, d: any) => d }),
    fs: {
      createDirectory: async () => {},
      writeFile: async () => {},
      readFile: async () => new Uint8Array(),
      readDirectory: async () => [],
      delete: async () => {},
    },
    onDidChangeTextDocument: (_cb: any) => ({ dispose: () => {} }),
    onDidCreateFiles: (_cb: any) => ({ dispose: () => {} }),
    onDidDeleteFiles: (_cb: any) => ({ dispose: () => {} }),
    onDidRenameFiles: (_cb: any) => ({ dispose: () => {} }),
    onDidOpenTextDocument: (_cb: any) => ({ dispose: () => {} }),
    onDidCloseTextDocument: (_cb: any) => ({ dispose: () => {} }),
    onDidChangeDiagnostics: (_cb: any) => ({ dispose: () => {} }),
  },
  window: {
    onDidChangeActiveTextEditor: (_cb: any) => ({ dispose: () => {} }),
    onDidChangeVisibleTextEditors: (_cb: any) => ({ dispose: () => {} }),
    createStatusBarItem: () => ({ text: '', show() {}, hide() {}, dispose() {} }),
    terminals: [],
    onDidOpenTerminal: (_cb: any) => ({ dispose: () => {} }),
    onDidCloseTerminal: (_cb: any) => ({ dispose: () => {} }),
  },
  debug: {
    onDidStartDebugSession: (_cb: any) => ({ dispose: () => {} }),
    onDidTerminateDebugSession: (_cb: any) => ({ dispose: () => {} }),
  },
  tasks: {
    onDidStartTask: (_cb: any) => ({ dispose: () => {} }),
    onDidEndTaskProcess: (_cb: any) => ({ dispose: () => {} }),
  },
  lm: {
    selectChatModels: async () => [],
  },
  LanguageModelChatMessage: { User: (t: string) => ({ role: 'user', content: t }) },
  CancellationTokenSource: class {
    token = { isCancellationRequested: false };
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  },
  EventEmitter: class {
    private listeners: Function[] = [];
    event = (l: Function) => { this.listeners.push(l); return { dispose: () => {} }; };
    fire(d: any) { this.listeners.forEach(l => l(d)); }
    dispose() {}
  },
  Uri: {
    joinPath: (base: any, ...segs: string[]) => ({
      fsPath: [base?.fsPath ?? '', ...segs].join('/'),
      path: [base?.path ?? '', ...segs].join('/'),
      toString: () => [base?.fsPath ?? '', ...segs].join('/'),
    }),
    file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
  },
};

require.cache[require.resolve('vscode')] = {
  id: 'vscode', filename: 'vscode', loaded: true,
  exports: vscodeMock, paths: [], children: [], parent: null,
} as any;

import { ContextCompressor } from '../contextCompressor';
import { ContextStore } from '../contextStore';
import type { SessionEvent } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFileEditEvent(filePath: string): SessionEvent {
  return {
    timestamp: Date.now(),
    type: 'file_edit',
    data: { filePath, languageId: 'typescript', linesAdded: 5, linesRemoved: 2, changeCount: 1 },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('Pipeline — compressor → store round-trip stores a session', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const compressor = new ContextCompressor();

  const events: SessionEvent[] = [
    makeFileEditEvent('src/auth.ts'),
    makeFileEditEvent('src/middleware.ts'),
    makeFileEditEvent('src/auth.test.ts'),
  ];

  const session = await compressor.compress({
    events,
    sessionStartTime: Date.now() - 120_000,
    captureRedactionCount: 0,
  });
  assert.ok(session, 'compress should return a session');
  await store.addSession(session!);
  assert.equal(store.getAllSessions().length, 1);
  const stored = store.getAllSessions()[0];
  assert.equal(stored.id, session!.id);
  assert.ok(stored.keyFiles.length > 0);
});

test('Pipeline — dedup prevents storing identical session twice', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const compressor = new ContextCompressor();

  const events: SessionEvent[] = [makeFileEditEvent('src/widget.ts')];
  const session = await compressor.compress({
    events,
    sessionStartTime: Date.now() - 60_000,
    captureRedactionCount: 0,
  });
  assert.ok(session);
  await store.addSession(session!);
  // Force identical contentHash by re-adding the exact same object.
  await store.addSession({ ...session! });
  assert.equal(store.getAllSessions().length, 1, 'Dedup should merge identical sessions');
});

test('Pipeline — search finds stored session by keyword', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  const compressor = new ContextCompressor();

  const session = await compressor.compress({
    events: [makeFileEditEvent('src/payment-gateway.ts')],
    sessionStartTime: Date.now() - 60_000,
    captureRedactionCount: 0,
  });
  assert.ok(session);
  // Inject a meaningful summary so keyword search can match it.
  session!.summary = 'Implemented payment gateway integration with Stripe.';
  session!.keyTopics = ['payment', 'stripe', 'gateway'];
  await store.addSession(session!);

  const hits = store.search('payment', {}, 5);
  assert.ok(hits.length >= 1);
  assert.ok(hits.some(s => s.id === session!.id));
});

test('Pipeline — retention removes old sessions', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);

  // Directly inject an old session (110 days ago).
  const oldTime = Date.now() - 110 * 24 * 60 * 60 * 1000;
  await store.addSession({
    id: 'old-session',
    workspaceId: 'file:///integration-ws',
    workspaceName: 'integration-ws',
    startTime: oldTime,
    endTime: oldTime + 1000,
    summary: 'Old work',
    observationType: 'chore',
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 1,
    userTags: [],
    redactionCount: 0,
  });
  assert.equal(store.getAllSessions().length, 1);
  // enforceRetention is called at startup; call it again explicitly.
  await store.enforceRetention();
  assert.equal(store.getAllSessions().length, 0, 'Session older than retentionDays should be removed');
});

test('Pipeline — import redacts secrets in incoming sessions', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);

  const maliciousExport = JSON.stringify({
    version: 2,
    sessions: [{
      id: 'a1b2c3d4-0000-0000-0000-000000000001',
      workspaceId: 'file:///other',
      workspaceName: 'other',
      startTime: Date.now() - 1000,
      endTime: Date.now(),
      summary: 'Used AWS key AKIAIOSFODNN7EXAMPLE in deployment.',
      observationType: 'deployment',
      keyFiles: [],
      keyTopics: [],
      decisions: ['password=SuperSecret123'],
      problemsSolved: [],
      rawEventCount: 1,
      userTags: [],
      redactionCount: 0,
    }],
    lastUpdated: Date.now(),
  });

  await store.importFromJson(maliciousExport, true);
  const sessions = store.getAllSessions();
  assert.equal(sessions.length, 1);
  assert.ok(!sessions[0].summary.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key must be redacted on import');
  assert.ok(!sessions[0].decisions[0].includes('SuperSecret123'), 'Password must be redacted on import');
});

test('Pipeline — import skips sessions with invalid IDs', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);

  const badExport = JSON.stringify({
    version: 2,
    sessions: [{
      id: 'not-a-uuid',
      workspaceId: 'file:///other',
      workspaceName: 'other',
      startTime: Date.now() - 1000,
      endTime: Date.now(),
      summary: 'Session with malformed ID.',
      observationType: 'chore',
      keyFiles: [], keyTopics: [], decisions: [], problemsSolved: [],
      rawEventCount: 1, userTags: [], redactionCount: 0,
    }],
    lastUpdated: Date.now(),
  });

  const result = await store.importFromJson(badExport, true);
  assert.equal(result.imported, 0, 'Session with invalid ID must be skipped');
  assert.equal(store.getAllSessions().length, 0);
});
