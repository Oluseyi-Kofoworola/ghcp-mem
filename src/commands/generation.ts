/**
 * `@mem` generation commands — handlers that synthesise prose (commit messages,
 * PR bodies, ADRs, stand-ups, recaps, briefings) from captured session memory.
 *
 * Extracted from contextProvider.ts (Phase 2 god-file decomposition). Each
 * handler is a free function taking a CommandContext; the provider dispatches
 * to them with `this`.
 */
import * as vscode from 'vscode';
import { CommandContext } from './context';
import { formatAgo } from '../sessionRender';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CompressedSession } from '../types';
import { matchFilePath } from '../pathMatch';
import { parseInlineFilters, isSafeGitRef, isSafePrNumber } from '../contextProviderFormat';

const execFileAsync = promisify(execFile);

export async function standup(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  const isYesterday = /yesterday|yday|ytd/i.test(query);
  const now = Date.now();
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const windowStart = isYesterday ? dayStart - 86_400_000 : now - 86_400_000;
  const windowEnd = isYesterday ? dayStart : now;

  const sessions = ctx.store
    .getAllSessions()
    .filter(
      (s) => s.endTime >= windowStart && s.endTime <= windowEnd && !s.userTags.includes('private'),
    );

  if (sessions.length === 0) {
    stream.markdown('_No sessions found for this time window. Keep coding and try again later!_\n');
    return;
  }

  const sessionBlocks = sessions
    .map(
      (s) =>
        `[${s.observationType.toUpperCase()}] ${new Date(s.startTime).toLocaleTimeString()}\n` +
        `Summary: ${s.summary}\n` +
        (s.keyFiles.length ? `Files: ${s.keyFiles.slice(0, 5).join(', ')}\n` : '') +
        (s.decisions.length ? `Decisions: ${s.decisions.join('; ')}\n` : '') +
        (s.problemsSolved.length ? `Solved: ${s.problemsSolved.join('; ')}\n` : '') +
        (s.keyTopics.length ? `Topics: ${s.keyTopics.join(', ')}\n` : ''),
    )
    .join('\n---\n');

  const dateLabel = isYesterday
    ? new Date(dayStart - 1).toLocaleDateString()
    : new Date().toLocaleDateString();

  const prompt = [
    'You are a senior software engineer writing a standup note for your team.',
    'Generate a concise, professional standup from the coding sessions below.',
    'Format strictly as:\n## Yesterday\n- ...\n## Today\n- ...\n## Blockers\n- ...',
    'Use past tense for Yesterday. Infer "Today" from open threads and decisions.',
    'If no blockers, write "None".',
    'Keep each bullet under 15 words. Do NOT include the raw session IDs.',
    '',
    `Sessions for ${dateLabel}:`,
    sessionBlocks,
  ].join('\n');

  stream.markdown(`## 📋 Standup · ${dateLabel}\n\n`);
  stream.markdown(
    `_Based on ${sessions.length} session(s) · Copy and paste into your team channel._\n\n---\n\n`,
  );

  await ctx.streamLm(prompt, stream, request, token);

  stream.markdown(
    `\n\n---\n_Powered by GHCP-MEM · [@mem /recap](command:) for a weekly narrative · [@mem /commit](command:) for a commit message_\n`,
  );
}

