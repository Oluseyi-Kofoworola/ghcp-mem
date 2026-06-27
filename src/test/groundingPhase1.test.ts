/**
 * Phase 1 grounding tests — compressor + pure-function surfaces.
 *
 * Covers the trust-layer upgrades that touch the compressor pipeline:
 *   - Evidence-citation gate drops ungrounded decisions/problems.
 *   - Reservoir sampling preserves diagnostics on big sessions.
 *   - Confidence scoring formula reacts to the right inputs.
 *
 * ContextStore + renderer tests live in groundingPhase1.store.test.ts —
 * they need the full vscode mock (EventEmitter etc.) so we don't shadow it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// vscode mock identical in shape to other compressor tests — sufficient
// for the compressor's selectChatModels/getConfiguration usage.
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
  LanguageModelChatMessage: { User: (text: string) => ({ role: 'user', content: text }) },
  CancellationTokenSource: class {
    token = { isCancellationRequested: false };
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  },
};
require.cache[require.resolve('vscode')] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: vscodeMock,
  paths: [],
  children: [],
  parent: null,
} as any;

import {
  ContextCompressor,
  CompressorInput,
  buildEvidenceMap,
  groundClaims,
  computeConfidence,
  collectKeyFileHashes,
  evidenceIdForIndex,
} from '../contextCompressor';
import { Evidence, SessionEvent } from '../types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEditEvent(
  filePath: string,
  i: number,
  contentHash?: string,
  changeCount = 1,
): SessionEvent {
  return {
    timestamp: Date.now() - (10 - i) * 1000,
    type: 'file_edit',
    data: {
      filePath,
      languageId: 'typescript',
      linesAdded: 3,
      linesRemoved: 1,
      changeCount,
      snippet: '',
      contentHash,
    },
  };
}

function lmReturning(json: object): (typeof mockModels)[0] {
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

function makeInput(overrides: Partial<CompressorInput> = {}): CompressorInput {
  return {
    events: [makeEditEvent('src/a.ts', 0), makeEditEvent('src/b.ts', 1)],
    sessionStartTime: Date.now() - 60_000,
    captureRedactionCount: 0,
    ...overrides,
  };
}

// ─── 1. Evidence ID stability ────────────────────────────────────────────────

test('evidenceIdForIndex — 1-based stable IDs', () => {
  assert.equal(evidenceIdForIndex(0), 'E1');
  assert.equal(evidenceIdForIndex(11), 'E12');
});

test('buildEvidenceMap — every event gets a unique ID and resolves to a path', () => {
  const events: SessionEvent[] = [
    makeEditEvent('src/auth.ts', 0, 'hashA'),
    {
      timestamp: Date.now(),
      type: 'diagnostic_change',
      data: { filePath: 'src/auth.ts', errorCount: 1, warningCount: 0, topMessages: ['boom'] },
    },
  ];
  const map = buildEvidenceMap(events);
  assert.equal(map.size, 2);
  assert.equal(map.get('E1')!.filePath, 'src/auth.ts');
  assert.equal(map.get('E1')!.fileHash, 'hashA');
  assert.equal(map.get('E1')!.kind, 'file_edit');
  assert.equal(map.get('E2')!.kind, 'diagnostic');
});

// ─── 2. Evidence-citation gate ───────────────────────────────────────────────

test('groundClaims — drops legacy string decisions (no grounding possible)', () => {
  const events = [makeEditEvent('src/a.ts', 0)];
  const table = buildEvidenceMap(events);
  const out = groundClaims(['legacy decision'] as any, table, (s) => s);
  assert.deepEqual(out.texts, []);
  assert.deepEqual(out.evidence, []);
});

test('groundClaims — drops decisions whose cited IDs do not exist', () => {
  const events = [makeEditEvent('src/a.ts', 0)];
  const table = buildEvidenceMap(events);
  const out = groundClaims(
    [{ text: 'invented rationale', evidence: ['E99', 'EX'] }],
    table,
    (s) => s,
  );
  assert.deepEqual(out.texts, [], 'invented citations must be dropped');
});

test('groundClaims — keeps decisions with at least one valid citation', () => {
  const events = [makeEditEvent('src/a.ts', 0), makeEditEvent('src/b.ts', 1)];
  const table = buildEvidenceMap(events);
  const out = groundClaims([{ text: 'real decision', evidence: ['E2', 'BOGUS'] }], table, (s) => s);
  assert.deepEqual(out.texts, ['real decision']);
  assert.equal(out.evidence[0].length, 1, 'only the resolvable citation should survive');
  assert.equal(out.evidence[0][0].filePath, 'src/b.ts');
});

test('groundClaims — sanitizer is applied to claim text', () => {
  const events = [makeEditEvent('src/a.ts', 0)];
  const table = buildEvidenceMap(events);
  const out = groundClaims(
    [{ text: 'TOKEN: AKIAIOSFODNN7EXAMPLE rotated', evidence: ['E1'] }],
    table,
    (s) => s.replace(/AKIA[A-Z0-9]+/g, '[REDACTED]'),
  );
  assert.match(out.texts[0], /\[REDACTED\]/);
});

// ─── 3. Confidence formula ────────────────────────────────────────────────────

test('computeConfidence — base lm path with multi-file evidence + rule agree → 0.9', () => {
  const ev: Evidence[][] = [
    [
      { kind: 'file_edit', filePath: 'src/a.ts' },
      { kind: 'file_edit', filePath: 'src/b.ts' },
    ],
  ];
  const c = computeConfidence({
    mode: 'lm',
    redactionCount: 0,
    eventLogTruncated: false,
    decisionEvidence: ev,
    problemEvidence: [],
    ruleAgrees: true,
  });
  assert.ok(c >= 0.89 && c <= 0.91, `expected ~0.9, got ${c}`);
});

test('computeConfidence — fallback mode + truncation + heavy redaction floors near zero', () => {
  const c = computeConfidence({
    mode: 'fallback',
    redactionCount: 20,
    eventLogTruncated: true,
    decisionEvidence: [],
    problemEvidence: [],
    ruleAgrees: false,
  });
  // base 0.5 − 0.2 (red) − 0.1 (trunc) = 0.2
  assert.ok(c <= 0.21 && c >= 0.0, `expected ~0.2, got ${c}`);
});

test('computeConfidence — clamps within [0, 1]', () => {
  const c = computeConfidence({
    mode: 'fallback',
    redactionCount: 999,
    eventLogTruncated: true,
    decisionEvidence: [],
    problemEvidence: [],
    ruleAgrees: false,
  });
  assert.ok(c >= 0 && c <= 1);
});

// ─── 4. Compressor integration: ungrounded LM output ─────────────────────────

test('compressor — drops decisions/problems the LM emits without evidence', async () => {
  mockModels.length = 0;
  mockModels.push(
    lmReturning({
      summary: 'work',
      observationType: 'refactor',
      keyFiles: ['src/a.ts'],
      keyTopics: ['refactor'],
      // E99 doesn't exist in our 2-event input. Should be dropped.
      decisions: [
        { text: 'fabricated decision', evidence: ['E99'] },
        { text: 'real decision', evidence: ['E1'] },
      ],
      problemsSolved: [{ text: 'also fabricated', evidence: [] }],
    }),
  );
  const c = new ContextCompressor();
  const s = await c.compress(makeInput());
  assert.ok(s);
  assert.deepEqual(s!.decisions, ['real decision'], 'ungrounded decisions must be dropped');
  assert.deepEqual(s!.problemsSolved, [], 'empty-evidence problems must be dropped');
});

test('compressor — sessions with no model use fallback mode + lower confidence', async () => {
  mockModels.length = 0;
  const c = new ContextCompressor();
  const s = await c.compress(makeInput());
  assert.ok(s);
  assert.equal(s!.compressorMode, 'fallback');
  assert.ok((s!.confidence ?? 1) <= 0.7);
});

// ─── 5. Reservoir sampling preserves high-signal events ──────────────────────

test('compressor — reservoir sampler keeps diagnostics + drops file_open under pressure', async () => {
  // Build a huge synthetic session: 200 file_open noise events + 5 critical diagnostics.
  const events: SessionEvent[] = [];
  for (let i = 0; i < 200; i++) {
    events.push({
      timestamp: Date.now() - (200 - i) * 1000,
      type: 'file_open',
      data: { filePath: `src/file_${i}.ts`, languageId: 'typescript' },
    });
  }
  for (let i = 0; i < 5; i++) {
    events.push({
      timestamp: Date.now() - 100 * (i + 1),
      type: 'diagnostic_change',
      data: {
        filePath: `src/diag${i}.ts`,
        errorCount: 1,
        warningCount: 0,
        topMessages: [`CRITICAL_DIAG_${i}`],
      },
    });
  }
  let promptSeen = '';
  mockModels.length = 0;
  mockModels.push({
    family: 'gpt-4o-mini',
    sendRequest: async (msgs: any[]) => {
      promptSeen = msgs[0].content;
      return {
        text: (async function* () {
          yield JSON.stringify({
            summary: 'x',
            observationType: 'unknown',
            keyFiles: [],
            keyTopics: [],
            decisions: [],
            problemsSolved: [],
          });
        })(),
      };
    },
  });
  const c = new ContextCompressor();
  await c.compress({ events, sessionStartTime: Date.now() - 60_000, captureRedactionCount: 0 });
  for (let i = 0; i < 5; i++) {
    assert.match(
      promptSeen,
      new RegExp(`CRITICAL_DIAG_${i}`),
      `diagnostic ${i} must survive sampling`,
    );
  }
});

// ─── 6. Key-file hash collection ─────────────────────────────────────────────

test('collectKeyFileHashes — picks the most recent contentHash per key file', () => {
  const events: SessionEvent[] = [
    makeEditEvent('src/a.ts', 0, 'oldA'),
    makeEditEvent('src/a.ts', 1, 'newA'),
    makeEditEvent('src/b.ts', 2, 'hashB'),
    makeEditEvent('src/c.ts', 3, undefined), // no hash — skipped
  ];
  const out = collectKeyFileHashes(['src/a.ts', 'src/b.ts', 'src/c.ts'], events);
  assert.equal(out['src/a.ts'], 'newA');
  assert.equal(out['src/b.ts'], 'hashB');
  assert.equal(out['src/c.ts'], undefined);
});
