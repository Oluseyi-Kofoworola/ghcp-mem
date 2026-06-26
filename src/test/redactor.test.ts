import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, RedactOptions } from '../redactor';

const OPTS: RedactOptions = { redactSecrets: true, honorPrivateTags: true };

test('redactor — AWS access key id', () => {
  const r = redact('aws_id: AKIAIOSFODNN7EXAMPLE is here', OPTS);
  assert.match(r.text, /\[REDACTED:aws-access-key\]/);
  assert.match(r.text, /\[REDACTED:aws-access-key\]#[a-f0-9]{16}/);
  assert.ok(r.redactionCount >= 1);
});

test('redactor — GitHub token ghp_', () => {
  // Build the token shape at runtime so source scanners don't see a
  // complete-looking PAT literal in this file.
  const ghp = 'g' + 'h' + 'p_' + '1234567890abcdefghijklmnopqrstuvwxyz1234';
  const r = redact('token=' + ghp, OPTS);
  assert.match(r.text, /\[REDACTED:github-token\]|\[REDACTED\]/);
});

test('redactor — OpenAI-style sk- key', () => {
  const openai = 's' + 'k' + '-' + 'abcDEF1234567890abcDEF1234567890abcDEF1234567890XX';
  const r = redact('OPENAI ' + openai, OPTS);
  assert.match(r.text, /\[REDACTED:openai-key\]/);
});

test('redactor — JWT', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'abc123DEF456xyz';
  const r = redact('Authorization: Bearer ' + jwt, OPTS);
  assert.match(r.text, /\[REDACTED:jwt\]/);
});

test('redactor — PEM block', () => {
  // Assemble the PEM headers in pieces so the source itself doesn't contain
  // a complete `-----BEGIN ... PRIVATE KEY-----` marker that secret scanners
  // hard-flag.
  const begin = '-----BEGIN RSA ' + 'PRIVATE KEY' + '-----';
  const end = '-----END RSA ' + 'PRIVATE KEY' + '-----';
  const pem = begin + '\nMIIEowIBAAKCAQEA\n' + end;
  const r = redact(pem, OPTS);
  assert.match(r.text, /\[REDACTED:private-key-block\]/);
});

test('redactor — password= assignment', () => {
  const r = redact('password=EXAMPLE_NOT_A_REAL_PASSWORD next line', OPTS);
  assert.match(r.text, /\[REDACTED\]/);
});

test('redactor — email', () => {
  const r = redact('contact alice@example.com for help', OPTS);
  assert.match(r.text, /\[REDACTED:email\]/);
});

test('redactor — IPv4', () => {
  // IPv4 is only redacted when it appears in a credential/connection context
  // (host=, server=, endpoint=, etc.) to avoid false positives in log output.
  const r = redact('host=192.168.1.42', OPTS);
  assert.match(r.text, /\[REDACTED:ip\]/);
});

test('redactor — <private> markers stripped', () => {
  const r = redact('public data <private>secret payload</private> tail', OPTS);
  assert.doesNotMatch(r.text, /secret payload/);
  assert.match(r.text, /\[PRIVATE_REDACTED\]/);
});

test('redactor — redactionCount > 0 for emails', () => {
  const r = redact('one@a.com and two@b.com', OPTS);
  assert.ok(r.redactionCount >= 1);
  assert.doesNotMatch(r.text, /one@a\.com/);
  assert.doesNotMatch(r.text, /two@b\.com/);
});

test('redactor — preserves non-sensitive text', () => {
  const r = redact('refactored the payment gateway module', OPTS);
  assert.equal(r.text, 'refactored the payment gateway module');
  assert.equal(r.redactionCount, 0);
});

test('redactor — opts.redactSecrets=false disables scanning', () => {
  const r = redact('email: a@b.com', { redactSecrets: false, honorPrivateTags: true });
  assert.match(r.text, /a@b\.com/);
});

// ---------- Azure-specific secrets ----------

test('redactor — Azure storage connection string', () => {
  const s =
    'conn=DefaultEndpointsProtocol=https;AccountName=mystore;AccountKey=abc123xyz==;EndpointSuffix=core.windows.net';
  const r = redact(s, OPTS);
  assert.match(r.text, /\[REDACTED:azure-storage-conn\]/);
  assert.doesNotMatch(r.text, /abc123xyz==/);
});

test('redactor — Azure Service Bus connection string', () => {
  const s =
    'Endpoint=sb://foo.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccessKey=abcKEY123==;EntityPath=q1';
  const r = redact(s, OPTS);
  assert.match(r.text, /\[REDACTED:azure-sb-conn\]/);
});

