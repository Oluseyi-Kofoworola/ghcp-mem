import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFilePath } from '../pathMatch';

test('matchFilePath — exact case-insensitive equality', () => {
  assert.equal(matchFilePath('src/foo.ts', 'src/foo.ts'), true);
  assert.equal(matchFilePath('src/Foo.ts', 'SRC/foo.ts'), true);
});

test('matchFilePath — workspace-root drift via path-suffix', () => {
  // stored absolute-ish, candidate workspace-relative
  assert.equal(matchFilePath('packages/web/src/cart.ts', 'src/cart.ts'), true);
  // and the reverse
  assert.equal(matchFilePath('src/cart.ts', 'packages/web/src/cart.ts'), true);
});

test('matchFilePath — same basename after move', () => {
  assert.equal(matchFilePath('src/old/cart.ts', 'src/new/cart.ts'), true);
});

test('matchFilePath — different basenames do NOT match', () => {
  assert.equal(matchFilePath('src/cart.ts', 'src/checkout.ts'), false);
});

test('matchFilePath — empty inputs are not a match (avoids vacuous true)', () => {
  assert.equal(matchFilePath('', 'src/foo.ts'), false);
  assert.equal(matchFilePath('src/foo.ts', ''), false);
  assert.equal(matchFilePath('', ''), false);
});

test('matchFilePath — case insensitivity on macOS/Windows-style paths', () => {
  assert.equal(matchFilePath('SRC/Foo.TS', 'src/foo.ts'), true);
});

test('matchFilePath — single-segment basename matches', () => {
  assert.equal(matchFilePath('cart.ts', 'cart.ts'), true);
  assert.equal(matchFilePath('cart.ts', 'src/cart.ts'), true);
});