export async function commit(
  ctx: CommandContext,
  stream: vscode.ChatResponseStream,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) {
    stream.markdown('_Open a workspace with a git repository first._\n');
    return;
  }

  let stagedFiles: string[] = [];
  let diffStat = '';
  let diffSnippet = '';

  try {
    // v1.11.0 hardening: switched from execAsync (shell) to execFileAsync
    // (no shell, args passed individually) to match the existing pattern in
    // /pr (this file:2574, 2590). No user input flows into these argv arrays
    // today, but using a shell here was a needless deviation from the
    // codebase's own security posture and the next maintainer to add a
    // user-supplied flag would have inherited a shell-injection footgun.
    const { stdout: names } = await execFileAsync('git', ['diff', '--cached', '--name-only'], {
      cwd: wsRoot,
    });
    stagedFiles = names.trim().split('\n').filter(Boolean);
    const { stdout: stat } = await execFileAsync('git', ['diff', '--cached', '--stat'], {
      cwd: wsRoot,
    });
    diffStat = stat.trim();
    // Grab a short diff snippet (first 3000 chars of actual diff)
    const { stdout: diff } = await execFileAsync('git', ['diff', '--cached', '--unified=2'], {
      cwd: wsRoot,
    });
    diffSnippet = diff.substring(0, 3000);
  } catch {
    stream.markdown('_No staged changes found. Stage your changes with `git add` first._\n');
    return;
  }

  if (stagedFiles.length === 0) {
    stream.markdown('_No staged files found. Run `git add <files>` before using `/commit`._\n');
    return;
  }

  // Find sessions whose key files overlap with staged files
  const relatedSessions = ctx.store
    .getAllSessions()
    .filter((s) =>
      s.keyFiles.some((f) => stagedFiles.some((sf) => sf.includes(f) || f.includes(sf))),
    )
    .slice(0, 5);

  const sessionContext = relatedSessions.length
    ? '\n\nRelated coding sessions:\n' +
      relatedSessions
        .map(
          (s) =>
            `- [${s.observationType}] ${s.summary.substring(0, 150)}\n` +
            (s.decisions.length ? `  Decisions: ${s.decisions.slice(0, 2).join('; ')}\n` : '') +
            (s.problemsSolved.length
              ? `  Solved: ${s.problemsSolved.slice(0, 2).join('; ')}\n`
              : ''),
        )
        .join('')
    : '';

  const prompt = [
    'Generate a conventional commit message (https://conventionalcommits.org) for these staged changes.',
    'Format: <type>(<optional-scope>): <short description>',
    '',
    'Types: feat, fix, refactor, docs, test, chore, ci, perf, build',
    'Rules: imperative mood, max 72 chars for first line, optional body with "why" not "what".',
    'After the commit message, add a blank line then a short "Why:" paragraph (1-2 sentences).',
    '',
    `Staged files (${stagedFiles.length}):`,
    stagedFiles.slice(0, 20).join('\n'),
    '',
    'Git diff stat:',
    diffStat,
    '',
    'Diff snippet:',
    diffSnippet,
    sessionContext,
  ].join('\n');

  stream.markdown(`## $(git-commit) Commit Message\n\n`);
  stream.markdown(
    `_Staged: \`${stagedFiles.slice(0, 3).join('`, `')}${stagedFiles.length > 3 ? `\` +${stagedFiles.length - 3} more` : '`'}_\n\n`,
  );
  stream.markdown('```\n');

  await ctx.streamLm(prompt, stream, request, token);

  stream.markdown('\n```\n\n');
  stream.markdown('_Copy the block above, then run `git commit -m "<message>"`_\n');
}

export async function ask(
  ctx: CommandContext,
  question: string,
  stream: vscode.ChatResponseStream,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  if (!question) {
    stream.markdown(
      'Ask me anything about your coding history. Example: `@mem /ask why did we change the scoring algorithm?`\n',
    );
    return;
  }

  const { cleaned, filters } = parseInlineFilters(question);
  const hits = ctx.store.search(cleaned || question, filters, 8);

  if (hits.length === 0) {
    stream.markdown(
      `_No sessions found matching your question. Try \`@mem /search ${question}\` for a broader look._\n`,
    );
    return;
  }

  const contextBlocks = hits
    .map(
      (s, i) =>
        `[${i + 1}] Session ${s.id.substring(0, 8)} · ${new Date(s.startTime).toLocaleDateString()} · [${s.observationType}]\n` +
        `${s.summary}\n` +
        (s.keyFiles.length ? `Files: ${s.keyFiles.slice(0, 5).join(', ')}\n` : '') +
        (s.decisions.length ? `Decisions: ${s.decisions.join('; ')}\n` : '') +
        (s.problemsSolved.length ? `Solved: ${s.problemsSolved.join('; ')}\n` : ''),
    )
    .join('\n\n');

  const prompt = [
    "You are answering a developer's question about their own coding history.",
    'Answer concisely and factually based ONLY on the session context below.',
    'When citing a session, use its short ID like: (session abc12345)',
    'If the answer is not in the sessions, say so honestly.',
    '',
    `Developer's question: ${question}`,
    '',
    '--- Session context ---',
    contextBlocks,
    '--- End context ---',
  ].join('\n');

  stream.markdown(`## 🧠 Memory Answer\n\n`);
  stream.markdown(`_Searching ${hits.length} relevant session(s)…_\n\n`);

  await ctx.streamLm(prompt, stream, request, token);

  stream.markdown(
    `\n\n---\n_Cited from ${hits.length} session(s). Use \`@mem /detail <id>\` to expand any session._\n`,
  );
}