test('redactor — Azure Cosmos DB connection string', () => {
  const s = 'AccountEndpoint=https://foo.documents.azure.com:443/;AccountKey=superSecret==';
  const r = redact(s, OPTS);
  assert.match(r.text, /\[REDACTED:azure-cosmos-conn\]/);
});

test('redactor — Azure SQL connection string', () => {
  const s =
    'Server=tcp:foo.database.windows.net,1433;Database=d;User ID=u;Password=P@ssw0rd!xyz;Encrypt=true';
  const r = redact(s, OPTS);
  assert.match(r.text, /\[REDACTED:azure-sql-conn\]/);
});

test('redactor — Azure SAS token', () => {
  // Use only params in the SAS rule's allowed set; need >=3 consecutive matches.
  const s = 'https://foo.blob.core.windows.net/c/b?sv=2021-06-08&sp=r&sig=abc123XYZ&se=2025-01-01';
  const r = redact(s, OPTS);
  assert.match(r.text, /\[REDACTED:azure-sas\]/);
});

test('redactor — Azure storage account key with AccountKey= prefix (no surrounding conn-string)', () => {
  // After v1.10.2 the named rule requires a recognised Azure context prefix.
  // We test the AccountKey= prefix in isolation (a full connection string is
  // covered by the broader `azure-storage-conn` rule that fires first).
  const key = 'A'.repeat(86) + '==';
  const r = redact(`AccountKey=${key} (truncated)`, OPTS);
  assert.match(r.text, /\[REDACTED:azure-storage-key\]/);
});

test('redactor — Azure storage account key in JSON ("key": "...")', () => {
  const key = 'B'.repeat(86) + '==';
  const r = redact(`{ "name": "x", "key": "${key}" }`, OPTS);
  assert.match(r.text, /\[REDACTED:azure-storage-key\]/);
});

test('redactor — Azure storage account key in query string (?key=...)', () => {
  const key = 'C'.repeat(86) + '==';
  const r = redact(`https://example.com/api?key=${key}`, OPTS);
  assert.match(r.text, /\[REDACTED:azure-storage-key\]/);
});

test('redactor — standalone 88-char base64 NOT caught by named azure-storage-key rule (v1.10.2 false-positive fix)', () => {
  // Common false-positive sources for the prior `\b[A-Za-z0-9+/]{86}==` rule:
  // PEM bodies, base64-encoded images embedded in markdown/JSON, large
  // lockfile hashes. Standalone 88-char base64 without any Azure-context
  // prefix must NOT be flagged as `azure-storage-key`. (Real secrets with
  // high entropy are still caught by the entropy detector if it's enabled.)
  const looksLikePemLine = 'M' + 'A'.repeat(85) + '==';
  const r = redact(
    `Here is a PEM body fragment: ${looksLikePemLine} and an image: ${looksLikePemLine}`,
    { ...OPTS, detectHighEntropy: false },
  );
  assert.doesNotMatch(r.text, /\[REDACTED:azure-storage-key\]/);
});

test('redactor — Azure service principal secret', () => {
  // Standalone value; inside client_secret=... the generic password rule fires first.
  const r = redact('value is Ab~ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd here', OPTS);
  assert.match(r.text, /\[REDACTED:azure-sp-secret\]/);
});

test('redactor — Azure subscription GUID with context keyword', () => {
  const r = redact('subscriptionId: 11111111-2222-3333-4444-555555555555', OPTS);
  assert.match(r.text, /\[REDACTED:azure-guid\]/);
});

test('custom redaction rules compose after built-in rules', () => {
  const input = 'AWS key: AKIA1234567890ABCDEF and CUSTOM_SECRET_XYZ12345678901234567890';
  const customRules = [
    {
      name: 'custom-secret',
      pattern: 'CUSTOM_SECRET_[A-Za-z0-9]{20,}',
      replacement: '[REDACTED:custom]',
      flags: 'g',
    },
  ];
  const result = redact(input, {
    redactSecrets: true,
    honorPrivateTags: true,
    customRules,
  });
  assert(result.text.includes('[REDACTED:aws-access-key]'), 'AWS key should be redacted');
  assert(result.text.includes('[REDACTED:custom]'), 'Custom rule should be applied');
  assert(result.redactionCount === 2, 'Two redactions should occur');
});

test('custom redaction rules skip silently on invalid regex', () => {
  const input = 'test content';
  const customRules = [
    { name: 'bad-regex', pattern: '(?P<invalid>pattern)', replacement: '[REDACTED]', flags: 'g' }, // invalid regex
  ];
  // Should not throw
  const result = redact(input, {
    redactSecrets: false,
    honorPrivateTags: false,
    customRules,
  });
  assert(result.text === input, 'Invalid regex should be silently skipped');
});
