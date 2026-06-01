#!/usr/bin/env node
// Render an animated SMIL .svg to an animated GIF.
//
// Why this exists:
//   vsce package rejects <img src=*.svg> in README.md (Marketplace security
//   policy), so we can't ship SVG animations in the Marketplace listing.
//   We keep the .svg as the canonical, editable source and use this script
//   to produce a matching .gif for the README.
//
// How it works:
//   For each frame index 0..N-1, spawns headless Chrome with
//   --virtual-time-budget=<ms> so the SMIL animation playhead is fast-forwarded
//   to the desired moment. The screenshot is captured deterministically (no
//   wall-clock dependency), which means re-runs are reproducible.
//
// Usage:
//   node scripts/render-svg-to-gif.mjs <input.svg> <output.gif> \
//     [--duration-ms 4000] [--fps 12] [--width 960] [--height 250]
//
// Requires: gifski (brew install gifski), Google Chrome.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('usage: render-svg-to-gif.mjs <input.svg> <output.gif> [opts]');
  process.exit(2);
}

const [inSvg, outGif, ...rest] = argv;
const opts = Object.fromEntries(
  rest.flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1]]] : [])),
);
const durationMs = Number(opts['duration-ms'] ?? 4000);
const fps = Number(opts.fps ?? 12);
const width = Number(opts.width ?? 960);
const height = Number(opts.height ?? 250);
const numFrames = Math.round((durationMs / 1000) * fps);

const inputPath = resolve(inSvg);
const outputPath = resolve(outGif);
if (!existsSync(inputPath)) {
  console.error(`missing input: ${inputPath}`);
  process.exit(1);
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmp = mkdtempSync(join(tmpdir(), 'svg-to-gif-'));
console.log(`rendering ${numFrames} frames (${durationMs}ms @ ${fps}fps, ${width}x${height})`);
console.log(`  src: ${inputPath}`);
console.log(`  tmp: ${tmp}`);

// Capture each frame at evenly-spaced animation times. We pin a small floor
// (50ms) for frame 0 so Chrome's SMIL engine has actually started; some
// versions emit a blank frame at t=0.
const frames = [];
for (let i = 0; i < numFrames; i++) {
  const t = Math.max(50, Math.round((i * durationMs) / numFrames));
  const out = join(tmp, `frame-${String(i).padStart(4, '0')}.png`);
  execFileSync(
    CHROME,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--virtual-time-budget=${t}`,
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      `file://${inputPath}`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  if (!existsSync(out)) {
    console.error(`  frame ${i} (t=${t}ms) not captured — aborting`);
    process.exit(1);
  }
  frames.push(out);
  if ((i + 1) % 10 === 0 || i + 1 === numFrames) {
    process.stderr.write(`  ${i + 1}/${numFrames}\n`);
  }
}

// Stitch with gifski. quality=85 balances size vs fidelity well for line art.
console.log(`encoding GIF: ${outputPath}`);
execFileSync(
  'gifski',
  [
    '--fps',
    String(fps),
    '--width',
    String(width),
    '--quality',
    '85',
    '--output',
    outputPath,
    ...frames,
  ],
  { stdio: 'inherit' },
);

// Cleanup
rmSync(tmp, { recursive: true, force: true });
console.log(`done — ${basename(outputPath)}`);