export async function recap(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  let days = 7;
  const match = query.match(/(\d+)\s*d/i);
  if (match) days = Math.min(parseInt(match[1], 10), 365);
  else if (/month|30d/i.test(query)) days = 30;
  else if (/quarter|90d/i.test(query)) days = 90;

  const since = Date.now() - days * 86_400_000;
  const sessions = ctx.store
    .getAllSessions()
    .filter((s) => s.endTime >= since && !s.userTags.includes('private'))
    .sort((a, b) => a.startTime - b.startTime);

  if (sessions.length === 0) {
    stream.markdown(`_No sessions in the last ${days} days._\n`);
    return;
  }

  // Group by type
  const byType = new Map<string, CompressedSession[]>();
  for (const s of sessions) {
    const arr = byType.get(s.observationType) ?? [];
    arr.push(s);
    byType.set(s.observationType, arr);
  }

  const allDecisions = Array.from(new Set(sessions.flatMap((s) => s.decisions))).slice(0, 15);
  const allProblems = Array.from(new Set(sessions.flatMap((s) => s.problemsSolved))).slice(0, 10);
  const allTopics = Array.from(new Set(sessions.flatMap((s) => s.keyTopics))).slice(0, 20);
  const allFiles = Array.from(new Set(sessions.flatMap((s) => s.keyFiles))).slice(0, 15);

  const typeBreakdown = Array.from(byType.entries())
    .map(([t, ss]) => `${t}: ${ss.length} session(s)`)
    .join(', ');

  const summaries = sessions
    .slice(0, 20)
    .map(
      (s) =>
        `[${s.observationType}] ${new Date(s.startTime).toLocaleDateString()}: ${s.summary.substring(0, 200)}`,
    )
    .join('\n');

  const prompt = [
    `Write an engaging engineering recap for the last ${days} days of coding work.`,
    'Structure as markdown with these sections:',
    '## What We Built / What Happened',
    '## Key Decisions Made',
    '## Problems Conquered',
    '## Areas of Focus (files & technologies)',
    '## Looking Ahead (infer from open threads)',
    '',
    'Write narratively — not just bullet lists. Highlight patterns and progress.',
    `Tone: professional but human. Total length: ~300 words.`,
    '',
    `Sessions (${sessions.length} total across ${days} days):`,
    `Type breakdown: ${typeBreakdown}`,
    `Topics: ${allTopics.join(', ')}`,
    `Active files: ${allFiles.join(', ')}`,
    '',
    'Session summaries:',
    summaries,
    '',
    `Key decisions: ${allDecisions.join('; ')}`,
    `Problems solved: ${allProblems.join('; ')}`,
  ].join('\n');

  stream.markdown(`## 📰 ${days}-Day Engineering Recap\n\n`);
  stream.markdown(
    `_${sessions.length} sessions · ${new Date(since).toLocaleDateString()} → today_\n\n---\n\n`,
  );

  await ctx.streamLm(prompt, stream, request, token);

  stream.markdown(
    `\n\n---\n_${sessions.length} sessions analysed · Use \`@mem /standup\` for a daily note or \`@mem /export <id>\` to share a session._\n`,
  );
}

export async function whereami(
  ctx: CommandContext,
  stream: vscode.ChatResponseStream,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  const all = ctx.store.getAllSessions();
  if (all.length === 0) {
    stream.markdown(
      '_No sessions found. Start coding and GHCP-MEM will track your work automatically._\n',
    );
    return;
  }

  // Last 3 sessions for context
  const recent = [...all].sort((a, b) => b.endTime - a.endTime).slice(0, 5);
  const last = recent[0];
  const lastDate = new Date(last.endTime).toLocaleString();
  const ago = formatAgo(last.endTime);
  const branch = last.branchName ? ` on \`${last.branchName}\`` : '';

  stream.markdown(`## 🧭 Where You Were\n\n`);
  stream.markdown(`**Last active:** ${lastDate} (${ago})${branch}\n\n`);

  // Extract open TODOs / incomplete signals from recent sessions
  const todoSignals: string[] = [];
  for (const s of recent) {
    for (const p of s.problemsSolved) {
      if (/TODO|FIXME|WIP|incomplete|partial|left off|next step|still need/i.test(p)) {
        todoSignals.push(`- ${p} _(${new Date(s.startTime).toLocaleDateString()})_`);
      }
    }
    for (const d of s.decisions) {
      if (/TODO|FIXME|WIP|incomplete|still need|plan to|will|next/i.test(d)) {
        todoSignals.push(`- ${d} _(${new Date(s.startTime).toLocaleDateString()})_`);
      }
    }
  }

  // Summary of last 3 sessions
  stream.markdown(`### 📋 Recent Activity\n\n`);
  for (const s of recent.slice(0, 3)) {
    const when = formatAgo(s.endTime);
    const br = s.branchName ? ` · \`${s.branchName}\`` : '';
    stream.markdown(`**${when}** [${s.observationType}]${br}\n${s.summary.substring(0, 200)}\n\n`);
    if (s.keyFiles.length) {
      stream.markdown(
        `_Files: ${s.keyFiles
          .slice(0, 4)
          .map((f) => `\`${f}\``)
          .join(', ')}_\n\n`,
      );
    }
  }

  if (todoSignals.length > 0) {
    stream.markdown(`### ⚠️ Likely Open Threads\n\n`);
    stream.markdown(todoSignals.slice(0, 8).join('\n') + '\n\n');
  }

  // AI re-entry brief
  stream.markdown(`### 🤖 Re-entry Brief\n\n`);
  const recentContext = recent
    .slice(0, 3)
    .map(
      (s) =>
        `[${new Date(s.startTime).toLocaleDateString()} · ${s.observationType}] ${s.summary}\nFiles: ${s.keyFiles.slice(0, 5).join(', ')}\nDecisions: ${s.decisions.slice(0, 3).join('; ')}`,
    )
    .join('\n\n');

  const prompt = [
    'A developer is returning to work after a break. Based on their recent coding sessions below, write a concise re-entry brief (4-6 sentences):',
    '1. What they were working on',
    '2. Where they likely left off',
    '3. The single most important next step to get back into flow',
    'Be direct and practical. No preamble.',
    '',
    'Recent sessions:',
    recentContext,
  ].join('\n');

  await ctx.streamLm(prompt, stream, request, token);

  stream.markdown(
    `\n\n---\n_Use \`@mem /standup\` for a daily summary or \`@mem /debt\` to see open technical debt._\n`,
  );
}

