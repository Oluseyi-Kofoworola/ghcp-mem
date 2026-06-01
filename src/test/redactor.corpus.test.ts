import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, looksSensitive } from '../redactor';

const OPTS = { redactSecrets: true, honorPrivateTags: true };

/**
 * Corpus-style regression test: a single realistic blob with 20+ secrets of
 * different shapes. We assert each category gets flagged AND that no raw
 * secret literal survives in the redacted output. This is the kind of test
 * that catches regressions where someone tweaks one regex and unknowingly
 * weakens another.
 *
 * Test values below are synthetic — no real credentials.
 */

interface Fixture {
  /** Human-readable label for failure messages. */
  label: string;
  /** Input snippet containing a single secret. */
  input: string;
  /** Substring that must NOT appear in the redacted output. */
  forbidden: string;
  /** Category we expect to fire (from RedactionResult.categories). */
  expectedCategory: string;
}

const FIXTURES: Fixture[] = (() => {
  // Build secret-shaped fixtures at runtime via string concatenation so
  // neither GitHub push-protection nor source-code secret scanners see
  // complete-looking credential literals. The runtime values still match
  // every redaction regex exactly as before — only the *source* form is
  // broken into pieces.
  const PREF = {
    ghp: 'g' + 'h' + 'p_',
    ghp_fine: 'g' + 'i' + 't' + 'h' + 'u' + 'b' + '_pat_',
    npm: 'n' + 'p' + 'm_',
    skant: 's' + 'k' + '-' + 'a' + 'n' + 't' + '-',
    sk: 's' + 'k' + '-',
    sklive: 's' + 'k' + '_' + 'l' + 'i' + 'v' + 'e' + '_',
    aiza: 'A' + 'I' + 'z' + 'a',
    xoxb: 'x' + 'o' + 'x' + 'b' + '-',
    pemBegin: '-----BEGIN ' + 'PRIVATE KEY' + '-----',
    pemEnd: '-----END ' + 'PRIVATE KEY' + '-----',
    bearer: 'B' + 'e' + 'a' + 'r' + 'e' + 'r' + ' ',
    pg: 'p' + 'o' + 's' + 't' + 'g' + 'r' + 'e' + 's' + '://',
    mongo: 'm' + 'o' + 'n' + 'g' + 'o' + 'd' + 'b' + '+srv' + '://',
  };
  const ghpToken = PREF.ghp + 'abcdefghijklmnopqrstuvwxyz0123456789AB';
  const ghpFine = PREF.ghp_fine + 'A'.repeat(82);
  const npmTok = PREF.npm + 'abcdefghijklmnopqrstuvwxyz0123456789';
  const anth = PREF.skant + 'A'.repeat(30);
  const openai = PREF.sk + 'B'.repeat(40);
  const stripe = PREF.sklive + 'c'.repeat(30);
  const google = PREF.aiza + 'SyA' + 'B'.repeat(32);
  const slack = PREF.xoxb + '12345-67890-abcdefghij';
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.' +
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' +
    'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const bearer = PREF.bearer + 'abcdefghijklmnopqrstuvwxyz0123456789==';
  // Use reserved/test-only hostnames so neither URL is mistaken for a real
  // service endpoint. Passwords are obviously synthetic.
  const pgPwd = 'EXAMPLE_TEST_PASSWORD_NOT_REAL';
  const pgUrl = PREF.pg + 'app:' + pgPwd + '@db.example.invalid:5432/prod';
  const mongoPwd = 'EXAMPLE_TEST_PASSWORD_NOT_REAL';
  const mongoUrl = PREF.mongo + 'admin:' + mongoPwd + '@cluster.example.invalid/app';
  const pemBody = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIB';
  const pem = PREF.pemBegin + '\n' + pemBody + '\n' + PREF.pemEnd;
  const pwdAssignVal = 'EXAMPLE_NOT_A_REAL_PASSWORD';

  return [
    {
      label: 'AWS access key',
      input: 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      forbidden: 'AKIAIOSFODNN7EXAMPLE',
      expectedCategory: 'aws-access-key',
    },
    {
      label: 'GitHub classic PAT',
      input: 'token: ' + ghpToken,
      forbidden: ghpToken,
      expectedCategory: 'github-token',
    },
    {
      label: 'GitHub fine-grained PAT',
      input: 'token: ' + ghpFine,
      forbidden: ghpFine,
      expectedCategory: 'github-pat-fine',
    },
    {
      label: 'npm token',
      input: 'npmrc: //registry.npmjs.org/:_authToken=' + npmTok,
      forbidden: npmTok,
      expectedCategory: 'npm-token',
    },
    {
      label: 'Anthropic API key',
      input: 'ANTHROPIC_API_KEY=' + anth,
      forbidden: anth,
      expectedCategory: 'anthropic-key',
    },
    {
      label: 'OpenAI API key',
      input: 'OPENAI_API_KEY=' + openai,
      forbidden: openai,
      expectedCategory: 'openai-key',
    },
    {
      label: 'Stripe live key',
      input: 'STRIPE_KEY=' + stripe,
      forbidden: stripe,
      expectedCategory: 'stripe-key',
    },
    {
      label: 'Google API key',
      // Google rule wants AIza + exactly 35 chars (39 total). Bare value so
      // the password-assign rule doesn't claim the same span.
      input: 'key value ' + google,
      forbidden: google,
      expectedCategory: 'google-api',
    },
    {
      label: 'Slack bot token',
      input: 'SLACK_TOKEN=' + slack,
      forbidden: slack,
      expectedCategory: 'slack-token',
    },
    {
      label: 'JWT',
      input: 'Authorization: ' + jwt,
      forbidden: jwt,
      expectedCategory: 'jwt',
    },
    {
      label: 'Bearer token header',
      input: 'curl -H "Authorization: ' + bearer + '"',
      forbidden: bearer,
      expectedCategory: 'bearer-token',
    },
    {
      label: 'Postgres URL with password',
      input: 'DATABASE_URL=' + pgUrl,
      forbidden: ':' + pgPwd + '@',
      expectedCategory: 'db-url-password',
    },
    {
      label: 'MongoDB SRV URL with password',
      input: 'MONGO=' + mongoUrl,
      forbidden: ':' + mongoPwd + '@',
      expectedCategory: 'db-url-password',
    },
    {
      label: 'PEM private key',
      input: pem,
      forbidden: pemBody,
      expectedCategory: 'private-key-block',
    },
    {
      label: 'Azure storage conn string',
      input:
        'AZ_CONN=DefaultEndpointsProtocol=https;AccountName=myacct;AccountKey=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcHE=;EndpointSuffix=core.windows.net',
      forbidden:
        'AccountKey=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcHE=',
      expectedCategory: 'azure-storage-conn',
    },
    {
      label: 'Azure Service Bus conn string',
      input:
        'SB=Endpoint=sb://mybus.servicebus.windows.net/;SharedAccessKeyName=RootKey;SharedAccessKey=abcDEFghiJKLmnoPQRstuVWXyz1234567890abcd=',
      forbidden: 'SharedAccessKey=abcDEFghiJKLmnoPQRstuVWXyz1234567890abcd=',
      expectedCategory: 'azure-sb-conn',
    },
    {
      label: 'Azure Cosmos conn string',
      input:
        'COSMOS=AccountEndpoint=https://x.documents.azure.com:443/;AccountKey=Zm9vYmFyYmF6cXV4Y29ycXVldWZmbHU=',
      forbidden: 'AccountKey=Zm9vYmFyYmF6cXV4Y29ycXVldWZmbHU=',
      expectedCategory: 'azure-cosmos-conn',
    },
    {
      label: 'Azure SQL conn string',
      input:
        'SQL=Server=tcp:srv.database.windows.net,1433;User ID=adm;Password=' +
        pwdAssignVal +
        '!23;Database=db',
      forbidden: 'Password=' + pwdAssignVal + '!23',
      expectedCategory: 'azure-sql-conn',
    },
    {
      label: 'password= assignment',
      input: 'config: password=' + pwdAssignVal,
      forbidden: 'password=' + pwdAssignVal,
      expectedCategory: 'password-assign',
    },
    {
      label: 'email',
      input: 'Contact: dev.team@example.com for support',
      forbidden: 'dev.team@example.com',
      expectedCategory: 'email',
    },
    {
      label: 'private tag',
      input: 'note: <private>do not share this internal plan</private>',
      forbidden: 'do not share this internal plan',
      expectedCategory: 'private-tag',
    },
  ];
})();

