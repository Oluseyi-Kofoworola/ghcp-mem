#!/usr/bin/env node
/* eslint-disable no-console */
//
// Atomic version bump for Baton — single command, no human sweep.
//
// Updates EVERY surface that the release-consistency gate checks:
//   - package.json .version
//   - README footer  **vX.Y.Z**
//   - docs/DEMO.md   v1.4.10 → vX.Y.Z (all occurrences)
//   - CHANGELOG.md   prepend a new `## [X.Y.Z] — YYYY-MM-DD` entry stub
//
// Then runs the (non-strict) gate to confirm the edits agreed.
//
// Usage:
//   node scripts/bump-version.mjs 1.5.1
//   node scripts/bump-version.mjs 1.5.1 --note "security patch"
//
// Notes:
// - The CHANGELOG stub is a 3-line `### Changed` block you fill in before
//   committing. The gate's doc-only mode passes immediately; the strict
//   mode (run by vscode:prepublish) will fail until you tag + push, which
//   is the point.
// - The script is idempotent: running it twice with the same version is
//   a no-op (it detects that surfaces already match).
//

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const NEW = positional[0];
const noteIdx = args.indexOf('--note');
const NOTE = noteIdx >= 0 ? args[noteIdx + 1] : null;

if (!NEW || !/^\d+\.\d+\.\d+$/.test(NEW)) {
  console.error('usage: node scripts/bump-version.mjs <X.Y.Z> [--note "short note"]');
  console.error('  X.Y.Z must be plain semver (e.g. 1.5.1).');
  process.exit(2);
}

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}
function write(rel, content) {
  writeFileSync(resolve(ROOT, rel), content);
}

// ── 1. package.json ────────────────────────────────────────────────
const pkgPath = 'package.json';
const pkg = JSON.parse(read(pkgPath));
const OLD = pkg.version;
if (OLD === NEW) {
  console.log(`package.json already at ${NEW} — re-syncing other surfaces idempotently`);
} else {
  console.log(`package.json: ${OLD} → ${NEW}`);
  pkg.version = NEW;
  write(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

// ── 2. README footer ────────────────────────────────────────────────
const readmePath = 'README.md';
const readme = read(readmePath);
const newReadme = readme.replace(/\*\*v\d+\.\d+\.\d+\*\*/g, `**v${NEW}**`);
if (newReadme !== readme) {
  write(readmePath, newReadme);
  console.log(`README footer: **v${NEW}**`);
} else if (readme.includes(`**v${NEW}**`)) {
  console.log(`README footer: already **v${NEW}**`);
} else {
  console.warn(`⚠️  README has no **vX.Y.Z** footer to update — add one manually`);
}

// ── 3. docs/DEMO.md ─────────────────────────────────────────────────
const demoPath = 'docs/DEMO.md';
const demo = read(demoPath);
const newDemo = demo.replace(/v\d+\.\d+\.\d+/g, `v${NEW}`);
const changed = newDemo !== demo;
write(demoPath, newDemo);
const refs = [...newDemo.matchAll(/v\d+\.\d+\.\d+/g)].length;
console.log(
  `DEMO.md: ${changed ? 'updated' : 'already current'} (${refs} citations now at v${NEW})`,
);

// ── 4. CHANGELOG.md — prepend a stub if no entry for NEW yet ───────
const clPath = 'CHANGELOG.md';
const cl = read(clPath);
if (cl.includes(`## [${NEW}]`)) {
  console.log(`CHANGELOG: [${NEW}] entry already present — skip`);
} else {
  // Insert a stub above the most-recent entry.
  const today = new Date().toISOString().slice(0, 10);
  const noteLine = NOTE ? `\n${NOTE}\n` : '';
  const stub = `## [${NEW}] — ${today}\n${noteLine}\n### Changed\n- _TODO: fill in_\n\n---\n\n`;
  const split = cl.match(/^([\s\S]*?)(## \[\d+\.\d+\.\d+\][\s\S]*)$/);
  if (split) {
    const newCl = split[1] + stub + split[2];
    write(clPath, newCl);
    console.log(`CHANGELOG: prepended stub for [${NEW}]`);
  } else {
    console.warn(
      `⚠️  CHANGELOG.md has no existing release entry — wrote stub at top, edit before committing`,
    );
    write(clPath, stub + cl);
  }
}

// ── 5. Run the gate to confirm we left a consistent state ──────────
console.log('');
try {
  execFileSync('node', ['scripts/check-release-consistency.mjs'], { cwd: ROOT, stdio: 'inherit' });
} catch {
  console.error('\n❌ bump completed but consistency check FAILED — see output above');
  process.exit(1);
}

// ── 6. Next steps for the human ──────────────────────────────────────
console.log('');
console.log(`Next steps:`);
console.log(`  1. Fill in the CHANGELOG stub for [${NEW}].`);
console.log(`  2. Verify tests:        npm test`);
console.log(`  3. Commit:              git commit -am 'release: v${NEW} — <one-line summary>'`);
console.log(`  4. Tag:                 git tag -a v${NEW} -m 'Release v${NEW}'`);
console.log(`  5. Push HEAD + tag:     git push origin main && git push origin v${NEW}`);
console.log(
  `  6. Publish:             npm run package && npx vsce publish --packagePath baton-mem-${NEW}.vsix`,
);
console.log('');
console.log(`Or run them in sequence:`);
console.log(
  `  npm test && git commit -am 'release: v${NEW}' && git tag -a v${NEW} -m 'v${NEW}' \\`,
);
console.log(`    && git push origin main v${NEW} && npm run package \\`);
console.log(`    && npx vsce publish --packagePath baton-mem-${NEW}.vsix`);
