import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  SessionEvent,
  CompressedSession,
  ObservationType,
  computeContentHash,
  AzureContextMeta,
  Evidence,
  FileEditData,
  getConfig,
} from './types';
import { redact } from './redactor';
import { AzureSubsystem, inferAzureObservationType } from './azureDetect';
import { captureAzureContext, applyPreserveLevel } from './azureContext';
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

    // Rule-based pre-classification — stable, cheap, runs before the LM.
    const ruleType = classifyByRules(events, azureSubsystems);
    const ruleHint =
      ruleType !== 'unknown'
        ? `\n\nRULE CLASSIFIER SUGGESTS: observationType="${ruleType}". Use this unless the event log strongly indicates otherwise.`
        : '';

    const azureHint = azureSubsystems.length
      ? `\n\nAZURE SIGNALS DETECTED: ${azureSubsystems.join(', ')}. Prefer observationType "deployment" (azd/az CLI activity) or "infra" (Bicep/Terraform/ARM authoring) when appropriate.`
      : '';

    const built = this.buildEventLog(events);
    const eventLog = built.text;
    const eventLogTruncated = built.truncated;

    const prompt = `You are a coding session analyzer. Analyze the event log below and return EXACTLY this JSON (no markdown fences):

{
  "summary": "2-4 sentence summary of what was accomplished and why",
  "observationType": "one of: feature | bugfix | refactor | docs | test | chore | research | config | security | deployment | infra | unknown",
  "keyFiles": ["max 10 most active files"],
  "keyTopics": ["max 8 topics/technologies/concepts"],
  "decisions": [{ "text": "architectural/design decision", "evidence": ["E1","E5"] }],
  "problemsSolved": [{ "text": "error fixed / bug resolved", "evidence": ["E3"] }]${ruleHint}
}

Rules:
- observationType should match the dominant activity in the session
- Never include any token/secret/email in your output — those are already redacted
- summary must be concrete and reference actual file names or topics
- Every decision and problemsSolved entry MUST cite one or more evidence IDs
  from the SESSION LOG below (the [E1], [E2] tags). Entries whose evidence
  list is empty OR cites an unknown ID will be DROPPED — so do not invent
  rationale you cannot point at. Prefer to emit fewer, well-grounded entries
  over many speculative ones.
- If you have no evidence-backed decisions, return "decisions": []. Same for
  problemsSolved.${azureHint}

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
        session = this.fallbackCompress(
          events,
          sessionStartTime,
          workspaceId,
          workspaceName,
          captureRedactionCount,
          azureSubsystems,
          eventLogTruncated,
        );
      } else {
        session = await this.runCompression(
          model,
          prompt,
          events,
          sessionStartTime,
          workspaceId,
          workspaceName,
          captureRedactionCount,
          azureSubsystems,
          eventLogTruncated,
        );
      }
      if (session) {
        for (const t of azureTags) if (!session.userTags.includes(t)) session.userTags.push(t);
        if (azureSubsystems.length) {
          try {
            const az = await captureAzureContext();
            // v1.13.0: gate the persisted snapshot through preserveCloudContextLevel.
            // 'summary-only' (default) redacts subscription/tenant/RG/resourceIds;
            // 'none' skips persisting Azure context entirely; 'full' keeps the
            // pre-v1.13 verbatim behavior.
            const cloudCfg = getConfig();
            const gated = applyPreserveLevel(az, cloudCfg.preserveCloudContextLevel);
            if (gated) {
              const meta: AzureContextMeta = { ...gated, subsystems: azureSubsystems };
              session.azureContext = meta;
            }
          } catch {
            /* ignore */
          }
        }
        // Best-effort repo-scope tagging. Mirrors GitHub agentic memory's
        // repository-specific scoping so retrieval can be partitioned later.
        try {
          const scope = await getRepoScope();
          session.repoScope = scope.id;
          session.repoScopeLabel = scope.label;
        } catch {
          /* ignore */
        }
        // Stamp the git branch name so sessions can be filtered by branch.
        try {
          session.branchName = await getCurrentBranch();
        } catch {
          /* ignore */
        }
      }
      return session;
    } catch (err) {
      console.warn('[GHCP-MEM] LM compression failed:', err);
      return this.fallbackCompress(
        events,
        sessionStartTime,
        workspaceId,
        workspaceName,
        captureRedactionCount,
        azureSubsystems,
        eventLogTruncated,
      );
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
    azureSubsystems: AzureSubsystem[],
    eventLogTruncated: boolean,
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
      return this.fallbackCompress(
        events,
        sessionStartTime,
        workspaceId,
        workspaceName,
        captureRedactionCount,
        azureSubsystems,
        eventLogTruncated,
      );
    }

    // Defense-in-depth: redact LM output in case it echoed anything sensitive.
    // Also applies any user-defined custom redaction rules + NER-lite entities.
    const cfg = getConfig();
    const customRules = cfg.customRedactionRules;
    const customSensitiveEntities = cfg.customSensitiveEntities;
    const sanitize = (s: string) =>
      redact(s, {
        redactSecrets: true,
        honorPrivateTags: true,
        customRules,
        customSensitiveEntities,
      }).text;

    const summary = sanitize(parsed.summary ?? '');
    const keyFiles = (parsed.keyFiles ?? []).map(sanitize);
    const keyTopics = (parsed.keyTopics ?? []).map(sanitize);

    // --- Evidence-grounding gate ---------------------------------------
    // Resolve LM-cited evidence IDs against the table we built. Drop any
    // claim with zero valid citations — this is the mechanism that
    // prevents the compressor from fabricating decisions out of thin
    // event-log noise.
    const evidenceTable = buildEvidenceMap(events);
    const decisionGrounded = groundClaims(parsed.decisions, evidenceTable, sanitize);
    const problemGrounded = groundClaims(parsed.problemsSolved, evidenceTable, sanitize);

    const decisions = decisionGrounded.texts;
    const problemsSolved = problemGrounded.texts;
    const decisionEvidence = decisionGrounded.evidence;
    const problemEvidence = problemGrounded.evidence;

    let observationType = this.normalizeType(parsed.observationType);
    const ruleInferred = classifyByRules(events, azureSubsystems);
    if (observationType === 'unknown') {
      if (ruleInferred !== 'unknown') observationType = ruleInferred;
      else {
        const inferred = inferAzureObservationType(azureSubsystems);
        if (inferred) observationType = inferred;
      }
    }

    const keyFileHashes = collectKeyFileHashes(keyFiles, events);
    const confidence = computeConfidence({
      mode: 'lm',
      redactionCount: captureRedactionCount,
      eventLogTruncated,
      decisionEvidence,
      problemEvidence,
      ruleAgrees: ruleInferred !== 'unknown' && ruleInferred === observationType,
    });

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
      decisionEvidence: decisionEvidence.length ? decisionEvidence : undefined,
      problemEvidence: problemEvidence.length ? problemEvidence : undefined,
      keyFileHashes: Object.keys(keyFileHashes).length ? keyFileHashes : undefined,
      eventLogTruncated: eventLogTruncated || undefined,
      compressorMode: 'lm',
      confidence,
    };
  }

  private normalizeType(raw: unknown): ObservationType {
    const allowed: ObservationType[] = [
      'feature',
      'bugfix',
      'refactor',
      'docs',
      'test',
      'chore',
      'research',
      'config',
      'security',
      'deployment',
      'infra',
      'unknown',
    ];
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
    // Accept either the new grounded shape `{text, evidence[]}` OR the
    // pre-grounding shape `string[]` — we degrade gracefully to legacy when
    // an older model echoes back the wider schema it remembers.
    decisions: Array<string | { text?: string; evidence?: string[] }>;
    problemsSolved: Array<string | { text?: string; evidence?: string[] }>;
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
        try {
          return JSON.parse(m[0]);
        } catch {
          return null;
        }
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
    azureSubsystems: AzureSubsystem[] = [],
    eventLogTruncated = false,
  ): CompressedSession {
    const fileEdits = events.filter((e) => e.type === 'file_edit');
    const diagnostics = events.filter((e) => e.type === 'diagnostic_change');
    const fileCreates = events.filter((e) => e.type === 'file_create');

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
    const keyFileHashes = collectKeyFileHashes(keyFiles, events);
    const confidence = computeConfidence({
      mode: 'fallback',
      redactionCount: captureRedactionCount,
      eventLogTruncated,
      decisionEvidence: [],
      problemEvidence: [],
      ruleAgrees: ruleInferred !== 'unknown' && ruleInferred === type,
    });

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
      contentHash: computeContentHash({
        summary,
        keyFiles,
        keyTopics: [],
        decisions: [],
        problemsSolved: [],
      }),
      keyFileHashes: Object.keys(keyFileHashes).length ? keyFileHashes : undefined,
      eventLogTruncated: eventLogTruncated || undefined,
      compressorMode: 'fallback',
      confidence,
    };
  }

  /**
   * Importance-weighted event-log builder. Replaces the old
   * head-30 / tail-70 truncation that destroyed causal chains.
   *
   * Strategy:
   *  - All non-edit events are high-signal (diagnostics, terminals, git ops,
   *    debug, tasks, file lifecycle) and are kept as long as we have budget.
   *  - File edits are coalesced and ranked by change count; we keep the
   *    highest-impact edits first.
   *  - File open/close are low-signal and dropped first under pressure.
   *  - If we still overflow the byte budget after all of the above, we
   *    return a `truncated: true` flag so the compressor can mark the
   *    session as such and penalise its confidence score.
   *
   * Every emitted line is prefixed with its evidence ID (e.g. `[E12]`) so
   * the LM can cite it from the grounded-decisions JSON schema.
   */
  private buildEventLog(events: SessionEvent[]): { text: string; truncated: boolean } {
    const MAX = 12000;
    const allLines = events.map((event, idx) => ({
      idx,
      type: event.type,
      line: `[${evidenceIdForIndex(idx)}] ${formatEventLine(event)}`,
    }));

    // Rank into priority buckets.
    const HIGH_SIGNAL = new Set([
      'diagnostic_change',
      'terminal_command',
      'git_operation',
      'debug_session',
      'task_run',
      'file_create',
      'file_delete',
      'file_rename',
    ]);
    const LOW_SIGNAL = new Set(['file_open', 'file_close']);

    // Stable sort by priority then original order so output remains
    // chronological within each tier — keeps causal chains readable.
    const tier1 = allLines.filter((l) => HIGH_SIGNAL.has(l.type));
    const tier2 = allLines.filter((l) => l.type === 'file_edit');
    const tier3 = allLines.filter((l) => LOW_SIGNAL.has(l.type));

    // For file_edit (tier2), order by change count desc so we keep the
    // most impactful edits when we have to drop some.
    tier2.sort((a, b) => {
      const ea = events[a.idx]?.data as FileEditData | undefined;
      const eb = events[b.idx]?.data as FileEditData | undefined;
      return (eb?.changeCount ?? 0) - (ea?.changeCount ?? 0);
    });

    const kept: Array<{ idx: number; line: string }> = [];
    let bytes = 0;
    let truncated = false;
    const pushIfFits = (entry: { idx: number; line: string }): boolean => {
      const lineBytes = entry.line.length + 1;
      if (bytes + lineBytes > MAX) {
        truncated = true;
        return false;
      }
      kept.push(entry);
      bytes += lineBytes;
      return true;
    };

    // 1. High-signal first.
    for (const l of tier1) pushIfFits(l);
    // 2. Then file edits ordered by impact.
    for (const l of tier2) pushIfFits(l);
    // 3. Then file_open/close — pure noise, fine to truncate.
    for (const l of tier3) pushIfFits(l);

    // Re-sort the final kept set into chronological order for the LM —
    // priority sorting was only about *which* entries survive, not how
    // they're presented.
    kept.sort((a, b) => a.idx - b.idx);
    return { text: kept.map((k) => k.line).join('\n'), truncated };
  }
}

// ── module-level helpers (kept outside the class so they can be unit-tested) ──

/** Stable evidence ID format. Indices are 0-based but IDs are 1-based for humans. */
export function evidenceIdForIndex(idx: number): string {
  return `E${idx + 1}`;
}

/**
 * Build a lookup map from evidence ID → derived Evidence object covering
 * file path, optional content hash, kind, and original event index. Used by
 * the grounding gate to resolve LM-cited IDs into Evidence records.
 */
export function buildEvidenceMap(events: SessionEvent[]): Map<string, Evidence> {
  const map = new Map<string, Evidence>();
  events.forEach((e, idx) => {
    const ev: Evidence = {
      kind: mapEventKind(e.type),
      eventIndex: idx,
      capturedAt: e.timestamp,
    };
    const data = e.data as { filePath?: string; contentHash?: string; symbolId?: string };
    if (data?.filePath) ev.filePath = data.filePath;
    if (e.type === 'file_edit' && (data as FileEditData)?.contentHash) {
      ev.fileHash = (data as FileEditData).contentHash;
    }
    if (e.type === 'file_edit' && (data as FileEditData)?.symbolId) {
      ev.symbolId = (data as FileEditData).symbolId;
    }
    map.set(evidenceIdForIndex(idx), ev);
  });
  return map;
}

function mapEventKind(t: SessionEvent['type']): Evidence['kind'] {
  switch (t) {
    case 'file_edit':
      return 'file_edit';
    case 'file_create':
      return 'file_create';
    case 'file_delete':
      return 'file_delete';
    case 'file_rename':
      return 'file_rename';
    case 'diagnostic_change':
      return 'diagnostic';
    case 'terminal_command':
      return 'terminal';
    case 'git_operation':
      return 'git';
    case 'task_run':
      return 'task';
    case 'debug_session':
      return 'debug';
    // file_open/file_close still need an evidence kind for the map — bucket
    // them with file_edit since that's the closest semantic neighbour.
    default:
      return 'file_edit';
  }
}

/**
 * Resolve LM-emitted decisions/problems against the evidence table.
 * Drops any entry whose evidence list is empty or whose cited IDs are
 * all unknown. Returns parallel arrays of texts and matching evidence.
 *
 * Accepts both the new `{text, evidence: ID[]}` shape AND legacy `string[]`
 * — legacy strings are dropped (no grounding possible) so older LM responses
 * that ignore the new schema fail safe rather than fail loud.
 */
export function groundClaims(
  raw: Array<string | { text?: string; evidence?: string[] }> | undefined,
  evidenceTable: Map<string, Evidence>,
  sanitize: (s: string) => string,
): { texts: string[]; evidence: Evidence[][] } {
  const texts: string[] = [];
  const evidence: Evidence[][] = [];
  if (!Array.isArray(raw)) return { texts, evidence };

  for (const entry of raw) {
    if (typeof entry === 'string') {
      // Legacy ungrounded shape — drop. The whole point of the gate is that
      // claims without evidence cannot enter the store.
      continue;
    }
    if (!entry || typeof entry.text !== 'string') continue;
    const text = sanitize(entry.text).trim();
    if (!text) continue;
    const citedIds = Array.isArray(entry.evidence) ? entry.evidence : [];
    const resolved: Evidence[] = [];
    for (const id of citedIds) {
      if (typeof id !== 'string') continue;
      const ev = evidenceTable.get(id.trim());
      if (ev) resolved.push(ev);
    }
    if (resolved.length === 0) continue; // ungrounded → drop
    texts.push(text);
    evidence.push(resolved);
  }
  return { texts, evidence };
}

/**
 * Collect the latest content-hash observed for each key file in the event
 * stream. The validator uses this to detect drift after the session lands.
 *
 * Only file_edit events carry contentHash today (set by sessionCapture once
 * the edit batch settles). Other event types contribute the file path but no
 * hash — those entries are simply omitted from the map.
 */
export function collectKeyFileHashes(
  keyFiles: string[],
  events: SessionEvent[],
): Record<string, string> {
  if (!keyFiles.length) return {};
  const wanted = new Set(keyFiles);
  const hashes: Record<string, string> = {};
  // Walk newest-first so the first hash we see per file is the most recent.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'file_edit') continue;
    const d = e.data as FileEditData;
    if (!d.filePath || !d.contentHash) continue;
    if (!wanted.has(d.filePath)) continue;
    if (hashes[d.filePath]) continue;
    hashes[d.filePath] = d.contentHash;
    if (Object.keys(hashes).length === wanted.size) break;
  }
  return hashes;
}

/**
 * Trust-scoring formula used by both the LM and fallback paths. Kept
 * separate so it can be unit-tested and tuned without re-running compressor
 * integration tests.
 *
 *   base 0.5
 *   + 0.20 if any grounded claim cites evidence spanning ≥2 distinct files
 *   + 0.10 if compressorMode === 'lm'
 *   + 0.10 if rule-based classifier agrees with the chosen observationType
 *   − 0.20 if redactionCount > 5            (noisy input → noisy summary)
 *   − 0.10 if eventLogTruncated             (some events were dropped)
 *   clamped to [0, 1]
 */
export function computeConfidence(input: {
  mode: 'lm' | 'fallback';
  redactionCount: number;
  eventLogTruncated: boolean;
  decisionEvidence: Evidence[][];
  problemEvidence: Evidence[][];
  ruleAgrees: boolean;
}): number {
  let score = 0.5;
  const allClaimEvidence = [...input.decisionEvidence, ...input.problemEvidence];
  const distinctFiles = new Set<string>();
  for (const claimEv of allClaimEvidence) {
    for (const ev of claimEv) {
      if (ev.filePath) distinctFiles.add(ev.filePath);
    }
  }
  if (distinctFiles.size >= 2) score += 0.2;
  if (input.mode === 'lm') score += 0.1;
  if (input.ruleAgrees) score += 0.1;
  if (input.redactionCount > 5) score -= 0.2;
  if (input.eventLogTruncated) score -= 0.1;
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

/** Format a single event into a one-line log entry (sans evidence prefix). */
function formatEventLine(event: SessionEvent): string {
  const time = new Date(event.timestamp).toLocaleTimeString();
  switch (event.type) {
    case 'file_edit': {
      const d = event.data as FileEditData;
      let line = `[${time}] EDIT ${d.filePath} (${d.languageId}) +${d.linesAdded}/-${d.linesRemoved} (${d.changeCount})`;
      if (d.snippet) line += `\n  snippet: ${d.snippet.substring(0, 100)}`;
      return line;
    }
    case 'file_create':
      return `[${time}] CREATE ${(event.data as any).filePath}`;
    case 'file_delete':
      return `[${time}] DELETE ${(event.data as any).filePath}`;
    case 'file_rename': {
      const d = event.data as import('./types').FileLifecycleData;
      return `[${time}] RENAME ${d.oldPath} -> ${d.filePath}`;
    }
    case 'file_open':
      return `[${time}] OPEN ${(event.data as any).filePath}`;
    case 'file_close':
      return `[${time}] CLOSE ${(event.data as any).filePath}`;
    case 'diagnostic_change': {
      const d = event.data as import('./types').DiagnosticData;
      let line = `[${time}] DIAG ${d.filePath} errors=${d.errorCount} warnings=${d.warningCount}`;
      if (d.topMessages[0]) line += `\n  ${d.topMessages[0]}`;
      return line;
    }
    case 'git_operation': {
      const d = event.data as import('./types').GitOperationData;
      return `[${time}] GIT ${d.operation}: ${d.detail}`;
    }
    case 'debug_session': {
      const d = event.data as import('./types').DebugSessionData;
      return `[${time}] DEBUG ${d.action} "${d.name}" (${d.type})`;
    }
    case 'task_run': {
      const d = event.data as import('./types').TaskRunData;
      return `[${time}] TASK "${d.name}" (${d.source}) exit=${d.exitCode ?? '?'}`;
    }
    case 'terminal_command': {
      const d = event.data as import('./types').TerminalData;
      return `[${time}] CMD ${d.command}`;
    }
    default:
      return `[${time}] ${event.type}`;
  }
}
