import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ContextStore, SearchFilters } from './contextStore';
import { ObservationType, computeContentHash, CompressedSession } from './types';
import { redact } from './redactor';

/**
 * Language Model Tool — lets Copilot *agent mode* invoke GHCP-MEM search
 * automatically, as a first-class tool call.
 *
 * This is VS Code's native equivalent of exposing an MCP server: by
 * registering a tool with `vscode.lm.registerTool`, Copilot picks it up
 * with zero extra configuration. No stdio MCP process, no port, no
 * external binary — the whole reason GHCP-MEM exists.
 */
interface SearchToolInput {
  query: string;
  type?: ObservationType;
  sinceDays?: number;
  workspaceOnly?: boolean;
  tag?: string;
  limit?: number;
}

export class MemorySearchTool implements vscode.LanguageModelTool<SearchToolInput> {
  constructor(private readonly store: ContextStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SearchToolInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    const filters: SearchFilters = {
      type: input.type,
      workspaceOnly: input.workspaceOnly ?? true,
      tag: input.tag,
    };
    if (typeof input.sinceDays === 'number' && input.sinceDays > 0) {
      filters.sinceTs = Date.now() - input.sinceDays * 24 * 60 * 60 * 1000;
    }

    const limit = Math.max(1, Math.min(25, input.limit ?? 5));
    const results = await this.store.searchWithEmbedding(input.query ?? '', filters, limit);

    if (results.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`No sessions found for query "${input.query}".`),
      ]);
    }

    const lines: string[] = [`Found ${results.length} session(s) for "${input.query}":`, ''];
    for (const s of results) {
      const date = new Date(s.startTime).toISOString().slice(0, 10);
      const tags = s.userTags.length ? ` tags=[${s.userTags.join(',')}]` : '';
      lines.push(`- id=${s.id.substring(0, 8)} date=${date} type=${s.observationType}${tags}`);
      lines.push(`  summary: ${s.summary}`);
      if (s.keyFiles.length) lines.push(`  files: ${s.keyFiles.slice(0, 5).join(', ')}`);
      if (s.decisions.length) lines.push(`  decisions: ${s.decisions.slice(0, 3).join('; ')}`);
      if (s.problemsSolved.length)
        lines.push(`  solved: ${s.problemsSolved.slice(0, 3).join('; ')}`);
    }

    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<SearchToolInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `Searching GHCP-MEM for "${options.input.query}"…`,
    };
  }
}

/**
 * Companion tool — lets agent mode save a one-shot note into memory without
 * waiting for the next compression pass. Useful when the model wants to
 * "remember" a user-provided fact or decision.
 */
interface StoreToolInput {
  summary: string;
  observationType?: ObservationType;
  keyTopics?: string[];
  keyFiles?: string[];
  decisions?: string[];
  problemsSolved?: string[];
  tags?: string[];
}

export class MemoryStoreTool implements vscode.LanguageModelTool<StoreToolInput> {
  constructor(private readonly store: ContextStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<StoreToolInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (!input.summary || input.summary.trim().length < 4) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('Refusing to store: summary is missing or too short.'),
      ]);
    }

    // Redact secrets from all user-provided text before persisting.
    // Accumulate redaction count so the health score sees accurate coverage.
    let totalRedactions = 0;
    const redactStr = (s: string) => {
      const r = redact(s, { redactSecrets: true, honorPrivateTags: true });
      totalRedactions += r.redactionCount;
      return r.text;
    };

    const ws = vscode.workspace.workspaceFolders?.[0];
    const now = Date.now();
    const summary = redactStr(input.summary.trim());
    const keyFiles = (input.keyFiles ?? []).slice(0, 10).map(redactStr);
    const keyTopics = (input.keyTopics ?? []).slice(0, 10).map(redactStr);
    const decisions = (input.decisions ?? []).slice(0, 10).map(redactStr);
    const problemsSolved = (input.problemsSolved ?? []).slice(0, 10).map(redactStr);

    const session: CompressedSession = {
      id: crypto.randomUUID(),
      workspaceId: ws?.uri.toString() ?? 'unknown',
      workspaceName: ws?.name ?? 'unknown',
      startTime: now,
      endTime: now,
      summary,
      observationType: input.observationType ?? 'research',
      keyFiles,
      keyTopics,
      decisions,
      problemsSolved,
      rawEventCount: 0,
      userTags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
      redactionCount: totalRedactions,
      contentHash: computeContentHash({ summary, keyFiles, keyTopics, decisions, problemsSolved }),
    };

    await this.store.addSession(session);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `Stored session ${session.id.substring(0, 8)} (${session.observationType}).`,
      ),
    ]);
  }

  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<StoreToolInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: 'Saving a note to GHCP-MEM…' };
  }
}

/**
 * Workspace integrity auditor — lets Copilot agent mode spot-check the
 * workspace for cross-file inconsistencies (e.g. version drift between
 * package.json, README, DEMO.md, CHANGELOG.md).
 *
 * Companion to the release-consistency gate that runs in CI / vscode:prepublish.
 * The gate blocks vsce publish; this tool surfaces the same checks any time,
 * for any agent flow.
 */
interface AuditToolInput {
  /** Future: filter to a subset of rules. Currently ignored — runs all. */
  rules?: string[];
}

export class MemoryAuditTool implements vscode.LanguageModelTool<AuditToolInput> {
  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<AuditToolInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { runWorkspaceAudit } = await import('./integrityChecker');
    const { issues, rulesRun } = await runWorkspaceAudit();

    if (rulesRun.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('No workspace folder open — nothing to audit.'),
      ]);
    }

    if (issues.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Ran ${rulesRun.length} integrity rule(s) (${rulesRun.join(', ')}). No issues found — every checked surface is consistent.`,
        ),
      ]);
    }

    const lines: string[] = [
      `Ran ${rulesRun.length} integrity rule(s) (${rulesRun.join(', ')}). Found ${issues.length} issue(s):`,
      '',
    ];
    for (const i of issues) {
      const sev = i.severity === 'error' ? '❌' : i.severity === 'warning' ? '⚠️' : 'ℹ️';
      const loc = i.line ? `${i.file}:${i.line}` : i.file;
      lines.push(`${sev} [${i.rule}] ${loc} — ${i.message}`);
      if (i.fix) lines.push(`     fix: ${i.fix}`);
    }
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
  }

  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<AuditToolInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: 'Running GHCP-MEM workspace integrity audit…' };
  }
}
