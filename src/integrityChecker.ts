/**
 * Workspace Integrity Audit
 *
 * A lightweight rule-based scanner that checks the active workspace for
 * the kinds of cross-file inconsistencies that erode trust in a release.
 *
 * The first built-in rule mirrors the standalone release-consistency gate
 * in scripts/check-release-consistency.mjs — but unlike the gate, this
 * runs inside the extension host so it's available at any time:
 *
 *   • As a slash command:        @mem /audit
 *   • As a Copilot agent tool:   #ghcpMemAudit
 *   • From the command palette:  GHCP-MEM: Run Workspace Integrity Audit
 *
 * Why duplicate the gate? Different audiences, different timing:
 *   - Gate runs in CI/pre-publish, blocks vsce publish, no UX.
 *   - Auditor runs in the editor at any moment, catches drift the
 *     instant a file is saved, formats output as a clickable markdown
 *     report.
 *
 * The rule framework is intentionally simple. Each rule is a function
 * that reads files from the workspace, returns a list of issues. Users
 * can opt in to user-defined rules in a future release.
 */

import * as vscode from 'vscode';

/** A single integrity finding to surface in the audit report. */
export interface IntegrityIssue {
  /** Stable rule id (e.g. 'version-drift'). */
  rule: string;
  severity: 'error' | 'warning' | 'info';
  /** Workspace-relative file path the issue was found in. */
  file: string;
  /** Optional 1-based line number if the rule knows it. */
  line?: number;
  /** Human-readable description of what's wrong. */
  message: string;
  /** Optional one-line fix suggestion. */
  fix?: string;
}

/** A rule the auditor can run against the workspace. */
export interface IntegrityRule {
  /** Stable identifier, used as the `rule` field on findings. */
  name: string;
  /** Short human description shown in the report header. */
  description: string;
  /** Run the rule, return the issues it found. Must not throw. */
  check(ws: vscode.Uri): Promise<IntegrityIssue[]>;
}

// ── Built-in rule: version-drift ─────────────────────────────────────
//
// Catches the exact bug a reviewer flagged: package.json says 1.4.9,
// README footer says v1.5.0, CHANGELOG top says 1.4.9, GitHub Releases
// latest says v1.4.0. We can't see GitHub Releases from inside the
// extension host, but we can verify the local workspace surfaces line
// up with package.json — which is the source of truth that vsce
// publish reads.

async function readFileFromWorkspace(ws: vscode.Uri, rel: string): Promise<string | null> {
  try {
    const uri = vscode.Uri.joinPath(ws, rel);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf-8');
  } catch {
    return null;
  }
}