export async function debt(
  ctx: CommandContext,
  stream: vscode.ChatResponseStream,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  const all = ctx.store.getAllSessions();
  if (all.length === 0) {
    stream.markdown(
      '_No sessions found yet — GHCP-MEM will detect debt signals automatically as you code._\n',
    );
    return;
  }

  const DEBT_PATTERNS = [
    /TODO/i,
    /FIXME/i,
    /HACK/i,
    /XXX/i,
    /WORKAROUND/i,
    /quick.?fix/i,
    /shortcut/i,
    /tech.?debt/i,
    /temporary/i,
    /revisit/i,
    /clean.?up/i,
    /refactor/i,
    /not.?ideal/i,
    /should.?be/i,
    /needs?.to/i,
    /broken/i,
    /fragile/i,
  ];

  interface DebtItem {
    text: string;
    file?: string;
    date: string;
    age: number; // days
    type: string;
    sessionId: string;
  }

  const debtItems: DebtItem[] = [];
  const seen = new Set<string>();

  for (const s of [...all].sort((a, b) => a.startTime - b.startTime)) {
    const allTexts = [
      ...s.problemsSolved.map((t) => ({ text: t, file: s.keyFiles[0] })),
      ...s.decisions.map((t) => ({ text: t, file: s.keyFiles[0] })),
      ...(s.summary ? [{ text: s.summary, file: s.keyFiles[0] }] : []),
    ];

    for (const { text, file } of allTexts) {
      if (DEBT_PATTERNS.some((p) => p.test(text))) {
        // Extract the specific sentence with the debt signal
        const sentences = text.split(/[.!?\n]/).filter((t) => t.trim());
        for (const sentence of sentences) {
          if (DEBT_PATTERNS.some((p) => p.test(sentence))) {
            const key = sentence.trim().toLowerCase().substring(0, 80);
            if (!seen.has(key) && sentence.trim().length > 10) {
              seen.add(key);
              debtItems.push({
                text: sentence.trim(),
                file,
                date: new Date(s.startTime).toLocaleDateString(),
                age: Math.round((Date.now() - s.startTime) / 86_400_000),
                type: s.observationType,
                sessionId: s.id.substring(0, 8),
              });
            }
          }
        }
      }
    }
  }

  if (debtItems.length === 0) {
    stream.markdown('## 🏆 Technical Debt Ledger\n\n');
    stream.markdown('_No debt signals detected in session history. Keep it clean!_\n\n');
    stream.markdown(
      '_GHCP-MEM looks for: TODO, FIXME, HACK, workaround, quick fix, refactor, fragile, and similar signals._\n',
    );
    return;
  }

  // Sort by age (oldest first — highest priority)
  debtItems.sort((a, b) => b.age - a.age);

  // Group by age buckets
  const old = debtItems.filter((d) => d.age > 30);
  const medium = debtItems.filter((d) => d.age > 7 && d.age <= 30);
  const fresh = debtItems.filter((d) => d.age <= 7);

  stream.markdown(`## ⚠️ Technical Debt Ledger\n\n`);
  stream.markdown(`_${debtItems.length} debt signal(s) found across ${all.length} sessions_\n\n`);

  const renderGroup = (label: string, icon: string, items: DebtItem[]) => {
    if (items.length === 0) return;
    stream.markdown(`### ${icon} ${label} (${items.length})\n\n`);
    for (const d of items.slice(0, 10)) {
      const file = d.file ? ` · \`${d.file}\`` : '';
      stream.markdown(
        `- **${d.text.substring(0, 120)}**  \n  _${d.date} · ${d.age}d ago${file} · session \`${d.sessionId}\`_\n`,
      );
    }
    if (items.length > 10) stream.markdown(`_...and ${items.length - 10} more_\n`);
    stream.markdown('\n');
  };

  renderGroup('Critical — older than 30 days', '🔴', old);
  renderGroup('Aging — 8–30 days', '🟡', medium);
  renderGroup('Recent — last 7 days', '🟢', fresh);

  // AI prioritisation
  stream.markdown('---\n\n### 🤖 AI Prioritisation\n\n');
  const topDebt = debtItems
    .slice(0, 15)
    .map((d) => `- [${d.age}d old] ${d.text}`)
    .join('\n');
  const prompt = [
    "Below is a list of technical debt items extracted from a developer's coding session history.",
    'Write a prioritised action plan (max 5 items) focusing on:',
    '1. Items that are oldest and most likely to cause problems',
    '2. Items that are blocking other work',
    '3. Quick wins that can be resolved in < 1 hour',
    'Format as a numbered list. Be concise and actionable.',
    '',
    'Debt items:',
    topDebt,
  ].join('\n');

  await ctx.streamLm(prompt, stream, request, token);
  stream.markdown(
    `\n\n---\n_Use \`@mem /precommit\` before your next commit to check for architectural regressions._\n`,
  );
}

