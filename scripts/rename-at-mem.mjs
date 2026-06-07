#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Companion to scripts/rename-to-baton.mjs.
 *
 * Replaces remaining "@mem" chat-participant invocations with "@baton" across
 * user-facing files. Run AFTER rename-to-baton.mjs; idempotent.
 *
 * Why this is a separate script: the bare token "mem" appears in many
 * non-chat-related contexts (variable names, prose, "memory" prefixes) so
 * we cannot blanket-replace it. We only target word-boundary "@mem" — the
 * unambiguous chat invocation form.
 *
 * Respects the same <!-- baton:preserve-old-names --> markers as the main
 * rename script so the v2.0.0 CHANGELOG migration guide can quote the old
 * invocation verbatim.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.');
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'out',
  'out-test',
  'dist',
  '.git',
  '.vscode-test',
]);

const EXCLUDED_FILES = new Set([
  'package-lock.json',
  'rename-to-baton.mjs',
  'rename-at-mem.mjs',
]);

const INCLUDED_EXTS = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.html',
  '.css',
]);

const PRESERVE_MARKER_START = '<!-- baton:preserve-old-names -->';
const PRESERVE_MARKER_END = '<!-- /baton:preserve-old-names -->';

// Word-boundary @mem replacement. \b alone is unreliable across @ in regex
// flavours, so we anchor with a non-word lookahead on the trailing side
// and rely on @ being a non-word char itself for the leading boundary.
const AT_MEM_RE = /@mem(?=\b)/g;

let filesScanned = 0;
let filesChanged = 0;
let totalReplacements = 0;

function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (
      e.name.startsWith('.') &&
      ![
        '.github',
        '.prettierrc.json',
        '.prettierignore',
        '.vscode',
        '.gitignore',
        '.gitattributes',
        '.vscodeignore',
      ].includes(e.name)
    )
      continue;
    if (EXCLUDED_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile()) {
      if (EXCLUDED_FILES.has(e.name)) continue;
      const ext = e.name.includes('.') ? e.name.slice(e.name.lastIndexOf('.')) : '';
      if (
        !INCLUDED_EXTS.has(ext) &&
        !['CHANGELOG', 'CHANGELOG.md', 'README', 'README.md', 'AGENTS.md'].includes(e.name)
      )
        continue;
      processFile(full);
    }
  }
}

function processFile(path) {
  filesScanned++;
  let original;
  try {
    original = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  // Skip preserve blocks
  const parts = [];
  let cursor = 0;
  while (cursor < original.length) {
    const startIdx = original.indexOf(PRESERVE_MARKER_START, cursor);
    if (startIdx === -1) {
      parts.push({ text: original.slice(cursor), rewrite: true });
      break;
    }
    parts.push({ text: original.slice(cursor, startIdx), rewrite: true });
    const endIdx = original.indexOf(PRESERVE_MARKER_END, startIdx);
    if (endIdx === -1) {
      parts.push({ text: original.slice(startIdx), rewrite: false });
      break;
    }
    parts.push({
      text: original.slice(startIdx, endIdx + PRESERVE_MARKER_END.length),
      rewrite: false,
    });
    cursor = endIdx + PRESERVE_MARKER_END.length;
  }
  let fileReplacements = 0;
  const rewritten = parts
    .map((p) => {
      if (!p.rewrite) return p.text;
      const matches = p.text.match(AT_MEM_RE);
      if (!matches) return p.text;
      fileReplacements += matches.length;
      return p.text.replace(AT_MEM_RE, '@baton');
    })
    .join('');
  if (rewritten === original) return;
  filesChanged++;
  totalReplacements += fileReplacements;
  if (VERBOSE) console.log(`  ${relative(ROOT, path).split(sep).join('/')}  (+${fileReplacements})`);
  if (!DRY_RUN) writeFileSync(path, rewritten);
}

console.log(`Replacing @mem → @baton in ${ROOT}${DRY_RUN ? '  [DRY RUN]' : ''}`);
walk(ROOT);
console.log('');
console.log(`Files scanned:       ${filesScanned}`);
console.log(`Files changed:       ${filesChanged}`);
console.log(`Total replacements:  ${totalReplacements}`);
