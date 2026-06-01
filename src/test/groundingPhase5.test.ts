/**
 * Phase 5 tests — adaptive ranking weights, federated pack lineage merge,
 * NER-lite custom-entity redaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMemento } from './__mocks__/vscode';
import { ContextStore } from '../contextStore';
import { CompressedSession, computeContentHash } from '../types';
import {
  defaultWeights,
  emptyState,
  recordSample,
  recomputeWeights,
  applyRecomputedWeights,
  SIGNALS,
  MIN_WEIGHT,
  MAX_WEIGHT,
  MIN_SAMPLES,
  FeedbackSample,
} from '../adaptiveWeights';
import { buildPack, importPack } from '../packs';
import { redact } from '../redactor';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const summary = overrides.summary ?? 's';
  const keyFiles = overrides.keyFiles ?? ['src/foo.ts'];
  const keyTopics = overrides.keyTopics ?? [];
  const decisions = overrides.decisions ?? [];
  const problemsSolved = overrides.problemsSolved ?? [];
  const base: CompressedSession = {
    id:
      overrides.id ??
      `00000000-0000-0000-0000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
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
  if (overrides.confidence !== undefined) base.confidence = overrides.confidence;
  if (overrides.supersedes !== undefined) base.supersedes = overrides.supersedes;
  if (overrides.supersededBy !== undefined) base.supersededBy = overrides.supersededBy;
  if (overrides.retracted !== undefined) base.retracted = overrides.retracted;
  return base;
}

function buildSample(
  values: Partial<Record<(typeof SIGNALS)[number], number>>,
  feedback: 1 | -1,
): FeedbackSample {
  const full = { keyword: 0, recency: 0, confidence: 0, reinforcement: 0, feedback: 0 };
  return { values: { ...full, ...values }, feedback };
}

// ─── adaptive weight math ────────────────────────────────────────────────────

test('defaultWeights — every signal starts at 1.0', () => {
  const w = defaultWeights();
  for (const s of SIGNALS) assert.equal(w[s], 1.0);
});

test('recomputeWeights — below MIN_SAMPLES returns defaults', () => {
  const state = emptyState();
  for (let i = 0; i < MIN_SAMPLES - 1; i++) {
    recordSample(state, buildSample({ keyword: 1 }, 1));
  }
  const w = recomputeWeights(state);
  assert.deepEqual(w, defaultWeights());
});

test('recomputeWeights — bumps weights of signals that correlate with acceptance', () => {
  const state = emptyState();
  // 12 acceptances with high keyword score; 12 rejections with low keyword score.
  for (let i = 0; i < 12; i++)
    recordSample(state, buildSample({ keyword: 0.9, confidence: 0.5 }, 1));
  for (let i = 0; i < 12; i++)
    recordSample(state, buildSample({ keyword: 0.1, confidence: 0.5 }, -1));
  const w = recomputeWeights(state);
  assert.ok(w.keyword > 1.0, `keyword weight should rise (got ${w.keyword})`);
  // Confidence values were identical across the two buckets → no change.
  assert.equal(w.confidence, 1.0);
});

test('recomputeWeights — drops weights of signals that correlate with rejection', () => {
  const state = emptyState();
  for (let i = 0; i < 12; i++) recordSample(state, buildSample({ recency: 0.1 }, 1));
  for (let i = 0; i < 12; i++) recordSample(state, buildSample({ recency: 0.9 }, -1));
  const w = recomputeWeights(state);
  assert.ok(w.recency < 1.0, `recency weight should drop (got ${w.recency})`);
});

test('recomputeWeights — never exceeds bounds [MIN_WEIGHT, MAX_WEIGHT]', () => {
  let state = emptyState();
  // Hammer the keyword signal with strong positive feedback over many rounds.
  for (let round = 0; round < 200; round++) {
    for (let i = 0; i < 5; i++) recordSample(state, buildSample({ keyword: 1.0 }, 1));
    for (let i = 0; i < 5; i++) recordSample(state, buildSample({ keyword: 0.0 }, -1));
    state = applyRecomputedWeights(state, recomputeWeights(state));
  }
  for (const s of SIGNALS) {
    assert.ok(state.weights[s] >= MIN_WEIGHT, `${s} below MIN_WEIGHT`);
    assert.ok(state.weights[s] <= MAX_WEIGHT, `${s} above MAX_WEIGHT`);
  }
  assert.ok(
    state.weights.keyword > 1.2,
    'after sustained positive feedback keyword should approach the upper bound',
  );
});

test('recomputeWeights — keeps defaults when only one feedback side present', () => {
  const state = emptyState();
  for (let i = 0; i < 12; i++) recordSample(state, buildSample({ keyword: 1 }, 1));
  // Zero rejections → can't compute delta → defaults.
  assert.deepEqual(recomputeWeights(state), defaultWeights());
});

// ─── ContextStore integration ────────────────────────────────────────────────

test('ContextStore — initial adaptive weights are defaults', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  assert.deepEqual(store.getAdaptiveWeights(), defaultWeights());
});

test('ContextStore — sample counts grow on accept/reject', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(
    makeSession({ id: '00000000-0000-0000-0000-000000000001', summary: 'unique a' }),
  );
  await store.addSession(
    makeSession({ id: '00000000-0000-0000-0000-000000000002', summary: 'unique b' }),
  );
  // search() captures signal snapshots that recordAcceptance/Rejection need.
  store.search('unique', {}, 5);
  await store.recordAcceptance('00000000-0000-0000-0000-000000000001');
  await store.recordRejection('00000000-0000-0000-0000-000000000002');
  const counts = store.getAdaptiveSampleCount();
  assert.equal(counts.accepted, 1);
  assert.equal(counts.rejected, 1);
});

test('ContextStore.resetAdaptiveWeights — back to defaults', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.resetAdaptiveWeights();
  assert.deepEqual(store.getAdaptiveWeights(), defaultWeights());
  assert.deepEqual(store.getAdaptiveSampleCount(), { accepted: 0, rejected: 0 });
});

// ─── federated pack lineage merge ────────────────────────────────────────────

test('importPack — preserves supersession links across import boundary', async () => {
  const mem = new InMemoryMemento() as any;
  const exporter = new ContextStore(mem);
  await exporter.addSession(
    makeSession({
      id: '00000000-0000-0000-0000-aaaaaaaaaaaa',
      summary: 'original a',
      supersededBy: '00000000-0000-0000-0000-bbbbbbbbbbbb',
    }),
  );
  await exporter.addSession(
    makeSession({
      id: '00000000-0000-0000-0000-bbbbbbbbbbbb',
      summary: 'original b',
      supersedes: '00000000-0000-0000-0000-aaaaaaaaaaaa',
    }),
  );
  const pack = buildPack(exporter, { name: 'lineage-test', redactAgain: false });

  // Now import into a fresh store.
  const mem2 = new InMemoryMemento() as any;
  const importer = new ContextStore(mem2);
  const res = await importPack(importer, pack);
  assert.equal(res.imported, 2);
  const a = importer.getById('00000000-0000-0000-0000-aaaaaaaaaaaa')!;
  const b = importer.getById('00000000-0000-0000-0000-bbbbbbbbbbbb')!;
  assert.equal(a.supersededBy, '00000000-0000-0000-0000-bbbbbbbbbbbb');
  assert.equal(b.supersedes, '00000000-0000-0000-0000-aaaaaaaaaaaa');
});

test('importPack — raises conflict warning when an imported decision overturns local memory', async () => {
  const mem = new InMemoryMemento() as any;
  const importer = new ContextStore(mem);
  // Pre-existing local session with a decision.
  await importer.addSession(
    makeSession({
      id: '00000000-0000-0000-0000-aaaaaaaaaaaa',
      summary: 'local cookie auth',
      decisions: ['use cookie sessions'],
      keyFiles: ['src/auth.ts'],
      keyTopics: ['authentication'],
      endTime: Date.now() - 60_000,
    }),
  );
  // Pack contains a session that contradicts local memory.
  const incomingPack = {
    schemaVersion: 1,
    name: 'team-pack',
    createdAt: Date.now(),
    sessions: [
      makeSession({
        id: '00000000-0000-0000-0000-bbbbbbbbbbbb',
        summary: 'team migrated to JWT instead of cookie sessions',
        decisions: ['use JWT instead of cookie sessions for stateless API'],
        keyFiles: ['src/auth.ts'],
        keyTopics: ['authentication'],
        endTime: Date.now(),
      }),
    ],
  };
  const res = await importPack(importer, incomingPack);
  assert.equal(res.imported, 1);
  assert.ok(res.conflictsRaised >= 1, 'pack import must surface the conflict count');
  const pending = importer.getPendingConflicts();
  assert.ok(pending.some((p) => p.newSessionId === '00000000-0000-0000-0000-bbbbbbbbbbbb'));
});

// ─── NER-lite custom-entity redaction ────────────────────────────────────────

test('redact — customSensitiveEntities scrubs literal entity names', () => {
  const out = redact('We shipped Project Hydra to AcmeCorp internal staging today.', {
    redactSecrets: true,
    honorPrivateTags: false,
    customSensitiveEntities: ['Project Hydra', 'AcmeCorp internal'],
  });
  assert.match(out.text, /\[REDACTED:entity\]/);
  assert.ok(!out.text.includes('Project Hydra'));
  assert.ok(!out.text.includes('AcmeCorp internal'));
  assert.ok(out.redactionCount > 0);
  assert.ok(out.categories.includes('custom-entity'));
});

test('redact — customSensitiveEntities is case-insensitive', () => {
  const out = redact('we deployed project hydra last week.', {
    redactSecrets: true,
    honorPrivateTags: false,
    customSensitiveEntities: ['Project Hydra'],
  });
  assert.ok(!/project hydra/i.test(out.text));
});

test('redact — customSensitiveEntities respects word boundaries (no false positive inside identifiers)', () => {
  const out = redact('class ProjectHydraService { … }', {
    redactSecrets: true,
    honorPrivateTags: false,
    customSensitiveEntities: ['Project Hydra'],
  });
  // "ProjectHydraService" is one identifier — entity match must NOT fire
  // because the term is not separated by non-word chars.
  assert.match(out.text, /ProjectHydraService/);
});

test('redact — customSensitiveEntities empty array is a no-op', () => {
  const out = redact('Plain text without entities.', {
    redactSecrets: true,
    honorPrivateTags: false,
    customSensitiveEntities: [],
  });
  assert.equal(out.text, 'Plain text without entities.');
});

test('redact — customSensitiveEntities skipped when redactSecrets=false', () => {
  const out = redact('Project Hydra', {
    redactSecrets: false,
    honorPrivateTags: false,
    customSensitiveEntities: ['Project Hydra'],
  });
  assert.equal(
    out.text,
    'Project Hydra',
    'when scanning is disabled NER-lite must not fire either',
  );
});