export async function adr(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  let sessions = ctx.store
    .getAllSessions()
    .filter((s) => s.decisions.length > 0 || s.keyTopics.length > 0);

  if (query) {
    const q = query.toLowerCase();
    sessions = sessions.filter(
      (s) =>
        s.decisions.some((d) => d.toLowerCase().includes(q)) ||
        s.keyTopics.some((t) => t.toLowerCase().includes(q)) ||
        s.summary.toLowerCase().includes(q),
    );
  }

  if (sessions.length === 0) {
    stream.markdown(
      query
        ? `_No sessions found matching "${query}". Try a broader term or run \`@mem /decisions\` to see all recorded decisions._\n`
        : '_No sessions with decisions found yet. GHCP-MEM extracts decisions automatically as you code._\n',
    );
    return;
  }

  // Collect all decisions and topics
  const allDecisions = sessions.flatMap((s) => s.decisions);
  const allTopics = sessions.flatMap((s) => s.keyTopics);
  const allSummaries = sessions.map((s) => s.summary);
  const allFiles = [...new Set(sessions.flatMap((s) => s.keyFiles))].slice(0, 20);
  const dateRange =
    sessions.length > 0
      ? `${new Date(Math.min(...sessions.map((s) => s.startTime))).toLocaleDateString()} – ${new Date(Math.max(...sessions.map((s) => s.endTime))).toLocaleDateString()}`
      : 'unknown';

  stream.markdown(`## 📄 Architecture Decision Record\n\n`);
  if (query)
    stream.markdown(`_Topic: "${query}" · ${sessions.length} session(s) · ${dateRange}_\n\n`);
  else stream.markdown(`_${sessions.length} session(s) with decisions · ${dateRange}_\n\n`);
  stream.markdown(
    `_Affected files: ${allFiles
      .slice(0, 8)
      .map((f) => `\`${f}\``)
      .join(', ')}_\n\n`,
  );
  stream.markdown('---\n\n');

  const prompt = [
    'Generate a formal Architecture Decision Record (ADR) based on the developer session history below.',
    'Use this exact structure:',
    '',
    '# ADR: [descriptive title]',
    '',
    '## Status',
    'Accepted | Proposed | Deprecated (choose the most appropriate)',
    '',
    '## Context',
    'What problem or need drove this decision? What was the situation?',
    '',
    '## Decision',
    'What was decided? Be specific and authoritative.',
    '',
    '## Options Considered',
    'List 2-3 alternatives that were likely considered (infer from context if needed).',
    '',
    '## Consequences',
    '### Positive',
    '- list benefits',
    '### Negative / Trade-offs',
    '- list downsides or constraints',
    '',
    '## Related Files',
    'List the key files involved.',
    '',
    'Base the ADR on these session insights:',
    '',
    `Decisions recorded:\n${allDecisions
      .slice(0, 20)
      .map((d) => `- ${d}`)
      .join('\n')}`,
    '',
    `Topics:\n${allTopics.slice(0, 15).join(', ')}`,
    '',
    `Session summaries:\n${allSummaries.slice(0, 5).join('\n---\n')}`,
  ].join('\n');

  await ctx.streamLm(prompt, stream, request, token);

  stream.markdown(
    `\n\n---\n_Run \`@mem /decisions\` to see all decisions · \`@mem /adr <topic>\` to generate a focused ADR_\n`,
  );
}

