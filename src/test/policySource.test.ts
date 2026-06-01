import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../redactor';
import { clearPolicyRedactionRules, refreshPolicyRedactionRules } from '../policySource';

test('policy source rules load and apply to redaction', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => [
      {
        name: 'corp-ticket',
        pattern: 'CORP-[A-Z0-9]{8}',
        replacement: '[REDACTED:corp-ticket]',
        flags: 'g',
      },
    ],
  })) as unknown as typeof fetch;

  try {
    const count = await refreshPolicyRedactionRules('https://policy.example/rules.json');
    assert.equal(count, 1);

    const result = redact('ticket CORP-ABCD1234', { redactSecrets: true, honorPrivateTags: true });
    assert.match(result.text, /\[REDACTED:corp-ticket\]/);
    assert.match(result.categories.join(','), /policy:corp-ticket/);
  } finally {
    globalThis.fetch = originalFetch;
    clearPolicyRedactionRules();
  }
});
