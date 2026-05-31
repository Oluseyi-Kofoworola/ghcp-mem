import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SessionEvent, CompressedSession, ObservationType, computeContentHash, AzureContextMeta, getConfig } from './types';
import { redact } from './redactor';
import { AzureSubsystem, inferAzureObservationType } from './azureDetect';
import { captureAzureContext } from './azureContext';
import { classifyByRules } from './ruleClassifier';
import { getRepoScope } from './repoScope';

const execAsync = promisify(exec);

/** Resolve the current git branch name, or undefined if not in a git repo. */
async function getCurrentBranch(): Promise<string | undefined> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return undefined;
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd });
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}

export interface CompressorInput {
  events: SessionEvent[];
  sessionStartTime: number;
  captureRedactionCount: number;
  azureSubsystems?: AzureSubsystem[];
  azureTags?: string[];
}

/**
 * AI compressor using vscode.lm.
 * Improvements over claude-mem:
 *   - Auto-classifies observationType (feature/bugfix/refactor/etc.) so callers can filter
 *   - Applies one more pass of redaction on LM output before persisting
 *   - Resilient JSON parsing + fallback path
 */
export class ContextCompressor {
  async compress(input: CompressorInput): Promise<CompressedSession | null> {
    const { events, sessionStartTime, captureRedactionCount } = input;
    const azureSubsystems = input.azureSubsystems ?? [];
    const azureTags = input.azureTags ?? [];
    if (events.length === 0) return null;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspaceName = workspaceFolder?.name ?? 'unknown';
    const workspaceId = workspaceFolder?.uri.toString() ?? 'unknown';
    const eventLog = this.buildEventLog(events);

    // Rule-based pre-classification — stable, cheap, runs before the LM.
    const ruleType = classifyByRules(events, azureSubsystems);
    const ruleHint = ruleType !== 'unknown'
      ? `\n\nRULE CLASSIFIER SUGGESTS: observationType="${ruleType}". Use this unless the event log strongly indicates otherwise.`
      : '';

    const azureHint = azureSubsystems.length
      ? `\n\nAZURE SIGNALS DETECTED: ${azureSubsystems.join(', ')}. Prefer observationType "deployment" (azd/az CLI activity) or "infra" (Bicep/Terraform/ARM authoring) when appropriate.`
      : '';

    const prompt = `You are a coding session analyzer. Analyze the event log below and return EXACTLY this JSON (no markdown fences):

{
  "summary": "2-4 sentence summary of what was accomplished and why",
  "observationType": "one of: feature | bugfix | refactor | docs | test | chore | research | config | security | deployment | infra | unknown",
  "keyFiles": ["max 10 most active files"],
  "keyTopics": ["max 8 topics/technologies/concepts"],
  "decisions": ["architectural/design decisions (or empty array)"],
  "problemsSolved": ["errors fixed / bugs resolved (or empty array)"]${ruleHint}
}

Rules:
- observationType should match the dominant activity in the session
- Never include any token/secret/email in your output — those are already redacted
- summary must be concrete and reference actual file names or topics${azureHint}

SESSION LOG:
${eventLog}`;

    try {
      let model: vscode.LanguageModelChat | undefined;
      const copilotModels = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
      model = copilotModels[0];
      if (!model) {
        const any = await vscode.lm.selectChatModels();
        model = any[0];
      }
      let session: CompressedSession | null;
      if (!model) {
        session = this.fallbackCompress(events, sessionStartTime, workspaceId, workspaceName, captureRedactionCount, azureSubsystems);
      } else {
        session = await this.runCompression(model, prompt, events, sessionStartTime, workspaceId, workspaceName, captureRedactionCount, azureSubsystems);
      }
      if (session) {
        for (const t of azureTags) if (!session.userTags.includes(t)) session.userTags.push(t);
        if (azureSubsystems.length) {
          try {
            const az = await captureAzureContext();
            const meta: AzureContextMeta = { ...az, subsystems: azureSubsystems };
            session.azureContext = meta;
          } catch { /* ignore */ }
        }
        // Best-effort repo-scope tagging. Mirrors GitHub agentic memory's
        // repository-specific scoping so retrieval can be partitioned later.
        try {
          const scope = await getRepoScope();
          session.repoScope = scope.id;
          session.repoScopeLabel = scope.label;
        } catch { /* ignore */ }
        // Stamp the git branch name so sessions can be filtered by branch.
        try {
          session.branchName = await getCurrentBranch();
        } catch { /* ignore */ }
      }
      return session;
    } catch (err) {
      console.warn('[GHCP-MEM] LM compression failed:', err);
      return this.fallbackCompress(events, sessionStartTime, workspaceId, workspaceName, captureRedactionCount, azureSubsystems);
    }
  }

