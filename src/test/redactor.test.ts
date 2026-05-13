import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, RedactOptions } from '../redactor';

const OPTS: RedactOptions = { redactSecrets: true, honorPrivateTags: true };

test('redactor — AWS access key id', () => {
  const r = redact('aws_id: AKIAIOSFODNN7EXAMPLE is here', OPTS);
  assert.match(r.text, /\[REDACTED:aws-access-key\]/);
  assert.ok(r.redactionCount >= 1);
});

test('redactor — GitHub token ghp_', () => {
  const r = redact('token=ghp_1234567890abcdefghijklmnopqrstuvwxyz1234', OPTS);
  assert.match(r.text, /\[REDACTED:github-token\]|\[REDACTED\]/);
});

test('redactor — OpenAI-style sk- key', () => {
  const r = redact('OPENAI sk-abcDEF1234567890abcDEF1234567890abcDEF1234567890XX', OPTS);
  assert.match(r.text, /\[REDACTED:openai-key\]/);
});

test('redactor — JWT', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123DEF456xyz';
  const r = redact('Authorization: Bearer ' + jwt, OPTS);
  assert.match(r.text, /\[REDACTED:jwt\]/);
});

test('redactor — PEM block', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  const r = redact(pem, OPTS);
  assert.match(r.text, /\[REDACTED:private-key-block\]/);
});

test('redactor — password= assignment', () => {
  const r = redact('password=hunter2abc next line', OPTS);
  assert.match(r.text, /\[REDACTED\]/);
});

test('redactor — email', () => {
  const r = redact('contact alice@example.com for help', OPTS);
  assert.match(r.text, /\[REDACTED:email\]/);
});

test('redactor — IPv4', () => {
  const r = redact('connect to 192.168.1.42 now', OPTS);
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
  const s = 'conn=DefaultEndpointsProtocol=https;AccountName=mystore;AccountKey=abc123xyz==;EndpointSuffix=core.windows.net';
  const r = redact(s, OPTS);
  assert.match(r.text, /\[REDACTED:azure-storage-conn\]/);
  assert.doesNotMatch(r.text, /abc123xyz==/);
});

test('redactor — Azure Service Bus connection string', () => {
  const s = 'Endpoint=sb://foo.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccessKey=abcKEY123==;EntityPath=q1';
  const r = redact(s, OPTS);
  assert.match(r.text, /\[REDACTED:azure-sb-conn\]/);
});

test('redactor — Azure Cosmos DB connection string', () => {
  const s = 'AccountEndpoint=https://foo.documents.azure.com:443/;AccountKey=superSecret==';
  const r = redact(s, OPTS);
  assert.match(r.text, /\[REDACTED:azure-cosmos-conn\]/);
});

test('redactor — Azure SQL connection string', () => {
  const s = 'Server=tcp:foo.database.windows.net,1433;Database=d;User ID=u;Password=P@ssw0rd!xyz;Encrypt=true';
  const r = redact(s, OPTS);
  assert.match(r.text, /\[REDACTED:azure-sql-conn\]/);
});

test('redactor — Azure SAS token', () => {
  // Use only params in the SAS rule's allowed set; need >=3 consecutive matches.
  const s = 'https://foo.blob.core.windows.net/c/b?sv=2021-06-08&sp=r&sig=abc123XYZ&se=2025-01-01';
  const r = redact(s, OPTS);
  assert.match(r.text, /\[REDACTED:azure-sas\]/);
});

test('redactor — Azure storage account key (88-char base64)', () => {
  const key = 'A'.repeat(86) + '==';
  const r = redact('key: ' + key + ' end', OPTS);
  assert.match(r.text, /\[REDACTED:azure-storage-key\]/);
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
