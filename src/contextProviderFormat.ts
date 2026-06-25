/**
 * Pure formatting / parsing / validation helpers extracted from
 * `contextProvider.ts` to keep that file focused on the chat-participant and
 * slash-command orchestration. Everything here is side-effect-free and depends
 * only on its arguments — no `this`, no VS Code APIs — so it is trivially
 * unit-testable in isolation.
 */
import type { CompressedSession, Evidence, ObservationType } from './types';
import type { SearchFilters } from './contextStore';
import { effectiveConfidence } from './decay';

/**
 * Whitelist-validate a git ref / branch name supplied by the user via chat.
 *
 * Used by `/pr <branch>` to ensure the value cannot break out of the argument
 * vector and execute an arbitrary shell command. The pattern permits the
 * characters git itself accepts (letters, digits, slashes, `_-.`, plus `~` and
 * `^` for `HEAD~1` / `HEAD^2`) and nothing else — so meta characters like `;`,
 * `|`, `` ` ``, `$()`, newlines, spaces, and backslashes are all rejected
 * before they ever reach the shell or the spawn syscall.
 *
 * Length-capped at 200 to avoid degenerate inputs.
 */
export function isSafeGitRef(input: string): boolean {
  return /^[A-Za-z0-9._/\-~^@]{1,200}$/.test(input);
}

/**
 * Whitelist-validate a numeric PR identifier. PRs are always positive
 * integers — anything else means the user typed something we should refuse.
 */
export function isSafePrNumber(input: string): boolean {
  return /^[0-9]{1,8}$/.test(input);
}

/**
 * Format a startup-inject timestamp as `M/D/YYYY HH:MM` (24h, local).
 */
export function formatInjectTimestamp(ts: number): string {
  const d = new Date(ts);
  const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
}

/**
 * Render the trust badge appended to each injected session header.
 *  🟢 confidence ≥ 0.75
 *  🟡 0.50 ≤ confidence < 0.75
 *  🔴 confidence < 0.50
 * Legacy sessions (no confidence stored) are rendered without a badge so
 * existing snapshots keep their compact header format.
 *
 * Uses the time-decayed `effectiveConfidence` so untouched memories also
 * fade — keeps the displayed trust in sync with the ranking signal.
 */
export function renderTrustBadge(s: CompressedSession): string {
  const c = effectiveConfidence(s);
  if (typeof c !== 'number') return '';
  const emoji = c >= 0.75 ? '🟢' : c >= 0.5 ? '🟡' : '🔴';
  return ` · ${emoji} conf:${c.toFixed(2)}`;
}

/**
 * Render a parallel list of claim texts and their evidence arrays.
 *
 * Each claim is rendered as `text [📎file1, file2]` so the LLM consumer (and a
 * human reading the injected file) sees the provenance inline without
 * ballooning the token cost. Legacy sessions whose evidence arrays are missing
 * fall back to the plain `text` form.
 */
export function renderClaimList(texts: string[], evidence?: Evidence[][]): string {
  return texts
    .map((text, i) => {
      const ev = evidence?.[i];
      if (!ev || ev.length === 0) return text;
      const files = Array.from(
        new Set(ev.map((e) => e.filePath).filter((f): f is string => !!f)),
      ).slice(0, 3);
      if (files.length === 0) return text;
      return `${text} [📎 ${files.join(', ')}]`;
    })
    .join('; ');
}

/**
 * Split a `<idPrefix> <rest of text>` chat-command argument into its two parts.
 * Used by `/correct` and `/retract` to peel the session ID off the front of the
 * user's input without forcing an awkward quoting syntax.
 *
 * Whitespace around the boundary is collapsed. When the input contains only one
 * token, `text` is the empty string.
 */
export function splitIdAndText(input: string): { idPrefix: string; text: string } {
  const m = (input ?? '').trim().match(/^(\S+)(\s+([\s\S]*))?$/);
  if (!m) return { idPrefix: '', text: '' };
  return { idPrefix: m[1], text: (m[3] ?? '').trim() };
}

/**
 * Parses inline filter tokens from a search query.
 * Supported: `type:feature`, `since:7d`, `tag:wip`, `workspace:true`
 */
export function parseInlineFilters(q: string): {
  cleaned: string;
  filters: SearchFilters;
} {
  const filters: SearchFilters = {};
  const tokens = q.split(/\s+/);
  const remaining: string[] = [];
  for (const tok of tokens) {
    const [k, v] = tok.split(':');
    if (!v) {
      remaining.push(tok);
      continue;
    }
    switch (k.toLowerCase()) {
      case 'type':
        filters.type = v as ObservationType;
        break;
      case 'since': {
        // Parse "since:7d", "since:24h", "since:yesterday", "since:last-week"
        const normalizedV = v.toLowerCase().replace(/_/g, '-');
        let ms = 0;

        if (normalizedV === 'yesterday') ms = 24 * 3600000;
        else if (normalizedV === 'today')
          ms = 0; // not filtered by time
        else if (normalizedV === 'last-week') ms = 7 * 86400000;
        else if (normalizedV === 'last-month') ms = 30 * 86400000;
        else {
          const m = normalizedV.match(/^(\d+)([hdw])$/);
          if (m) {
            const n = parseInt(m[1], 10);
            ms = m[2] === 'h' ? n * 3600000 : m[2] === 'd' ? n * 86400000 : n * 604800000;
          }
        }

        if (ms > 0) filters.sinceTs = Date.now() - ms;
        break;
      }
      case 'tag':
        filters.tag = v;
        break;
      case 'workspace':
        filters.workspaceOnly = v === 'true';
        break;
      default:
        remaining.push(tok);
    }
  }
  return { cleaned: remaining.join(' '), filters };
}

/** Synthesise a compact natural-language summary across matching sessions. */
export function synthesize(sessions: CompressedSession[], query: string): string {
  const topics = new Set<string>();
  const files = new Set<string>();
  const decisions: string[] = [];
  const problems: string[] = [];
  for (const s of sessions) {
    s.keyTopics.forEach((t) => topics.add(t));
    s.keyFiles.forEach((f) => files.add(f));
    decisions.push(...s.decisions);
    problems.push(...s.problemsSolved);
  }
  const out: string[] = [`Based on ${sessions.length} session(s) matching "${query}":\n`];
  if (topics.size) out.push(`**Known topics:** ${Array.from(topics).join(', ')}\n`);
  if (files.size)
    out.push(
      `**Active files:** ${Array.from(files)
        .slice(0, 8)
        .map((f) => `\`${f}\``)
        .join(', ')}\n`,
    );
  if (decisions.length) {
    out.push('**Decisions:**');
    for (const d of decisions.slice(0, 5)) out.push(`- ${d}`);
    out.push('');
  }
  if (problems.length) {
    out.push('**Previously solved:**');
    for (const p of problems.slice(0, 5)) out.push(`- ${p}`);
  }
  return out.join('\n');
}
