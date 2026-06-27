#!/usr/bin/env node
/**
 * Test runner shim that works identically on every Node version we care about
 * (LTS 20 in CI, ≥22 locally). We avoid `node --test "<glob>"` because:
 *
 *   • Node 20 does not expand glob patterns — it tries to open the literal
 *     `*.test.js` path and errors with "Could not find …".
 *   • Node 22+ expands globs, but only when the shell didn't already strip
 *     the quotes. The exact behaviour depends on whether bash, zsh, npm, or
 *     pwsh spawned the process. That's a portability time-bomb.
 *   • `node --test out-test/src/test/` (directory form) descends correctly
 *     in some Node versions and treats the directory as a single failing
 *     test in others (observed on Node 25.x). Not safe to rely on either.
 *
 * This shim:
 *   1. Discovers every `*.test.js` under `out-test/src/test/` (recursive).
 *   2. Spawns ONE `node --test <file> <file> …` invocation with the explicit
 *      list — fully portable, no shell glob, no version-conditional behaviour.
 *   3. Forwards exit code so CI surfaces failures correctly.
 *
 * If you ever need extra runner flags (e.g. `--test-reporter`), pass them as
 * arguments and they'll be propagated.
 */
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const TEST_ROOT = resolve('out-test/src/test');

/** Recursively collect every *.test.js path under `dir`. */
function discoverTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...discoverTests(full));
    } else if (entry.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

let files;
try {
  files = discoverTests(TEST_ROOT);
} catch (err) {
  console.error(`[run-tests] cannot read ${TEST_ROOT}: ${err.message}`);
  console.error('[run-tests] did the test compile step (tsc -p ./tsconfig.test.json) run first?');
  process.exit(1);
}

if (files.length === 0) {
  console.error(`[run-tests] no *.test.js files found under ${TEST_ROOT}`);
  console.error('[run-tests] this almost always means the typescript compile produced no output.');
  process.exit(1);
}

console.log(`[run-tests] discovered ${files.length} test file(s) under ${TEST_ROOT}`);

const extraArgs = process.argv.slice(2); // forwarded flags, if any
const result = spawnSync(process.execPath, ['--test', ...extraArgs, ...files], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