export async function pr(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  stream.markdown(`## 🔍 PR Review Context\n\n`);

  // Get changed files from git diff
  let changedFiles: string[] = [];
  let branchLabel = query || 'current branch';

  try {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) throw new Error('No workspace open');

    if (query && /^\d+$/.test(query.trim())) {
      // PR number — try to get via gh CLI.
      // Defensive validation: even though the regex above narrows to digits,
      // we re-check via the dedicated whitelist before any spawn — so
      // future edits to the branching logic don't accidentally re-open the
      // shell-injection surface (see security audit findings).
      const prNum = query.trim();
      if (!isSafePrNumber(prNum)) {
        stream.markdown(`PR identifier must be a positive integer.\n`);
        return;
      }
      try {
        // execFile (no shell) with args as an array — `prNum` cannot
        // break out of the arg vector to inject extra commands.
        const { stdout } = await execFileAsync(
          'gh',
          ['pr', 'view', prNum, '--json', 'files', '--jq', '.files[].path'],
          { cwd },
        );
        changedFiles = stdout
          .split('\n')
          .map((f) => f.trim())
          .filter(Boolean);
      } catch {
        // gh CLI missing / not authenticated / network error — fall through to active-file fallback below.
      }
      branchLabel = `PR #${prNum}`;
    } else {
      // Branch name or default: diff against the user-supplied ref or HEAD~1.
      const base = query.trim() || 'HEAD~1';
      if (!isSafeGitRef(base)) {
        stream.markdown(
          `Branch / ref contains disallowed characters. Use letters, digits, \`._/-~^@\` only.\n`,
        );
        return;
      }
      try {
        // execFile (no shell) with args as an array — `base` cannot
        // break out of the arg vector to inject extra commands. We try
        // the user-supplied ref first; if that fails (e.g. unknown ref)
        // we fall back to HEAD~1 in a separate spawn rather than via
        // shell `||` chaining.
        const { stdout } = await execFileAsync('git', ['diff', '--name-only', base], { cwd });
        changedFiles = stdout
          .split('\n')
          .map((f) => f.trim())
          .filter(Boolean);
      } catch {
        try {
          const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD~1'], {
            cwd,
          });
          changedFiles = stdout
            .split('\n')
            .map((f) => f.trim())
            .filter(Boolean);
        } catch {
          /* nothing to show */
        }
      }
      if (query) branchLabel = query;
    }
  } catch {
    // fallback: use active editor file
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (active) {
      changedFiles = [vscode.workspace.asRelativePath(active)];
      branchLabel = 'active file';
    }
  }

  if (changedFiles.length === 0) {
    stream.markdown(
      '_No changed files detected. Specify a branch: `@mem /pr main` or open a file and run `@mem /related`._\n',
    );
    return;
  }

  stream.markdown(`_Analysing ${changedFiles.length} changed file(s) in **${branchLabel}**_\n\n`);
  stream.markdown(
    `Changed: ${changedFiles
      .slice(0, 10)
      .map((f) => `\`${f}\``)
      .join(', ')}${changedFiles.length > 10 ? ` _+${changedFiles.length - 10} more_` : ''}\n\n`,
  );

  // Find sessions that touched any of these files
  const all = ctx.store.getAllSessions();
  const matchMap = new Map<string, { session: (typeof all)[0]; matchedFiles: string[] }>();

  for (const s of all) {
    const matched = s.keyFiles.filter((sf) => changedFiles.some((cf) => matchFilePath(sf, cf)));
    if (matched.length > 0) {
      matchMap.set(s.id, { session: s, matchedFiles: matched });
    }
  }

  const matches = [...matchMap.values()].sort((a, b) => b.session.endTime - a.session.endTime);

  if (matches.length === 0) {
    stream.markdown(
      `_No session history found for these files. They may be new files or not yet captured._\n`,
    );
    return;
  }

  stream.markdown(`### 📚 ${matches.length} Session(s) with history for these files\n\n`);

  for (const { session: s, matchedFiles } of matches.slice(0, 8)) {
    const ago = formatAgo(s.endTime);
    const branch = s.branchName ? ` · \`${s.branchName}\`` : '';
    stream.markdown(`#### [${s.observationType}] ${ago}${branch}\n\n`);
    stream.markdown(`_Matching files: ${matchedFiles.map((f) => `\`${f}\``).join(', ')}_\n\n`);
    stream.markdown(`${s.summary.substring(0, 250)}\n\n`);
    if (s.decisions.length)
      stream.markdown(`**Decisions:** ${s.decisions.slice(0, 3).join(' · ')}\n\n`);
    if (s.problemsSolved.length)
      stream.markdown(`**Solved:** ${s.problemsSolved.slice(0, 2).join(' · ')}\n\n`);
    stream.markdown(
      `\`${s.id.substring(0, 8)}\` · _\`@mem /detail ${s.id.substring(0, 8)}\` for full context_\n\n---\n\n`,
    );
  }

  // AI reviewer briefing
  if (matches.length > 0) {
    stream.markdown('### 🤖 Reviewer Briefing\n\n');
    const historyContext = matches
      .slice(0, 5)
      .map(
        ({ session: s, matchedFiles }) =>
          `Files: ${matchedFiles.join(', ')}\n[${s.observationType}] ${s.summary}\nDecisions: ${s.decisions.slice(0, 3).join('; ')}`,
      )
      .join('\n\n');

    const prompt = [
      `A developer is reviewing a PR that changes: ${changedFiles.slice(0, 10).join(', ')}.`,
      'Based on the session history for these files below, write a reviewer briefing (3-5 sentences) covering:',
      '1. What purpose these files serve based on history',
      '2. Known past issues or fragility the reviewer should watch for',
      '3. Key decisions that were made about these files',
      'Be concise and focused on what helps the reviewer.',
      '',
      'Session history:',
      historyContext,
    ].join('\n');

    await ctx.streamLm(prompt, stream, request, token);
  }

  stream.markdown(
    `\n\n---\n_Use \`@mem /pr <branch>\` for a different branch or \`@mem /decisions\` for architectural context._\n`,
  );
}

