#!/usr/bin/env node
// Render an animated SMIL .svg to BOTH an animated GIF and an H.264 MP4.
//
// Same pipeline as render-svg-to-gif.mjs (headless Chrome with
// --virtual-time-budget per frame for deterministic SMIL playback) but
// emits two artifacts:
//   - <basename>.gif (gifski, lossy palette)
//   - <basename>.mp4 (ffmpeg, H.264, yuv420p — broadly compatible)
//
// Usage:
//   node scripts/render-svg-to-video.mjs <input.svg> <output-basename> \
//     [--duration-ms 45000] [--fps 24] [--width 1280] [--height 720]
//
// Examples:
//   node scripts/render-svg-to-video.mjs \
//     images/demo/day-01-launch-v2.svg \
//     images/demo/day-01-launch \
//     --duration-ms 48000 --fps 24 --width 1280 --height 720
//
// Requires: ffmpeg (brew install ffmpeg), gifski (brew install gifski),
// Google Chrome at /Applications/Google Chrome.app.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('usage: render-svg-to-video.mjs <input.svg> <output-basename> [opts]');
  console.error('  --duration-ms <N>   total animation length (default 45000)');
  console.error('  --fps <N>           frame rate (default 24)');
  console.error('  --width <N>         viewport width (default 1280)');
  console.error('  --height <N>        viewport height (default 720)');
  console.error('  --skip-gif          only emit the .mp4');
  console.error('  --skip-mp4          only emit the .gif');
  process.exit(2);
}

const [inSvg, outBase, ...rest] = argv;
const opts = {};
let skipGif = false,
  skipMp4 = false;
for (let i = 0; i < rest.length; i++) {
  const k = rest[i];
  if (k === '--skip-gif') {
    skipGif = true;
    continue;
  }
  if (k === '--skip-mp4') {
    skipMp4 = true;
    continue;
  }
  if (k.startsWith('--')) opts[k.slice(2)] = rest[++i];
}
const durationMs = Number(opts['duration-ms'] ?? 45000);
const fps = Number(opts.fps ?? 24);
const width = Number(opts.width ?? 1280);
const height = Number(opts.height ?? 720);
const numFrames = Math.round((durationMs / 1000) * fps);

const inputPath = resolve(inSvg);
const outputBase = resolve(outBase);
if (!existsSync(inputPath)) {
  console.error(`missing input: ${inputPath}`);
  process.exit(1);
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmp = mkdtempSync(join(tmpdir(), 'svg-to-video-'));

console.log(`rendering ${numFrames} frames (${durationMs}ms @ ${fps}fps, ${width}×${height})`);
console.log(`  src: ${inputPath}`);
console.log(`  tmp: ${tmp}`);

// 1. Capture each frame at evenly-spaced animation times via virtual time.
// Per-frame timeout: Chrome headless can deadlock on SVGs with heavy filters
// (bloom + animateMotion + multiple SMIL anims). 30s/frame is generous; a
// stuck frame is detected immediately instead of stalling the whole render.
const PER_FRAME_TIMEOUT_MS = 30_000;
const frames = [];
for (let i = 0; i < numFrames; i++) {
  // Pin a small floor (50ms) for frame 0 so Chrome's SMIL engine has actually
  // started; some versions emit a blank frame at t=0.
  const t = Math.max(50, Math.round((i * durationMs) / numFrames));
  const out = join(tmp, `frame-${String(i).padStart(5, '0')}.png`);
  try {
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
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: PER_FRAME_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );
  } catch (err) {
    if (err.code === 'ETIMEDOUT' || err.signal === 'SIGKILL' || err.signal === 'SIGTERM') {
      console.error(
        `  frame ${i} (t=${t}ms) timed out after ${PER_FRAME_TIMEOUT_MS}ms — likely a filter/animation deadlock. Simplify the SVG (reduce bloom stdDeviation, drop nested filters, fewer concurrent SMIL anims).`,
      );
    } else {
      console.error(`  frame ${i} (t=${t}ms) failed: ${err.message}`);
    }
    process.exit(1);
  }
  if (!existsSync(out)) {
    console.error(`  frame ${i} (t=${t}ms) not captured — aborting`);
    process.exit(1);
  }
  frames.push(out);
  if ((i + 1) % 24 === 0 || i + 1 === numFrames) {
    process.stderr.write(`  ${i + 1}/${numFrames}\n`);
  }
}

// 2. Emit MP4 (H.264, yuv420p, faststart) via ffmpeg.
if (!skipMp4) {
  const mp4Path = `${outputBase}.mp4`;
  console.log(`encoding MP4 → ${mp4Path}`);
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-framerate',
      String(fps),
      '-i',
      join(tmp, 'frame-%05d.png'),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '20', // visually lossless-ish
      '-preset',
      'medium',
      '-movflags',
      '+faststart',
      mp4Path,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

// 3. Emit GIF via gifski (better palette than ffmpeg's GIF encoder).
if (!skipGif) {
  const gifPath = `${outputBase}.gif`;
  console.log(`encoding GIF → ${gifPath}`);
  execFileSync(
    'gifski',
    [
      '--fps',
      String(fps),
      '--width',
      String(width),
      '--quality',
      '80',
      '--output',
      gifPath,
      ...frames,
    ],
    { stdio: 'inherit' },
  );
}

// 4. Cleanup
rmSync(tmp, { recursive: true, force: true });
console.log(`done — ${basename(outputBase)}.{mp4,gif}`);