  private async runCompression(
    model: vscode.LanguageModelChat,
    prompt: string,
    events: SessionEvent[],
    sessionStartTime: number,
    workspaceId: string,
    workspaceName: string,
    captureRedactionCount: number,
    azureSubsystems: AzureSubsystem[]
  ): Promise<CompressedSession | null> {
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const cts = new vscode.CancellationTokenSource();
    let response: vscode.LanguageModelChatResponse;
    try {
      response = await model.sendRequest(messages, {}, cts.token);
    } finally {
      cts.dispose();
    }

    let responseText = '';
    for await (const chunk of response.text) responseText += chunk;

    const parsed = this.parseResponse(responseText);
    if (!parsed) {
      return this.fallbackCompress(events, sessionStartTime, workspaceId, workspaceName, captureRedactionCount, azureSubsystems);
    }

    // Defense-in-depth: redact LM output in case it echoed anything sensitive.
    // Also applies any user-defined custom redaction rules.
    const customRules = getConfig().customRedactionRules;
    const sanitize = (s: string) => redact(s, { redactSecrets: true, honorPrivateTags: true, customRules }).text;

    const summary = sanitize(parsed.summary ?? '');
    const keyFiles = (parsed.keyFiles ?? []).map(sanitize);
    const keyTopics = (parsed.keyTopics ?? []).map(sanitize);
    const decisions = (parsed.decisions ?? []).map(sanitize);
    const problemsSolved = (parsed.problemsSolved ?? []).map(sanitize);

    let observationType = this.normalizeType(parsed.observationType);
    if (observationType === 'unknown') {
      const ruleInferred = classifyByRules(events, azureSubsystems);
      if (ruleInferred !== 'unknown') observationType = ruleInferred;
      else {
        const inferred = inferAzureObservationType(azureSubsystems);
        if (inferred) observationType = inferred;
      }
    }

    return {
      id: crypto.randomUUID(),
      workspaceId,
      workspaceName,
      startTime: sessionStartTime,
      endTime: Date.now(),
      summary,
      observationType,
      keyFiles,
      keyTopics,
      decisions,
      problemsSolved,
      rawEventCount: events.length,
      userTags: [],
      redactionCount: captureRedactionCount,
      contentHash: computeContentHash({ summary, keyFiles, keyTopics, decisions, problemsSolved }),
    };
  }

  private normalizeType(raw: unknown): ObservationType {
    const allowed: ObservationType[] = ['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore', 'research', 'config', 'security', 'deployment', 'infra', 'unknown'];
    if (typeof raw === 'string' && (allowed as string[]).includes(raw)) {
      return raw as ObservationType;
    }
    return 'unknown';
  }

  private parseResponse(text: string): {
    summary: string;
    observationType: string;
    keyFiles: string[];
    keyTopics: string[];
    decisions: string[];
    problemsSolved: string[];
  } | null {
    try {
      let clean = text.trim();
      if (clean.startsWith('```')) {
        clean = clean.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      return JSON.parse(clean);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { return JSON.parse(m[0]); } catch { return null; }
      }
      return null;
    }
  }