export async function precommit(
  ctx: CommandContext,
  stream: vscode.ChatResponseStream,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  stream.markdown(`## 🔎 Pre-commit Architectural Check\n\n`);

  // Get staged diff
  let stagedDiff = '';
  let stagedFiles: string[] = [];

  try {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) throw new Error('No workspace open');

    // v1.11.0 hardening: same execFile switch as /commit. The shell-piped
    // `2>/dev/null || echo ""` fallback is preserved in spirit by simply
    // returning an empty array on caught error — execFile rejects with a
    // non-zero exit code instead, which the surrounding try/catch handles.
    try {
      const { stdout: filesOut } = await execFileAsync('git', ['diff', '--cached', '--name-only'], {
        cwd,
      });
      stagedFiles = filesOut
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {
      stagedFiles = [];
    }

    if (stagedFiles.length === 0) {
      stream.markdown(
        '_No staged changes found. Run `git add <files>` first, then `@mem /precommit`._\n',
      );
      return;
    }

    try {
      const { stdout: diffOut } = await execFileAsync('git', ['diff', '--cached', '--stat'], {
        cwd,
      });
      stagedDiff = diffOut.substring(0, 2000); // Keep it manageable
    } catch {
      stagedDiff = '';
    }
  } catch {
    stream.markdown(
      '_Could not read staged diff. Ensure you are in a git repository with staged changes._\n',
    );
    return;
  }

  stream.markdown(
    `_Checking ${stagedFiles.length} staged file(s): ${stagedFiles
      .slice(0, 5)
      .map((f) => `\`${f}\``)
      .join(', ')}${stagedFiles.length > 5 ? ` +${stagedFiles.length - 5} more` : ''}_\n\n`,
  );

  // Find sessions related to staged files
  const all = ctx.store.getAllSessions();
  const relatedSessions = all
    .filter((s) => s.keyFiles.some((sf) => stagedFiles.some((pf) => matchFilePath(sf, pf))))
    .sort((a, b) => b.endTime - a.endTime);

  // Collect all decisions from related sessions
  const relevantDecisions = relatedSessions.flatMap((s) => s.decisions).slice(0, 20);
  const allDecisions = all
    .filter((s) => s.decisions.length > 0)
    .flatMap((s) => s.decisions)
    .slice(0, 30);

  if (relevantDecisions.length === 0 && allDecisions.length === 0) {
    stream.markdown(
      '_No architectural decisions found in session history to check against. Keep capturing sessions to build up the decision history._\n',
    );
    return;
  }

  const decisionsContext =
    relevantDecisions.length > 0
      ? `Decisions about these specific files:\n${relevantDecisions.map((d) => `- ${d}`).join('\n')}`
      : `General architectural decisions:\n${allDecisions
          .slice(0, 15)
          .map((d) => `- ${d}`)
          .join('\n')}`;

  stream.markdown('### 🤖 Consistency Analysis\n\n');

  const prompt = [
    'A developer is about to commit the following changes. Check if they are consistent with past architectural decisions.',
    '',
    `Staged files: ${stagedFiles.slice(0, 10).join(', ')}`,
    '',
    `Diff summary:\n${stagedDiff}`,
    '',
    decisionsContext,
    '',
    'Provide a structured review with:',
    '1. **✅ Consistent with:** decisions this commit aligns with',
    '2. **⚠️ Potential conflicts:** any decisions this might contradict (be specific)',
    '3. **💡 Recommendation:** one-line verdict — Safe to commit / Review these concerns / Reconsider approach',
    '',
    'If no conflicts found, say so clearly and confidently. Be direct and concise.',
  ].join('\n');

  await ctx.streamLm(prompt, stream, request, token);

  stream.markdown(
    `\n\n---\n_Run \`@mem /commit\` to generate a conventional commit message for these changes._\n`,
  );
}

