#!/usr/bin/env node
/* eslint-disable no-console */
//
// Dependency-free git hook installer for GHCP-MEM.
//
// Opt-in (never runs on `npm install` — the project forbids postinstall
// scripts and native deps). Run once with `npm run hooks:install` to wire a
// pre-commit hook that runs the cheap, fast gates (`format:check` + `lint`)
// before every commit. This closes the release-friction gap where several
// past releases (1.6.1–1.6.3, 1.7.1, 1.8.1) were spent rescuing CI after
// unformatted files or lint warnings landed on main.
//
// Bypass a single commit with `git commit --no-verify` when needed.
//

import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function gitDir() {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    return resolve(ROOT, out);
  } catch {
    return null;
  }
}

const gd = gitDir();
if (!gd) {
  console.error('❌ Not a git repository (or git unavailable). Nothing installed.');
  process.exit(1);
}

const hooksDir = join(gd, 'hooks');
if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

const hookPath = join(hooksDir, 'pre-commit');
const hook = `#!/bin/sh
# GHCP-MEM pre-commit hook (installed by scripts/install-hooks.mjs).
# Runs the fast gates so CI doesn't have to catch formatting/lint slips.
# Bypass with: git commit --no-verify
echo "[ghcp-mem] pre-commit: format:check + lint"
npm run format:check || {
  echo "✗ Prettier check failed. Run: npm run format" >&2
  exit 1
}
npm run lint || {
  echo "✗ ESLint failed (--max-warnings=0)." >&2
  exit 1
}
`;

writeFileSync(hookPath, hook, { encoding: 'utf8' });
try {
  chmodSync(hookPath, 0o755);
} catch {
  /* chmod is a no-op / unsupported on some Windows filesystems — fine */
}

console.log(`✅ Installed pre-commit hook → ${hookPath}`);
console.log('   It runs `format:check` + `lint` before each commit.');
console.log('   Bypass once with: git commit --no-verify');
