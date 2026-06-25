import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, RedactOptions } from '../redactor';

const ON: RedactOptions = {
  redactSecrets: true,
  honorPrivateTags: true,
  detectHighEntropy: true,
};
const OFF: RedactOptions = { redactSecrets: true, honorPrivateTags: true };

test('entropy — high-entropy mixed token is redacted when enabled', () => {
  // 32-char random token mixing upper/lower/digits — no named rule matches it.
  const token = 'Xk9Qp2Lm7Za4Rb1Tc8Wd5Ye3Uf6Vg0H';
  const r = redact(`opaque session = ${token}`, ON);
  assert.match(r.text, /\[REDACTED:high-entropy\]#[a-f0-9]{16}/);
  assert.ok(!r.text.includes(token));
  assert.ok(r.categories.includes('high-entropy'));
});

test('entropy — pass is off by default (no detectHighEntropy flag)', () => {
  const token = 'Xk9Qp2Lm7Za4Rb1Tc8Wd5Ye3Uf6Vg0H';
  const r = redact(`opaque session = ${token}`, OFF);
  assert.ok(r.text.includes(token));
});

test('entropy — lowercase hex git SHA is spared (only 2 char classes)', () => {
  const sha = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'; // 40-char sha1, lower hex
  const r = redact(`commit ${sha}`, ON);
  assert.ok(r.text.includes(sha), 'git SHA must not be redacted by entropy pass');
});

test('entropy — ordinary prose is untouched', () => {
  const prose = 'The quick brown fox refactors the authentication module today.';
  const r = redact(prose, ON);
  assert.equal(r.text, prose);
});

test('entropy — base64 credential blob is redacted', () => {
  const blob = 'dXNlcjpzdXBlclNlY3JldFBhc3N3b3JkMTIzNDU2Nzg5MA==';
  const r = redact(`auth blob ${blob}`, ON);
  assert.ok(!r.text.includes(blob));
  assert.match(r.text, /\[REDACTED:high-entropy\]/);
});

test('entropy — short tokens below the length floor are spared', () => {
  const short = 'Ab1Cd2Ef3'; // 9 chars, < 24
  const r = redact(`id ${short}`, ON);
  assert.ok(r.text.includes(short));
});
