#!/usr/bin/env node
/* eslint-disable no-console */
//
// Release-consistency gate for Baton.
//
// Single source of truth: package.json `.version`. Every other surface
// (README footer, DEMO.md, CHANGELOG.md, git tag, GitHub remote) is
// CHECKED against it. Any drift → exit code 1 with an actionable error.
//
// Two modes:
//
//   node scripts/check-release-consistency.mjs
//     Doc-only checks. Runs in CI on every PR; safe even during work in
//     progress because it doesn't require a clean tree.
//
//   node scripts/check-release-consistency.mjs --strict
//     Adds publish-time checks (clean tree, HEAD pushed, tag exists and
//     pushed). This is what vscode:prepublish runs so `vsce publish`
//     cannot ship a state that will fail the reviewer's audit:
//
//       - Marketplace footer:    vX.Y.Z   ← what the publish would set
//       - GitHub package.json:   X.Y.Z    ← only true if HEAD is pushed
//       - CHANGELOG latest:      [X.Y.Z]  ← guarded by doc check
//       - GitHub Releases latest: vX.Y.Z  ← guarded by tag-pushed check
//
// Exit codes:
//   0  all checks pass
//   1  at least one check failed
//   2  the script itself crashed (bug)
//

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');
const QUIET = process.argv.includes('--quiet');

// Detect GitHub Actions pull-request context. On PR runs, the checked-out HEAD
// is a synthetic merge commit (refs/pull/N/merge), so by construction it will
// never equal origin/main and no `vX.Y.Z` tag will point at it. The strict
// git-state checks (HEAD-pushed, tag-exists, tag-on-origin) are therefore
// meaningless in that context — they only have signal when the gate runs at
// actual release time (release.yml on a refs/tags/vX.Y.Z push, where HEAD is
// the tag commit on main). Skipping them here keeps `vsce package` working in
// PR-build CI without weakening the gate at release time.
const IS_PR_BUILD =
  process.env.GITHUB_EVENT_NAME === 'pull_request' ||
  (process.env.GITHUB_REF && process.env.GITHUB_REF.startsWith('refs/pull/'));

const failures = [];
const passed = [];

function fail(check, expected, got, hint) {
  failures.push({ check, expected, got, hint });
}
function pass(check, detail) {
  passed.push({ check, detail });
}

function readFile(rel) {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) {
    fail(`file exists: ${rel}`, 'present', 'missing');
    return null;
  }
  return readFileSync(p, 'utf8');
}

function git(...args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    return { error: err.message || String(err), exitCode: err.status };
  }
}

// ── 1. Source of truth ──────────────────────────────────────────────
const pkgRaw = readFile('package.json');
if (!pkgRaw) {
  report();
  process.exit(1);
}
const pkg = JSON.parse(pkgRaw);
const VERSION = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  fail('package.json .version', 'X.Y.Z', VERSION, 'must be plain semver');
} else {
  pass('package.json .version', VERSION);
}

// ── 2. README footer ─────────────────────────────────────────────────
const readme = readFile('README.md');
if (readme) {
  const footerRe = /\*\*v(\d+\.\d+\.\d+)\*\*/g;
  const refs = [...readme.matchAll(footerRe)].map((m) => m[1]);
  const distinct = [...new Set(refs)];
  if (distinct.length === 0) {
    fail('README footer **vX.Y.Z**', VERSION, 'no match', 'add **v$VERSION** somewhere in README');
  } else if (distinct.length > 1) {
    fail(
      'README footer (multiple versions cited)',
      VERSION,
      distinct.join(' / '),
      'README cites more than one version; only one is the truth',
    );
  } else if (distinct[0] !== VERSION) {
    fail(
      'README footer **vX.Y.Z**',
      `v${VERSION}`,
      `v${distinct[0]}`,
      `run: npm run bump:version -- ${VERSION}`,
    );
  } else {
    pass('README footer', `v${distinct[0]}`);
  }
}

