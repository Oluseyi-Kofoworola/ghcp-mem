/**
 * Phase 4 (final slice) tests — snippet layer, conflict detection,
 * cross-session causal graph.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMemento } from './__mocks__/vscode';
import { ContextStore } from '../contextStore';
import { CompressedSession, Evidence, computeContentHash } from '../types';
import { snippetsFromSession, snippetScore, tokenizeSnippet, avgSnippetLen } from '../snippets';
import { hasContradictionMarker, detectConflicts, CONTRADICTION_MARKERS } from '../conflicts';
import { getCausalNeighbors, labelEdge, CAUSAL_WINDOW_MS } from '../causalGraph';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const summary = overrides.summary ?? 's';
  const keyFiles = overrides.keyFiles ?? ['src/foo.ts'];
  const keyTopics = overrides.keyTopics ?? [];
  const decisions = overrides.decisions ?? [];
  const problemsSolved = overrides.problemsSolved ?? [];
  const base: CompressedSession = {
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
  if (overrides.confidence !== undefined) base.confidence = overrides.confidence;
  if (overrides.supersedes !== undefined) base.supersedes = overrides.supersedes;
  if (overrides.supersededBy !== undefined) base.supersededBy = overrides.supersededBy;
  if (overrides.retracted !== undefined) base.retracted = overrides.retracted;
  if (overrides.decisionEvidence !== undefined) base.decisionEvidence = overrides.decisionEvidence;
  if (overrides.problemEvidence !== undefined) base.problemEvidence = overrides.problemEvidence;
  return base;
}

// ─── snippetsFromSession ─────────────────────────────────────────────────────

test('snippetsFromSession — produces one snippet per non-empty field', () => {
  const s = makeSession({
    id: 'sx',
    summary: 'auth refactor',
    decisions: ['use bcrypt cost 12', 'short-lived JWTs'],
    problemsSolved: ['weak hash'],
    keyTopics: ['authentication', 'security'],
  });
  const out = snippetsFromSession(s);
  // 1 summary + 2 decisions + 1 problem + 2 topics = 6 snippets
  assert.equal(out.length, 6);
  const kinds = out.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['decision', 'decision', 'problem', 'summary', 'topic', 'topic']);
  for (const sn of out) assert.equal(sn.sessionId, 'sx');
});

test('snippetsFromSession — skips empty strings', () => {
  const s = makeSession({
    decisions: ['real decision', '', '   '],
    problemsSolved: [''],
    keyTopics: [],
  });
  const out = snippetsFromSession(s);
  // 1 summary + 1 decision (the only non-empty one) = 2
  assert.equal(out.length, 2);
});

test('snippetsFromSession — propagates evidence, confidence, retraction', () => {
  const ev: Evidence[][] = [[{ kind: 'file_edit', filePath: 'src/a.ts' }]];
  const s = makeSession({
    id: 'sy',
    decisions: ['real'],
    decisionEvidence: ev,
    confidence: 0.91,
    retracted: true,
  });
  const out = snippetsFromSession(s);
  const decisionSnip = out.find((x) => x.kind === 'decision')!;
  assert.equal(decisionSnip.evidence?.[0].filePath, 'src/a.ts');
  assert.equal(decisionSnip.confidence, 0.91);
  assert.equal(decisionSnip.retracted, true);
});

// ─── tokenizeSnippet + snippetScore ──────────────────────────────────────────

test('tokenizeSnippet — drops short tokens and punctuation', () => {
  const t = tokenizeSnippet('use BCrypt(cost=12) for AuthService.');
  assert.ok(t.has('bcrypt'));
  assert.ok(t.has('cost'));
  assert.ok(t.has('authservice'));
  assert.ok(!t.has('a'), 'short tokens excluded');
});

test('snippetScore — returns 0 when no terms match', () => {
  const sn = snippetsFromSession(makeSession({ decisions: ['use bcrypt'] })).find(
    (x) => x.kind === 'decision',
  )!;
  assert.equal(snippetScore(sn, new Set(['rust', 'kafka'])), 0);
});

test('snippetScore — decision/topic outranks summary on same hit', () => {
  const sessions = [makeSession({ id: 'a', summary: 'auth refactor', decisions: ['auth'] })];
  const snippets = sessions.flatMap(snippetsFromSession);
  const avg = avgSnippetLen(snippets);
  const dec = snippets.find((s) => s.kind === 'decision')!;
  const sum = snippets.find((s) => s.kind === 'summary')!;
  const decScore = snippetScore(dec, new Set(['auth']), avg);
  const sumScore = snippetScore(sum, new Set(['auth']), avg);
  assert.ok(decScore > sumScore, `decision (${decScore}) should outrank summary (${sumScore})`);
});

// ─── ContextStore.searchSnippets ─────────────────────────────────────────────

test('ContextStore.searchSnippets — returns matching snippets ranked by score', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(
    makeSession({
      id: 's1',
      summary: 'irrelevant payments work',
      decisions: ['use stripe webhooks'],
    }),
  );
  await store.addSession(
    makeSession({
      id: 's2',
      summary: 'auth refactor',
      decisions: ['use bcrypt cost 12', 'rotate JWTs every 15 minutes'],
    }),
  );
  const hits = store.searchSnippets('bcrypt', {}, 5);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].sessionId, 's2');
  assert.equal(hits[0].kind, 'decision');
  assert.match(hits[0].text, /bcrypt/);
});

test('ContextStore.searchSnippets — excludes retracted parent sessions', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(
    makeSession({
      id: 'live',
      summary: 'auth note',
      decisions: ['use bcrypt'],
    }),
  );
  await store.addSession(
    makeSession({
      id: 'gone',
      summary: 'auth note gone',
      decisions: ['use bcrypt'],
      retracted: true,
    }),
  );
  const hits = store.searchSnippets('bcrypt', {}, 5);
  assert.ok(
    !hits.some((h) => h.sessionId === 'gone'),
    'retracted session must not contribute snippets',
  );
});

test('ContextStore.searchSnippets — empty query falls back to newest-first', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(makeSession({ id: 'old', summary: 'old', endTime: Date.now() - 60_000 }));
  await store.addSession(makeSession({ id: 'new', summary: 'new', endTime: Date.now() }));
  const hits = store.searchSnippets('', {}, 10);
  assert.equal(hits[0].sessionId, 'new');
});

// ─── conflicts ───────────────────────────────────────────────────────────────

test('hasContradictionMarker — flags every documented marker', () => {
  for (const marker of CONTRADICTION_MARKERS) {
    const text = `We are ${marker} the old approach because reasons.`;
    assert.ok(hasContradictionMarker(text), `marker "${marker}" should fire`);
  }
});

test('hasContradictionMarker — returns undefined for neutral text', () => {
  assert.equal(hasContradictionMarker('We chose Postgres for transactional integrity.'), undefined);
});

test('detectConflicts — flags decisions overlapping older session with shared file', () => {
  const old = makeSession({
    id: 'old',
    summary: 'initial auth choice',
    decisions: ['use cookie sessions'],
    keyFiles: ['src/auth.ts'],
    keyTopics: ['authentication'],
    endTime: Date.now() - 60_000,
  });
  const newer = makeSession({
    id: 'new',
    summary: 'auth rework',
    decisions: ['use JWT instead of cookie sessions for stateless API'],
    keyFiles: ['src/auth.ts'],
    keyTopics: ['authentication'],
    endTime: Date.now(),
  });
  const warnings = detectConflicts(newer, [old]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].marker, 'instead of');
  assert.equal(warnings[0].candidates[0].sessionId, 'old');
});

test('detectConflicts — no candidates when files/topics do not overlap', () => {
  const old = makeSession({
    id: 'old',
    decisions: ['use cookie sessions'],
    keyFiles: ['src/ui.tsx'],
    keyTopics: ['ui'],
    endTime: Date.now() - 60_000,
  });
  const newer = makeSession({
    id: 'new',
    decisions: ['rolled back cookies on the auth path'],
    keyFiles: ['src/auth.ts'],
    keyTopics: ['authentication'],
    endTime: Date.now(),
  });
  const warnings = detectConflicts(newer, [old]);
  assert.equal(warnings.length, 0);
});

test('ContextStore — addSession surfaces detected conflicts via getPendingConflicts', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(
    makeSession({
      id: 'old',
      summary: 'a',
      decisions: ['use cookies'],
      keyFiles: ['src/auth.ts'],
      keyTopics: ['authentication'],
      endTime: Date.now() - 60_000,
    }),
  );
  await store.addSession(
    makeSession({
      id: 'new',
      summary: 'b',
      decisions: ['use JWT instead of cookies'],
      keyFiles: ['src/auth.ts'],
      keyTopics: ['authentication'],
      endTime: Date.now(),
    }),
  );
  const pending = store.getPendingConflicts();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].newSessionId, 'new');
});

test('ContextStore.setSupersedes — acknowledges matching conflict warning', async () => {
  const mem = new InMemoryMemento() as any;
  const store = new ContextStore(mem);
  await store.addSession(
    makeSession({
      id: 'old',
      summary: 'a',
      decisions: ['use cookies'],
      keyFiles: ['src/auth.ts'],
      keyTopics: ['authentication'],
      endTime: Date.now() - 60_000,
    }),
  );
  await store.addSession(
    makeSession({
      id: 'new',
      summary: 'b',
      decisions: ['use JWT instead of cookies'],
      keyFiles: ['src/auth.ts'],
      keyTopics: ['authentication'],
      endTime: Date.now(),
    }),
  );
  assert.equal(store.getPendingConflicts().length, 1);
  await store.setSupersedes('new', 'old');
  assert.equal(
    store.getPendingConflicts().length,
    0,
    '/supersede must auto-acknowledge the warning',
  );
});

// ─── causal graph ────────────────────────────────────────────────────────────

test('labelEdge — bugfix after feature → introduced_issue_fixed_by', () => {
  const feat = makeSession({ observationType: 'feature' });
  const fix = makeSession({ observationType: 'bugfix' });
  assert.equal(labelEdge(feat, fix), 'introduced_issue_fixed_by');
});

test('labelEdge — refactor after feature → extends', () => {
  const feat = makeSession({ observationType: 'feature' });
  const ref = makeSession({ observationType: 'refactor' });
  assert.equal(labelEdge(feat, ref), 'extends');
});

test('labelEdge — test after feature → tests', () => {
  const feat = makeSession({ observationType: 'feature' });
  const t = makeSession({ observationType: 'test' });
  assert.equal(labelEdge(feat, t), 'tests');
});

test('getCausalNeighbors — walks predecessors and successors within window', () => {
  const now = Date.now();
  const center = makeSession({
    id: 'c',
    startTime: now - 10_000,
    endTime: now,
    keyFiles: ['src/auth.ts'],
    observationType: 'refactor',
  });
  const pred = makeSession({
    id: 'p',
    startTime: now - 86_400_000 - 10_000,
    endTime: now - 86_400_000,
    keyFiles: ['src/auth.ts'],
    observationType: 'feature',
  });
  const succ = makeSession({
    id: 's',
    startTime: now + 60_000,
    endTime: now + 120_000,
    keyFiles: ['src/auth.ts'],
    observationType: 'bugfix',
  });
  const unrelated = makeSession({
    id: 'u',
    startTime: now - 5000,
    endTime: now - 1000,
    keyFiles: ['src/widget.tsx'],
  });
  const n = getCausalNeighbors('c', [center, pred, succ, unrelated]);
  assert.ok(n);
  assert.deepEqual(
    n!.predecessors.map((p) => p.sessionId),
    ['p'],
  );
  assert.deepEqual(
    n!.successors.map((s) => s.sessionId),
    ['s'],
  );
  assert.equal(n!.successors[0].label, 'introduced_issue_fixed_by');
});

test('getCausalNeighbors — outside window is excluded', () => {
  const now = Date.now();
  const center = makeSession({
    id: 'c',
    startTime: now - 10_000,
    endTime: now,
    keyFiles: ['src/x.ts'],
  });
  const veryOld = makeSession({
    id: 'old',
    startTime: now - CAUSAL_WINDOW_MS * 2 - 10_000,
    endTime: now - CAUSAL_WINDOW_MS * 2,
    keyFiles: ['src/x.ts'],
  });
  const n = getCausalNeighbors('c', [center, veryOld]);
  assert.ok(n);
  assert.equal(n!.predecessors.length, 0);
});

test('getCausalNeighbors — returns undefined for unknown id', () => {
  assert.equal(getCausalNeighbors('nope', []), undefined);
});

test('getCausalNeighbors — empty keyFiles yields no neighbours', () => {
  const center = makeSession({ id: 'c', keyFiles: [] });
  const n = getCausalNeighbors('c', [center]);
  assert.ok(n);
  assert.equal(n!.predecessors.length, 0);
  assert.equal(n!.successors.length, 0);
});