/** Strip surrounding quotes/whitespace; extract a semver triple. */
function extractSemver(s: string): string | null {
  const m = s.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** Find the 1-based line number for a substring; 0 if not found. */
function lineOf(text: string, needle: string): number {
  const idx = text.indexOf(needle);
  if (idx < 0) return 0;
  return text.substring(0, idx).split('\n').length;
}

export const versionDriftRule: IntegrityRule = {
  name: 'version-drift',
  description: 'package.json version must match README footer, DEMO.md, CHANGELOG.md',
  async check(ws) {
    const issues: IntegrityIssue[] = [];

    // ── Source of truth ──
    const pkgRaw = await readFileFromWorkspace(ws, 'package.json');
    if (!pkgRaw) return issues; // not a npm project — rule N/A, not an error
    let truth: string | null = null;
    try {
      truth = extractSemver((JSON.parse(pkgRaw) as { version?: string }).version ?? '');
    } catch {
      issues.push({
        rule: 'version-drift',
        severity: 'error',
        file: 'package.json',
        message: 'package.json is not valid JSON',
        fix: 'fix the syntax error before any version surface can be compared',
      });
      return issues;
    }
    if (!truth) {
      issues.push({
        rule: 'version-drift',
        severity: 'error',
        file: 'package.json',
        message: '.version field is missing or not semver (X.Y.Z)',
        fix: 'add a "version": "X.Y.Z" line',
      });
      return issues;
    }

    // ── README footer ──
    const readme = await readFileFromWorkspace(ws, 'README.md');
    if (readme) {
      const refs = [...readme.matchAll(/\*\*v(\d+\.\d+\.\d+)\*\*/g)].map((m) => m[1]);
      const distinct = [...new Set(refs)];
      if (distinct.length === 0) {
        issues.push({
          rule: 'version-drift',
          severity: 'warning',
          file: 'README.md',
          message: `no **vX.Y.Z** footer found; cannot verify against package.json ${truth}`,
          fix: `add **v${truth}** somewhere in README.md`,
        });
      } else if (distinct.length > 1) {
        issues.push({
          rule: 'version-drift',
          severity: 'error',
          file: 'README.md',
          message: `README cites multiple versions: ${distinct.join(', ')}; only one can be the truth`,
          fix: `run: npm run bump:version -- ${truth}`,
        });
      } else if (distinct[0] !== truth) {
        issues.push({
          rule: 'version-drift',
          severity: 'error',
          file: 'README.md',
          line: lineOf(readme, `**v${distinct[0]}**`) || undefined,
          message: `README footer says v${distinct[0]} but package.json is ${truth}`,
          fix: `run: npm run bump:version -- ${truth}`,
        });
      }
    }

    // ── DEMO.md citations ──
    const demo = await readFileFromWorkspace(ws, 'docs/DEMO.md');
    if (demo) {
      const refs = [...demo.matchAll(/v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
      const distinct = [...new Set(refs)];
      if (distinct.length > 1) {
        issues.push({
          rule: 'version-drift',
          severity: 'error',
          file: 'docs/DEMO.md',
          message: `DEMO.md cites multiple versions: ${distinct.join(', ')}`,
          fix: `run: npm run bump:version -- ${truth}`,
        });
      } else if (distinct.length === 1 && distinct[0] !== truth) {
        issues.push({
          rule: 'version-drift',
          severity: 'error',
          file: 'docs/DEMO.md',
          line: lineOf(demo, `v${distinct[0]}`) || undefined,
          message: `DEMO.md says v${distinct[0]} but package.json is ${truth}`,
          fix: `run: npm run bump:version -- ${truth}`,
        });
      }
    }

    // ── CHANGELOG top entry ──
    const changelog = await readFileFromWorkspace(ws, 'CHANGELOG.md');
    if (changelog) {
      const top = changelog.match(/^## \[(\d+\.\d+\.\d+)\b/m);
      if (!top) {
        issues.push({
          rule: 'version-drift',
          severity: 'warning',
          file: 'CHANGELOG.md',
          message: 'no `## [X.Y.Z]` heading found; cannot verify',
          fix: `add a \`## [${truth}] — YYYY-MM-DD\` entry at the top`,
        });
      } else if (top[1] !== truth) {
        issues.push({
          rule: 'version-drift',
          severity: 'error',
          file: 'CHANGELOG.md',
          line: lineOf(changelog, `## [${top[1]}]`) || undefined,
          message: `CHANGELOG top entry is [${top[1]}] but package.json is ${truth}`,
          fix: `add a new \`## [${truth}] — YYYY-MM-DD\` entry above the [${top[1]}] one`,
        });
      }
    }

    return issues;
  },
};

// ── Built-in rule: sensitive-data audit (v1.13.0) ────────────────────
//
// Scans every file the extension may have generated (the auto-injected
// `.github/instructions/session-memory.instructions.md`, the project rules
// `.github/memory/rules.md`) for credential shapes that should have been
// redacted but weren't. Reports counts grouped by class; an enterprise admin
// can use this to verify that an existing store is clean BEFORE rolling
// GHCP-MEM out org-wide.
//
// We deliberately re-use the same redactor used at capture time so a
// "clean" report here means "the same redactor that ran at capture time
// would not change anything if it ran again now" — i.e. the store is fully
// covered. Mismatches usually mean: (a) the user pulled in a memory pack
// that was redacted with an older rule set, or (b) a rule was tightened
// post-capture, or (c) a custom-redaction-rule misconfiguration left holes.

interface SensitiveScanFile {
  /** Workspace-relative path to scan. */
  path: string;
  /** Human-readable label shown in the issue message. */
  label: string;
}

const SENSITIVE_SCAN_TARGETS: SensitiveScanFile[] = [
  { path: '.github/instructions/session-memory.instructions.md', label: 'auto-injected context' },
  { path: '.github/memory/rules.md', label: 'project rules' },
  { path: 'CLAUDE.md', label: 'Claude Code memory' },
  { path: '.cursor/rules/ghcp-mem.mdc', label: 'Cursor rules' },
];

export const sensitiveDataRule: IntegrityRule = {
  name: 'sensitive-data',
  description:
    'Scan generated memory files for credentials / cloud identifiers the redactor should have caught',
  async check(ws): Promise<IntegrityIssue[]> {
    const issues: IntegrityIssue[] = [];
    let redactFn: typeof import('./redactor').redact;
    try {
      // Dynamic import keeps the integrity checker test-able in isolation;
      // production code paths get the full redactor with no extra cost.
      ({ redact: redactFn } = await import('./redactor'));
    } catch (err) {
      issues.push({
        rule: 'sensitive-data',
        severity: 'warning',
        file: '(redactor)',
        message: `unable to load redactor for sensitive-data scan: ${(err as Error).message}`,
      });
      return issues;
    }

    for (const target of SENSITIVE_SCAN_TARGETS) {
      const content = await readFileFromWorkspace(ws, target.path);
      if (content === null) continue; // not generated yet — nothing to scan, not an issue.
      const before = content;
      const after = redactFn(content, {
        redactSecrets: true,
        honorPrivateTags: false,
        detectHighEntropy: true,
      });
      if (after.redactionCount === 0) continue; // clean.
      // The redactor doesn't tell us WHICH rules fired, only the total count.
      // We re-derive a per-class breakdown by inspecting the post-redaction
      // text for [REDACTED:<class>] markers — gives the enterprise user a
      // breakdown they can act on without leaking the actual secret values.
      const classCounts = new Map<string, number>();
      for (const m of after.text.matchAll(/\[REDACTED:([a-z][a-z0-9-]*)\]/gi)) {
        classCounts.set(m[1], (classCounts.get(m[1]) ?? 0) + 1);
      }
      const breakdown = [...classCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cls, n]) => `${cls}×${n}`)
        .join(', ');
      issues.push({
        rule: 'sensitive-data',
        severity: 'error',
        file: target.path,
        message:
          `${target.label}: ${after.redactionCount} sensitive token(s) would be redacted ` +
          `if captured today (${breakdown || 'unknown classes'}). The file was generated ` +
          `before the current redaction policy was tightened, or a memory pack with weaker ` +
          `redaction was imported.`,
        fix:
          `run: GHCP-MEM: Audit Memory for Sensitive Data → Redact now (rewrites this file ` +
          `with the current ruleset). Or delete the file and let it regenerate from the store.`,
      });
      // Cross-reference: confirm the unredacted content isn't still hiding
      // some non-tagged sensitive shape (e.g. an Azure subscription path the
      // older rules didn't catch). Compare lengths as a rough delta.
      if (before.length !== after.text.length) {
        const delta = before.length - after.text.length;
        issues.push({
          rule: 'sensitive-data',
          severity: 'info',
          file: target.path,
          message:
            `${target.label}: ${delta} char(s) would be removed by the current redactor — ` +
            `larger than a single-token redaction suggests multiple findings`,
        });
      }
    }
    return issues;
  },
};

// ── Auditor ─────────────────────────────────────────────────────────

/** Rules registered with the auditor. Add more here as we build them. */
const BUILTIN_RULES: IntegrityRule[] = [versionDriftRule, sensitiveDataRule];

/** Run every registered rule against the first workspace folder. */
export async function runWorkspaceAudit(
  rules: IntegrityRule[] = BUILTIN_RULES,
): Promise<{ issues: IntegrityIssue[]; rulesRun: string[] }> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return { issues: [], rulesRun: [] };
  const issues: IntegrityIssue[] = [];
  for (const rule of rules) {
    try {
      const found = await rule.check(folder.uri);
      issues.push(...found);
    } catch (err) {
      issues.push({
        rule: rule.name,
        severity: 'warning',
        file: '(rule error)',
        message: `rule '${rule.name}' threw: ${(err as Error).message}`,
      });
    }
  }
  return { issues, rulesRun: rules.map((r) => r.name) };
}

/** Format the audit findings as a markdown document. */
export function formatAuditReport(issues: IntegrityIssue[], rulesRun: string[]): string {
  const lines: string[] = [];
  lines.push('# 🩺 GHCP-MEM Workspace Integrity Audit');
  lines.push('');
  lines.push(`- generated: ${new Date().toISOString()}`);
  lines.push(`- rules run: ${rulesRun.join(', ') || '(none)'}`);
  lines.push(`- issues found: **${issues.length}**`);
  lines.push('');

  if (issues.length === 0) {
    lines.push('✅ **All checks passed.** No integrity issues found in the workspace.');
    return lines.join('\n');
  }

  // Group by severity
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const infos = issues.filter((i) => i.severity === 'info');

  if (errors.length) {
    lines.push(`## ❌ Errors (${errors.length})`);
    lines.push('');
    lines.push('| Rule | File | Message | Suggested fix |');
    lines.push('| --- | --- | --- | --- |');
    for (const i of errors) {
      lines.push(`| \`${i.rule}\` | ${formatFileRef(i)} | ${i.message} | ${i.fix ?? '—'} |`);
    }
    lines.push('');
  }
  if (warnings.length) {
    lines.push(`## ⚠️ Warnings (${warnings.length})`);
    lines.push('');
    lines.push('| Rule | File | Message | Suggested fix |');
    lines.push('| --- | --- | --- | --- |');
    for (const i of warnings) {
      lines.push(`| \`${i.rule}\` | ${formatFileRef(i)} | ${i.message} | ${i.fix ?? '—'} |`);
    }
    lines.push('');
  }
  if (infos.length) {
    lines.push(`## ℹ️ Info (${infos.length})`);
    lines.push('');
    for (const i of infos) {
      lines.push(`- **${i.rule}** · ${formatFileRef(i)} · ${i.message}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatFileRef(i: IntegrityIssue): string {
  return i.line ? `\`${i.file}:${i.line}\`` : `\`${i.file}\``;
}

/** Convenience: returns true if any error-severity issues were found. */
export function hasBlockingIssues(issues: IntegrityIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