// ── 3. DEMO.md version refs ─────────────────────────────────────────
const demo = readFile('docs/DEMO.md');
if (demo) {
  const demoRefs = [...demo.matchAll(/v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  const demoDistinct = [...new Set(demoRefs)];
  if (demoDistinct.length === 0) {
    fail('DEMO.md version refs', VERSION, 'none', 'DEMO.md should cite the current version');
  } else if (demoDistinct.length > 1) {
    fail(
      'DEMO.md (multiple versions cited)',
      VERSION,
      demoDistinct.join(' / '),
      'every version mention in DEMO.md must match package.json',
    );
  } else if (demoDistinct[0] !== VERSION) {
    fail(
      'DEMO.md version',
      `v${VERSION}`,
      `v${demoDistinct[0]}`,
      `run: npm run bump:version -- ${VERSION}`,
    );
  } else {
    pass(
      'DEMO.md',
      `v${demoDistinct[0]} (${demoRefs.length} citation${demoRefs.length === 1 ? '' : 's'})`,
    );
  }
}

// ── 4. CHANGELOG top entry ──────────────────────────────────────────
const changelog = readFile('CHANGELOG.md');
if (changelog) {
  const top = changelog.match(/^## \[(\d+\.\d+\.\d+)\b/m);
  if (!top) {
    fail(
      'CHANGELOG.md latest entry',
      `[${VERSION}]`,
      'no `## [X.Y.Z]` heading found',
      'add a `## [' + VERSION + '] — YYYY-MM-DD` entry at the top',
    );
  } else if (top[1] !== VERSION) {
    fail(
      'CHANGELOG.md latest entry',
      `[${VERSION}]`,
      `[${top[1]}]`,
      `the CHANGELOG top heading must match package.json; add a new [${VERSION}] entry`,
    );
  } else {
    pass('CHANGELOG.md', `top entry [${top[1]}]`);
  }
}

// ── 5. STRICT-only: git state ───────────────────────────────────────
if (STRICT) {
  // 5a. clean tree
  const dirty = git('status', '--porcelain');
  if (typeof dirty === 'object' && dirty.error) {
    fail('git status', 'OK', dirty.error);
  } else if (dirty) {
    fail(
      'working tree clean',
      'no uncommitted changes',
      dirty.split('\n').length + ' modified path(s)',
      'commit or stash before publishing',
    );
  } else {
    pass('working tree', 'clean');
  }

  // 5b–5d only have signal at real release time (tag push on main). On a PR
  // build HEAD is a synthetic merge commit and there is no `vX.Y.Z` tag yet,
  // so these checks would fail by construction. Skip them but still record a
  // passed line so the gate output stays honest.
  if (IS_PR_BUILD) {
    pass('HEAD/tag git-state checks', 'skipped (pull-request build)');
  } else {
    // 5b. HEAD pushed to origin/main
    const head = git('rev-parse', 'HEAD');
    let originMain = git('rev-parse', 'origin/main');
    // CI checkouts default to `fetch-depth: 1`, which leaves us without an
    // `origin/main` ref. Self-heal once before failing so the script works
    // in both clean local dev and shallow CI environments. We use a narrow
    // `git fetch` (single branch, no tags) to keep the network footprint
    // small. The workflows also do this explicitly belt-and-suspenders.
    if (typeof originMain === 'object') {
      git('fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
      originMain = git('rev-parse', 'origin/main');
    }
    if (typeof head === 'object' || typeof originMain === 'object') {
      fail('git refs', 'HEAD + origin/main resolvable', 'git error', 'run: git fetch origin');
    } else if (head !== originMain) {
      // Use a ref that always exists (HEAD) rather than `main`, which may not
      // exist locally in detached-HEAD CI checkouts. Coerce the result so a
      // git failure renders as a readable message instead of `[object Object]`.
      const aheadResult = git('rev-list', '--count', 'origin/main..HEAD');
      const ahead = typeof aheadResult === 'string' ? aheadResult : 'unknown';
      fail(
        'HEAD pushed to origin/main',
        'origin/main = HEAD',
        `local is ${ahead} commit(s) ahead of origin/main`,
        'push to GitHub first — Marketplace + source-of-truth must match',
      );
    } else {
      pass('HEAD pushed to origin/main', head.substring(0, 8));
    }

    // 5c. tag vX.Y.Z exists locally
    // Use ^{commit} to dereference an annotated tag to its underlying commit
    // SHA. Without it, git rev-parse returns the tag-object SHA for annotated
    // tags, which never matches HEAD.
    const tagCommit = git('rev-parse', `v${VERSION}^{commit}`);
    if (typeof tagCommit === 'object') {
      fail(
        `tag v${VERSION}`,
        'exists locally',
        'missing',
        `run: git tag -a v${VERSION} -m "Release v${VERSION}"`,
      );
    } else if (tagCommit !== head) {
      fail(
        `tag v${VERSION}`,
        `points at HEAD (${head.substring(0, 8)})`,
        `points at ${tagCommit.substring(0, 8)}`,
        `re-tag at current HEAD: git tag -f v${VERSION}`,
      );
    } else {
      pass(`tag v${VERSION}`, `at ${tagCommit.substring(0, 8)}`);
    }

    // 5d. tag pushed to origin
    const remoteTag = git('ls-remote', '--tags', 'origin', `v${VERSION}`);
    if (typeof remoteTag === 'object') {
      fail(
        `tag v${VERSION} on origin`,
        'reachable',
        remoteTag.error || 'unreachable',
        `run: git push origin v${VERSION}`,
      );
    } else if (!remoteTag) {
      fail(
        `tag v${VERSION} on origin`,
        'pushed',
        'not on origin',
        `run: git push origin v${VERSION}  (triggers release.yml → GitHub Release)`,
      );
    } else {
      pass(`tag v${VERSION} on origin`, 'pushed');
    }
  }
}

// ── 6. Report ────────────────────────────────────────────────────────
function report() {
  if (!QUIET) {
    if (passed.length) {
      console.log(`✅ ${passed.length} check${passed.length === 1 ? '' : 's'} passed:`);
      for (const p of passed) console.log(`     ${p.check.padEnd(36)} ${p.detail}`);
    }
    if (failures.length) {
      console.log(`\n❌ ${failures.length} check${failures.length === 1 ? '' : 's'} FAILED:\n`);
      for (const f of failures) {
        console.log(`     ${f.check}`);
        console.log(`       expected: ${f.expected}`);
        console.log(`       got:      ${f.got}`);
        if (f.hint) console.log(`       fix:      ${f.hint}`);
        console.log('');
      }
    } else {
      console.log(`\n🟢 release-consistency: PASS ${STRICT ? '(strict)' : '(doc-only)'}`);
    }
  }
}

report();
process.exit(failures.length > 0 ? 1 : 0);
