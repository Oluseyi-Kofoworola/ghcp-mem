/**
 * Unit tests for azureContext.ts
 *
 * The `az` CLI is mocked via monkey-patching execFile so these tests run
 * fully offline with no Azure subscription required.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { _resetAzureContextCache } from '../azureContext';

// ── Helpers ──────────────────────────────────────────────────────────────────

type ExecFileFn = (
  file: string,
  args: string[],
  opts: object,
  cb: (err: Error | null, stdout: string) => void
) => { on: (event: string, cb: () => void) => void };

let originalExecFile: ExecFileFn;
let execFileMock: ExecFileFn | undefined;

/** Replace child_process.execFile with a controllable stub. */
function installMock(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cp = require('child_process');
  originalExecFile = cp.execFile;
  cp.execFile = (...args: Parameters<ExecFileFn>) => {
    if (execFileMock) return execFileMock(...args);
    return originalExecFile(...args);
  };
}

function restoreMock(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cp = require('child_process');
  cp.execFile = originalExecFile;
}

function makeMock(responses: Record<string, string | null>): ExecFileFn {
  return (_file, args, _opts, cb) => {
    const key = args.join(' ');
    const response = Object.entries(responses).find(([k]) => key.includes(k));
    if (response && response[1] !== null) {
      setImmediate(() => cb(null, response[1] as string));
    } else {
      setImmediate(() => cb(new Error('az not found'), ''));
    }
    return { on: () => {} };
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

before(() => installMock());
after(() => restoreMock());

test('azureContext — returns skeleton when az is unavailable', async () => {
  _resetAzureContextCache();
  execFileMock = makeMock({ 'account show': null });
  // Lazy-import after mock is installed.
  const { captureAzureContext } = await import('../azureContext');
  const snap = await captureAzureContext();
  assert.ok(snap.notes?.includes('az CLI unavailable'));
  assert.equal(snap.subscriptionId, undefined);
});

test('azureContext — parses subscription from az account show', async () => {
  _resetAzureContextCache();
  const fakeAccount = JSON.stringify({
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    name: 'contoso-dev',
    tenantId: '11111111-1111-1111-1111-111111111111',
  });
  execFileMock = makeMock({
    'account show': fakeAccount,
    'configure --list-defaults': '[]',
  });
  const { captureAzureContext } = await import('../azureContext');
  const snap = await captureAzureContext();
  assert.equal(snap.subscriptionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(snap.subscriptionName, 'contoso-dev');
  assert.equal(snap.tenantId, '11111111-1111-1111-1111-111111111111');
});

test('azureContext — reads default resource group from az configure', async () => {
  _resetAzureContextCache();
  const fakeAccount = JSON.stringify({ id: 'sub-1', name: 'my-sub', tenantId: 't-1' });
  const fakeDefaults = JSON.stringify([
    { name: 'group', value: 'rg-prod' },
    { name: 'location', value: 'westeurope' },
  ]);
  execFileMock = makeMock({
    'account show': fakeAccount,
    'configure --list-defaults': fakeDefaults,
  });
  const { captureAzureContext } = await import('../azureContext');
  const snap = await captureAzureContext();
  assert.equal(snap.resourceGroup, 'rg-prod');
  assert.equal(snap.defaultLocation, 'westeurope');
});

test('azureContext — includeResources lists resource IDs', async () => {
  _resetAzureContextCache();
  const fakeAccount = JSON.stringify({ id: 'sub-1', name: 'my-sub', tenantId: 't-1' });
  const fakeResources = JSON.stringify(['/subscriptions/sub-1/resourceGroups/rg-prod/providers/foo/bar/baz']);
  execFileMock = makeMock({
    'account show': fakeAccount,
    'configure --list-defaults': '[]',
    'resource list': fakeResources,
  });
  const { captureAzureContext } = await import('../azureContext');
  const snap = await captureAzureContext({ includeResources: true, resourceGroup: 'rg-prod' });
  assert.ok(Array.isArray(snap.resourceIds));
  assert.equal(snap.resourceIds!.length, 1);
  assert.ok(snap.resourceIds![0].includes('baz'));
});

test('azureContext — result is cached for 5 minutes', async () => {
  _resetAzureContextCache();
  let callCount = 0;
  const fakeAccount = JSON.stringify({ id: 'sub-cached', name: 'cached-sub', tenantId: 't-x' });
  execFileMock = (_file, args, _opts, cb) => {
    if (args.join(' ').includes('account show')) {
      callCount++;
      setImmediate(() => cb(null, fakeAccount));
    } else {
      setImmediate(() => cb(null, '[]'));
    }
    return { on: () => {} };
  };
  const { captureAzureContext } = await import('../azureContext');
  await captureAzureContext();
  await captureAzureContext(); // second call should hit cache
  assert.equal(callCount, 1, 'execFile should be called only once due to caching');
});

test('azureContext — cache is option-aware (includeResources/resourceGroup)', async () => {
  _resetAzureContextCache();
  let callCount = 0;
  const fakeAccount = JSON.stringify({ id: 'sub-opt', name: 'opt-sub', tenantId: 't-opt' });
  execFileMock = (_file, args, _opts, cb) => {
    const key = args.join(' ');
    if (key.includes('account show')) {
      callCount++;
      setImmediate(() => cb(null, fakeAccount));
    } else if (key.includes('resource list')) {
      setImmediate(() => cb(null, '[]'));
    } else {
      setImmediate(() => cb(null, '[]'));
    }
    return { on: () => {} };
  };
  const { captureAzureContext } = await import('../azureContext');
  await captureAzureContext({ includeResources: false });
  await captureAzureContext({ includeResources: true, resourceGroup: 'rg-a' });
  await captureAzureContext({ includeResources: true, resourceGroup: 'rg-b' });
  assert.equal(callCount, 3, 'distinct option sets must not share cache entries');
});
