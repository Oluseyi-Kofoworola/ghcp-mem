import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRequest,
  estimateAttachTokens,
  extractMentionedPaths,
  recommend,
  renderRecommendation,
} from '../router';

test('classifyRequest — lookup verbs route to lookup intent', () => {
  assert.equal(classifyRequest('why did we pick bcrypt?'), 'lookup');
  assert.equal(classifyRequest('explain the auth flow'), 'lookup');
});

test('classifyRequest — modify verbs route to modify intent', () => {
  assert.equal(classifyRequest('add a new field to User model'), 'modify');
  assert.equal(classifyRequest('rename hashPassword to hashSecret'), 'modify');
});

test('classifyRequest — investigate verbs route to investigate intent', () => {
  assert.equal(classifyRequest('find where User is used'), 'investigate');
  assert.equal(classifyRequest('locate the api handler'), 'investigate');
});

test('classifyRequest — mixed and unknown branches', () => {
  assert.equal(classifyRequest('explain X then add error handling'), 'mixed');
  assert.equal(classifyRequest(''), 'unknown');
  assert.equal(classifyRequest('asdf qwerty zxcv'), 'unknown');
});

test('extractMentionedPaths — file paths and symbol IDs are extracted', () => {
  const out = extractMentionedPaths('please update src/auth.ts and src/auth.ts#hashPassword now');
  assert.ok(out.includes('src/auth.ts'));
  assert.ok(out.includes('src/auth.ts#hashPassword'));
});

test('estimateAttachTokens — chars-per-token heuristic with default fallback', () => {
  assert.equal(estimateAttachTokens(undefined), 2000);
  assert.equal(estimateAttachTokens(0), 2000);
  assert.equal(estimateAttachTokens(4000), 1000);
});

test('recommend — lookup intent recommends ghcpMem_snippets when decision question', () => {
  const r = recommend('why did we decide to use postgres?');
  assert.equal(r.intent, 'lookup');
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].kind, 'mcp');
  if (r.actions[0].kind === 'mcp') {
    assert.equal(r.actions[0].tool, 'ghcpMem_snippets');
  }
});

test('recommend — lookup with mentioned file picks ghcpMem_entity', () => {
  const r = recommend('explain how src/auth.ts works');
  assert.equal(r.intent, 'lookup');
  assert.equal(r.actions[0].kind, 'mcp');
  if (r.actions[0].kind === 'mcp') {
    assert.equal(r.actions[0].tool, 'ghcpMem_entity');
    assert.equal(r.actions[0].args.key, 'src/auth.ts');
  }
});

test('recommend — modify intent recommends attach + entity lookup', () => {
  const r = recommend('add caching to src/api.ts');
  assert.equal(r.intent, 'modify');
  assert.ok(r.actions.some((a) => a.kind === 'attach'));
  assert.ok(r.actions.some((a) => a.kind === 'mcp'));
});

test('recommend — investigate intent recommends snippet search', () => {
  const r = recommend('find where rate limiting is implemented');
  assert.equal(r.intent, 'investigate');
  assert.equal(r.actions[0].kind, 'mcp');
  if (r.actions[0].kind === 'mcp') {
    assert.equal(r.actions[0].tool, 'ghcpMem_snippets');
  }
});

test('recommend — mixed intent does cheap lookup first then attach', () => {
  const r = recommend('explain src/x.ts then add a logger');
  assert.equal(r.intent, 'mixed');
  assert.equal(r.actions[0].kind, 'mcp');
  if (r.actions[0].kind === 'mcp') {
    assert.equal(r.actions[0].tool, 'ghcpMem_search');
  }
  assert.ok(r.actions.some((a) => a.kind === 'attach'));
});

test('recommend — unknown intent falls back to cheap search probe', () => {
  const r = recommend('hmm something weird');
  assert.equal(r.intent, 'unknown');
  assert.equal(r.actions[0].kind, 'mcp');
  if (r.actions[0].kind === 'mcp') {
    assert.equal(r.actions[0].tool, 'ghcpMem_search');
  }
});

test('recommend — when MCP unavailable, fall back to attach-only with rationale', () => {
  const r = recommend('why did we pick bcrypt', { mcpAvailable: false });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].kind, 'attach');
  assert.ok(r.reasoning.toLowerCase().includes('no mcp server'));
});

test('recommend — reasoning surfaces estimated savings vs naive attach', () => {
  const r = recommend('why did we choose postgres for billing service in src/billing.ts', {
    fileSizes: { 'src/billing.ts': 80000 },
  });
  // 80kB ≈ 20k tokens; MCP lookups are <1k so saving must be reported.
  assert.ok(r.naiveAttachTokens >= 20000);
  assert.ok(r.estimatedTotalTokens < r.naiveAttachTokens);
  assert.ok(/saving/i.test(r.reasoning));
});

test('renderRecommendation — renders the routing markdown block', () => {
  const r = recommend('why did we pick bcrypt');
  const md = renderRecommendation(r);
  assert.ok(md.includes('## 🧭 Routing'));
  assert.ok(md.includes('MCP'));
});