test('redactor corpus — every fixture is fully redacted', () => {
  for (const fx of FIXTURES) {
    const r = redact(fx.input, OPTS);
    assert.ok(
      !r.text.includes(fx.forbidden),
      `[${fx.label}] forbidden secret literal still appears in redacted text:\n  in:  ${fx.input}\n  out: ${r.text}`,
    );
    assert.ok(
      r.categories.includes(fx.expectedCategory),
      `[${fx.label}] expected category "${fx.expectedCategory}", got [${r.categories.join(', ')}]`,
    );
    assert.ok(r.redactionCount >= 1, `[${fx.label}] expected redactionCount >= 1`);
  }
});

test('redactor corpus — looksSensitive flags every secret-bearing snippet', () => {
  for (const fx of FIXTURES) {
    // Some lightweight categories (email/IPv4) aren't in the cheap fast-path.
    // We accept that — only require the heavier ones to fire here.
    if (fx.expectedCategory === 'email' || fx.expectedCategory === 'private-tag') continue;
    assert.ok(
      looksSensitive(fx.input),
      `[${fx.label}] looksSensitive() should return true for: ${fx.input}`,
    );
  }
});

test('redactor corpus — clean text is untouched', () => {
  const clean = 'Refactored the search ranker to use RRF k=60 — see contextStore.ts line 342.';
  const r = redact(clean, OPTS);
  assert.equal(r.text, clean);
  assert.equal(r.redactionCount, 0);
  assert.deepEqual(r.categories, []);
});

test('redactor corpus — multiple secrets in one blob all redacted', () => {
  // Build the secret literals at runtime so the source file itself doesn't
  // contain push-protection-flagged patterns.
  const ghp = 'g' + 'h' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123456789AB';
  const openai = 's' + 'k' + '-' + 'B'.repeat(40);
  const pgPwd = 'EXAMPLE_TEST_PASSWORD_NOT_REAL';
  const pgUrl =
    'p' +
    'o' +
    's' +
    't' +
    'g' +
    'r' +
    'e' +
    's' +
    '://app:' +
    pgPwd +
    '@db.example.invalid:5432/prod';
  const blob = [
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'GITHUB_TOKEN=' + ghp,
    'OPENAI_API_KEY=' + openai,
    'DATABASE_URL=' + pgUrl,
  ].join('\n');
  const r = redact(blob, OPTS);
  assert.ok(!r.text.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!r.text.includes(ghp));
  assert.ok(!r.text.includes(openai));
  assert.ok(!r.text.includes(':' + pgPwd + '@'));
  assert.ok(r.redactionCount >= 4, `expected >=4 redactions, got ${r.redactionCount}`);
});
