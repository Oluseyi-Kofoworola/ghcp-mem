import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, intentWeights } from '../queryIntent';

test('classifyIntent — empty/whitespace queries are general', () => {
  assert.equal(classifyIntent(''), 'general');
  assert.equal(classifyIntent('   '), 'general');
});

test('classifyIntent — decision phrasing', () => {
  assert.equal(classifyIntent('why did we pick bcrypt?'), 'decision');
  assert.equal(classifyIntent('what did we decide about caching'), 'decision');
  assert.equal(classifyIntent('what is the rationale for this design'), 'decision');
  assert.equal(classifyIntent('architecture decision for the queue'), 'decision');
});

test('classifyIntent — problem phrasing', () => {
  assert.equal(classifyIntent("what's the bug in auth.ts"), 'problem');
  assert.equal(classifyIntent('how did we fix the redis timeout'), 'problem');
  assert.equal(classifyIntent('did we hit this stack trace before'), 'problem');
  assert.equal(classifyIntent('the build is broken'), 'problem');
});

test('classifyIntent — recent phrasing', () => {
  // The actual RECENT_PATTERNS regexes (src/queryIntent.ts:36) catch
  // specific shapes — "list recent sessions" isn't one of them; "what was I
  // working on" is. Tests pin the documented behaviour, not free-text
  // generalisations.
  assert.equal(classifyIntent('what was I working on yesterday'), 'recent');
  assert.equal(classifyIntent('what was I doing today'), 'recent');
  assert.equal(classifyIntent('show me the latest session'), 'recent');
  assert.equal(classifyIntent('where did I leave off'), 'recent');
});

test('classifyIntent — entity-shaped queries (short, identifier-dominant)', () => {
  assert.equal(classifyIntent('hashPassword'), 'entity');
  assert.equal(classifyIntent('src/auth.ts'), 'entity');
  assert.equal(classifyIntent('user_service module'), 'entity');
});

test('classifyIntent — long prose containing an identifier falls back to general', () => {
  // > 4 tokens — identifier rule should not fire.
  assert.equal(
    classifyIntent('please tell me everything about hashPassword and how it differs'),
    'general',
  );
});

test('classifyIntent — generic free-text falls back to general', () => {
  assert.equal(classifyIntent('hello world'), 'general');
  assert.equal(classifyIntent('just some notes'), 'general');
});

test('classifyIntent — decision pattern takes priority over identifier presence', () => {
  // Contains both a decision cue and an identifier — decision wins.
  assert.equal(classifyIntent('why did we pick bcrypt'), 'decision');
});

test('intentWeights — decision boosts decisions, problem boosts problems', () => {
  const dec = intentWeights('decision');
  assert.ok(dec.decisionBoost > 0);
  assert.equal(dec.problemBoost, 0);
  const prob = intentWeights('problem');
  assert.equal(prob.decisionBoost, 0);
  assert.ok(prob.problemBoost > 0);
});

test('intentWeights — recent triples recency multiplier', () => {
  assert.equal(intentWeights('recent').recencyMultiplier, 3.0);
});

test('intentWeights — entity sharpens keyword weight', () => {
  assert.ok(intentWeights('entity').keywordWeight > intentWeights('general').keywordWeight);
});