  private fallbackCompress(
    events: SessionEvent[],
    sessionStartTime: number,
    workspaceId: string,
    workspaceName: string,
    captureRedactionCount: number,
    azureSubsystems: AzureSubsystem[] = []
  ): CompressedSession {
    const fileEdits = events.filter(e => e.type === 'file_edit');
    const diagnostics = events.filter(e => e.type === 'diagnostic_change');
    const fileCreates = events.filter(e => e.type === 'file_create');

    const files = new Set<string>();
    for (const e of events) {
      const d = e.data as { filePath?: string };
      if (d.filePath) files.add(d.filePath);
    }

    const parts: string[] = [];
    if (fileEdits.length) parts.push(`Edited ${fileEdits.length} file(s)`);
    if (fileCreates.length) parts.push(`Created ${fileCreates.length} file(s)`);
    if (diagnostics.length) parts.push(`${diagnostics.length} diagnostic change(s)`);

    let type: CompressedSession['observationType'] = 'unknown';
    const ruleInferred = classifyByRules(events, azureSubsystems);
    if (ruleInferred !== 'unknown') {
      type = ruleInferred;
    } else {
      const azInferred = inferAzureObservationType(azureSubsystems);
      if (azInferred) type = azInferred;
      else if (fileCreates.length > fileEdits.length / 2) type = 'feature';
      else if (diagnostics.length > fileEdits.length) type = 'bugfix';
      else if (fileEdits.length) type = 'refactor';
    }

    const summary = parts.join('. ') + '.';
    const keyFiles = Array.from(files).slice(0, 10);
    return {
      id: crypto.randomUUID(),
      workspaceId,
      workspaceName,
      startTime: sessionStartTime,
      endTime: Date.now(),
      summary,
      observationType: type,
      keyFiles,
      keyTopics: [],
      decisions: [],
      problemsSolved: [],
      rawEventCount: events.length,
      userTags: [],
      redactionCount: captureRedactionCount,
      contentHash: computeContentHash({ summary, keyFiles, keyTopics: [], decisions: [], problemsSolved: [] }),
    };
  }

  private buildEventLog(events: SessionEvent[]): string {
    const MAX = 12000;
    const lines: string[] = [];

    for (const event of events) {
      const time = new Date(event.timestamp).toLocaleTimeString();
      let line: string;
      switch (event.type) {
        case 'file_edit': {
          const d = event.data as import('./types').FileEditData;
          line = `[${time}] EDIT ${d.filePath} (${d.languageId}) +${d.linesAdded}/-${d.linesRemoved} (${d.changeCount})`;
          if (d.snippet) line += `\n  snippet: ${d.snippet.substring(0, 100)}`;
          break;
        }
        case 'file_create': line = `[${time}] CREATE ${(event.data as any).filePath}`; break;
        case 'file_delete': line = `[${time}] DELETE ${(event.data as any).filePath}`; break;
        case 'file_rename': {
          const d = event.data as import('./types').FileLifecycleData;
          line = `[${time}] RENAME ${d.oldPath} -> ${d.filePath}`;
          break;
        }
        case 'file_open': line = `[${time}] OPEN ${(event.data as any).filePath}`; break;
        case 'file_close': line = `[${time}] CLOSE ${(event.data as any).filePath}`; break;
        case 'diagnostic_change': {
          const d = event.data as import('./types').DiagnosticData;
          line = `[${time}] DIAG ${d.filePath} errors=${d.errorCount} warnings=${d.warningCount}`;
          if (d.topMessages[0]) line += `\n  ${d.topMessages[0]}`;
          break;
        }
        case 'git_operation': {
          const d = event.data as import('./types').GitOperationData;
          line = `[${time}] GIT ${d.operation}: ${d.detail}`;
          break;
        }
        case 'debug_session': {
          const d = event.data as import('./types').DebugSessionData;
          line = `[${time}] DEBUG ${d.action} "${d.name}" (${d.type})`;
          break;
        }
        case 'task_run': {
          const d = event.data as import('./types').TaskRunData;
          line = `[${time}] TASK "${d.name}" (${d.source}) exit=${d.exitCode ?? '?'}`;
          break;
        }
        case 'terminal_command': {
          const d = event.data as import('./types').TerminalData;
          line = `[${time}] CMD ${d.command}`;
          break;
        }
        default: line = `[${time}] ${event.type}`;
      }
      lines.push(line);
    }

    let result = lines.join('\n');
    if (result.length > MAX) {
      const cut = Math.floor(lines.length * 0.3);
      const head = lines.slice(0, cut).join('\n');
      const tail = lines.slice(-Math.floor(lines.length * 0.7)).join('\n');
      result = head + '\n\n... [middle truncated] ...\n\n' + tail;
      if (result.length > MAX) result = result.substring(0, MAX) + '\n... [truncated]';
    }
    return result;
  }
}
