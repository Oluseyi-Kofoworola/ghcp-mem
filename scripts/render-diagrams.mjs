#!/usr/bin/env node
// Render docs/diagrams/*.mmd → images/diagrams/*.png using @mermaid-js/mermaid-cli.
//
// PNG (not SVG) because:
//   1. The VS Code Marketplace markdown renderer does not support mermaid
//      fenced code blocks (only GitHub does).
//   2. `vsce package` rejects <img src=*.svg> in README.md outright — the
//      Marketplace blocks SVG to avoid embedded scripts.
//
// Output is rendered at 2× scale and a white background so it stays crisp on
// retina displays and readable on the Marketplace's white README pane.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'docs', 'diagrams');
const OUT_DIR = join(ROOT, 'images', 'diagrams');
const PUPPETEER_CFG = join(ROOT, 'scripts', '.puppeteer.json');

mkdirSync(OUT_DIR, { recursive: true });

// Headless Chromium needs --no-sandbox in many CI/sandboxed environments.
writeFileSync(PUPPETEER_CFG, JSON.stringify({ args: ['--no-sandbox'] }));

const sources = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.mmd'))
  .map((f) => join(SRC_DIR, f));

if (sources.length === 0) {
  console.error(`no .mmd files found in ${SRC_DIR}`);
  process.exit(1);
}

let rendered = 0;
let skipped = 0;

for (const src of sources) {
  const name = basename(src, '.mmd');
  const out = join(OUT_DIR, `${name}.png`);
  const srcMtime = statSync(src).mtimeMs;
  let outMtime = 0;
  try {
    outMtime = statSync(out).mtimeMs;
  } catch {
    /* missing */
  }

  if (outMtime >= srcMtime) {
    skipped++;
    continue;
  }

  execFileSync(
    'npx',
    [
      '--yes',
      '@mermaid-js/mermaid-cli@10',
      '-i',
      src,
      '-o',
      out,
      '-b',
      'white',
      '-s',
      '2',
      '-w',
      '1600',
      '-p',
      PUPPETEER_CFG,
    ],
    { stdio: 'inherit', cwd: ROOT },
  );
  rendered++;
}

try {
  rmSync(PUPPETEER_CFG);
} catch {
  /* ignore */
}

console.log(`rendered ${rendered}, up-to-date ${skipped} (${SRC_DIR} → ${OUT_DIR})`);