export async function decisions(
  ctx: CommandContext,
  query: string,
  stream: vscode.ChatResponseStream,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  let sessions = ctx.store.getAllSessions().filter((s) => s.decisions.length > 0);

  if (query) {
    const q = query.toLowerCase();
    sessions = sessions.filter(
      (s) =>
        s.decisions.some((d) => d.toLowerCase().includes(q)) ||
        s.keyTopics.some((t) => t.toLowerCase().includes(q)) ||
        s.summary.toLowerCase().includes(q),
    );
  }

  if (sessions.length === 0) {
    stream.markdown(
      query
        ? `_No decisions found matching "${query}"._\n`
        : '_No decisions recorded yet. GHCP-MEM will extract decisions automatically as you code._\n',
    );
    return;
  }

  // Deduplicate decisions, keeping track of when each was made
  type DecisionEntry = {
    decision: string;
    date: string;
    type: string;
    sessionId: string;
    branch?: string;
  };
  const seen = new Set<string>();
  const allDecisions: DecisionEntry[] = [];

  for (const s of sessions.sort((a, b) => a.startTime - b.startTime)) {
    for (const d of s.decisions) {
      const key = d.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        allDecisions.push({
          decision: d,
          date: new Date(s.startTime).toLocaleDateString(),
          type: s.observationType,
          sessionId: s.id.substring(0, 8),
          branch: s.branchName,
        });
      }
    }
  }

  if (allDecisions.length === 0) {
    stream.markdown('_No unique decisions found._\n');
    return;
  }

  const title = query ? `Decisions matching "${query}"` : 'All Architecture Decisions';
  stream.markdown(`## 📋 ${title}\n\n`);
  stream.markdown(
    `_${allDecisions.length} unique decision(s) across ${sessions.length} session(s)_\n\n`,
  );

  // Group by type for scannability
  const byType = new Map<string, DecisionEntry[]>();
  for (const d of allDecisions) {
    const arr = byType.get(d.type) ?? [];
    arr.push(d);
    byType.set(d.type, arr);
  }

  for (const [type, entries] of Array.from(byType.entries()).sort()) {
    stream.markdown(`### ${type.charAt(0).toUpperCase() + type.slice(1)}\n\n`);
    for (const e of entries) {
      const branch = e.branch ? ` · \`${e.branch}\`` : '';
      stream.markdown(
        `- **${e.decision}**  \n  _${e.date}${branch} · session \`${e.sessionId}\`_\n`,
      );
    }
    stream.markdown('\n');
  }

  // Use LM to synthesise a brief narrative if there are enough decisions
  if (allDecisions.length >= 5) {
    stream.markdown('---\n\n### 🤖 AI Summary\n\n');
    const decisionList = allDecisions
      .slice(0, 30)
      .map((d) => `- ${d.decision}`)
      .join('\n');
    const prompt = [
      "Below is a list of architecture and implementation decisions extracted from a developer's coding sessions.",
      'Write a brief (3-5 sentence) narrative that identifies the key themes, patterns, and architectural direction these decisions reflect.',
      "Focus on what they reveal about the codebase's design philosophy. Be concise and insightful.",
      '',
      'Decisions:',
      decisionList,
    ].join('\n');
    await ctx.streamLm(prompt, stream, request, token);
  }

  stream.markdown(
    `\n\n---\n_Use \`@mem /decisions <keyword>\` to filter · \`@mem /detail <id>\` for session context_\n`,
  );
}
