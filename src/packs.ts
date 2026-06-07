import { CompressedSession } from './types';
import { redact } from './redactor';
import { ContextStore } from './contextStore';

export const PACK_SCHEMA_VERSION = 1;
export const PACK_TAG_PREFIX = 'pack:';

/**
 * Hard limits on imported pack payloads. Defends against malicious or
 * pathologically large pack files that would freeze VS Code during
 * `JSON.parse` + redaction. Picked generously enough that any realistic
 * team-shared pack passes through unaffected.
 */
export const MAX_PACK_BYTES = 10 * 1024 * 1024; // 10 MB total
export const MAX_SESSIONS_PER_PACK = 1000;
export const MAX_FIELD_LENGTH = 8 * 1024; // 8 KB per text field
export const MAX_LIST_LENGTH = 100; // per session, max items per array

export interface MemoryPack {
  schemaVersion: number;
  name: string;
  createdAt: number;
  createdBy?: string;
  description?: string;
  sessions: CompressedSession[];
}

export interface ExportPackOptions {
  name: string;
  description?: string;
  /** Filter: include only sessions with these tags (OR semantics). Empty = all. */
  filterTags?: string[];
  /** Filter: include only sessions of these types. Empty = all. */
  filterTypes?: string[];
  /** Re-run redaction on export. Default true. */
  redactAgain?: boolean;
}

export function buildPack(store: ContextStore, opts: ExportPackOptions): MemoryPack {
  const all = store.getAllSessions();
  let filtered = all;

  if (opts.filterTags?.length) {
    const wanted = new Set(opts.filterTags);
    filtered = filtered.filter((s) => s.userTags.some((t) => wanted.has(t)));
  }
  if (opts.filterTypes?.length) {
    const wanted = new Set(opts.filterTypes);
    filtered = filtered.filter((s) => wanted.has(s.observationType));
  }

  const packTag = `${PACK_TAG_PREFIX}${opts.name}`;
  const redactAgain = opts.redactAgain !== false;

  const sessions: CompressedSession[] = filtered.map((s) => {
    const tags = Array.from(new Set([...s.userTags, packTag]));
    if (!redactAgain) return { ...s, userTags: tags };
    const r = (txt: string) => redact(txt, { redactSecrets: true, honorPrivateTags: true }).text;
    return {
      ...s,
      userTags: tags,
      summary: r(s.summary),
      keyTopics: s.keyTopics.map(r),
      decisions: s.decisions.map(r),
      problemsSolved: s.problemsSolved.map(r),
    };
  });

  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    name: opts.name,
    createdAt: Date.now(),
    description: opts.description,
    sessions,
  };
}

export function parsePack(json: string): MemoryPack {
  // Phase 8 hardening: cap the input payload size BEFORE JSON.parse so a
  // multi-gigabyte malicious file can't OOM the extension host. Also caps
  // session count and per-field text length after parse.
  if (typeof json !== 'string') throw new Error('Pack input must be a string.');
  if (json.length > MAX_PACK_BYTES) {
    throw new Error(
      `Pack rejected: payload ${json.length} bytes exceeds the ${MAX_PACK_BYTES}-byte limit.`,
    );
  }

  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') throw new Error('Pack is not a JSON object.');
  if (typeof parsed.name !== 'string' || !parsed.name.trim())
    throw new Error('Pack missing "name".');
  if (!Array.isArray(parsed.sessions)) throw new Error('Pack missing "sessions" array.');
  if (typeof parsed.schemaVersion !== 'number') throw new Error('Pack missing "schemaVersion".');
  if (parsed.schemaVersion > PACK_SCHEMA_VERSION) {
    throw new Error(
      `Pack schema v${parsed.schemaVersion} is newer than supported v${PACK_SCHEMA_VERSION}.`,
    );
  }
  // Validate pack name — prevent path traversal if the name is ever used as a filename/tag component.
  if (!/^[a-z0-9._-]{1,64}$/i.test(parsed.name.trim())) {
    throw new Error('Pack name contains disallowed characters. Use letters, digits, ., _ or -');
  }
  // Bound session count so a pack with millions of empty objects doesn't slowly chew up RAM.
  if (parsed.sessions.length > MAX_SESSIONS_PER_PACK) {
    throw new Error(
      `Pack rejected: ${parsed.sessions.length} sessions exceeds the ${MAX_SESSIONS_PER_PACK} per-pack limit.`,
    );
  }
  // Validate that every session has a UUID-shaped ID to prevent injection.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const s of parsed.sessions as Array<{
    id?: unknown;
    summary?: unknown;
    keyFiles?: unknown;
    keyTopics?: unknown;
    decisions?: unknown;
    problemsSolved?: unknown;
    decisionEvidence?: unknown;
    problemEvidence?: unknown;
  }>) {
    if (typeof s.id !== 'string' || !uuidRe.test(s.id)) {
      throw new Error(
        `Pack contains a session with an invalid ID: "${String(s.id).substring(0, 40)}"`,
      );
    }
    // Per-field length caps — defends against degenerate single-string OOM.
    if (typeof s.summary === 'string' && s.summary.length > MAX_FIELD_LENGTH) {
      throw new Error(
        `Pack rejected: session ${s.id} has a summary of ${s.summary.length} chars (cap: ${MAX_FIELD_LENGTH}).`,
      );
    }
    for (const arrField of ['keyFiles', 'keyTopics', 'decisions', 'problemsSolved'] as const) {
      const arr = s[arrField];
      if (Array.isArray(arr) && arr.length > MAX_LIST_LENGTH) {
        throw new Error(
          `Pack rejected: session ${s.id} has ${arr.length} ${arrField} entries (cap: ${MAX_LIST_LENGTH}).`,
        );
      }
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === 'string' && item.length > MAX_FIELD_LENGTH) {
            throw new Error(
              `Pack rejected: session ${s.id} has a ${arrField} entry of ${item.length} chars (cap: ${MAX_FIELD_LENGTH}).`,
            );
          }
        }
      }
    }
    // Evidence filePath defence: reject any path that contains `..` segments
    // or absolute-path roots. Otherwise an imported pack could plant
    // Evidence pointing at `/etc/passwd` and the Inspector would happily
    // open it when a user clicks the file chip.
    for (const evField of ['decisionEvidence', 'problemEvidence'] as const) {
      const lists = s[evField];
      if (!Array.isArray(lists)) continue;
      for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const ev of list) {
          if (!ev || typeof ev !== 'object') continue;
          const fp = (ev as { filePath?: unknown }).filePath;
          if (typeof fp !== 'string') continue;
          if (isUnsafeRelPath(fp)) {
            throw new Error(
              `Pack rejected: session ${s.id} carries evidence with an unsafe filePath: "${fp.substring(0, 80)}".`,
            );
          }
        }
      }
    }
  }
  return parsed as MemoryPack;
}

/**
 * Refuse paths that would let a malicious pack escape the workspace root
 * via either parent traversal (`..`) or an absolute path. Mirrors the
 * defensive normalisation in `src/validator.ts:cleanRelPath` so both
 * surfaces enforce the same boundary.
 */
function isUnsafeRelPath(p: string): boolean {
  const s = p.trim();
  if (!s) return false; // empty is fine — drops to "no path" branch in callers
  if (s.startsWith('/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true; // windows drive prefix
  if (s.startsWith('file://')) return true;
  if (s.split(/[\\/]/).includes('..')) return true;
  return false;
}

/**
 * Import a pack. Sessions are added with `pack:<name>` tag. Returns imported count.
 *
 * Phase 5 federated-lineage merge: the underlying `addSession` already runs
 * heuristic conflict detection (Phase 4) on every insert, so importing a
 * team pack will automatically surface decisions that contradict existing
 * memory. The number of new conflict warnings raised by this import is
 * returned so the caller can prompt the developer to review `/conflicts`.
 *
 * Supersession links inside the pack (`supersedes`, `supersededBy`,
 * `correctionOf`) propagate through the spread — they're optional fields
 * on CompressedSession and are preserved as-is across the import boundary,
 * so an imported chain "A → B → C" continues to render as a single
 * lineage even when only B was previously known locally.
 */
export async function importPack(
  store: ContextStore,
  pack: MemoryPack,
): Promise<{ imported: number; skipped: number; conflictsRaised: number }> {
  const packTag = `${PACK_TAG_PREFIX}${pack.name}`;
  const existingIds = new Set(store.getAllSessions().map((s) => s.id));
  let imported = 0;
  let skipped = 0;
  const conflictsBefore = store.getPendingConflicts().length;
  const r = (txt: string) => redact(txt, { redactSecrets: true, honorPrivateTags: true }).text;
  for (const raw of pack.sessions) {
    if (existingIds.has(raw.id)) {
      skipped++;
      continue;
    }
    // Re-run redaction on every imported session to guard against unredacted pack data.
    // The optional retractedReason carries free-form user text → re-redact too.
    const tagged: CompressedSession = {
      ...raw,
      userTags: Array.from(new Set([...(raw.userTags ?? []), packTag])),
      summary: r(raw.summary),
      decisions: (raw.decisions ?? []).map(r),
      problemsSolved: (raw.problemsSolved ?? []).map(r),
      keyTopics: (raw.keyTopics ?? []).map(r),
      ...(raw.retractedReason ? { retractedReason: r(raw.retractedReason) } : {}),
    };
    await store.addSession(tagged);
    imported++;
  }
  const conflictsRaised = Math.max(0, store.getPendingConflicts().length - conflictsBefore);
  return { imported, skipped, conflictsRaised };
}

/**
 * Delete all sessions belonging to a pack (identified by pack:<name> tag).
 */
export async function uninstallPack(store: ContextStore, name: string): Promise<number> {
  const packTag = `${PACK_TAG_PREFIX}${name}`;
  const toDelete = store.getAllSessions().filter((s) => s.userTags.includes(packTag));
  if (toDelete.length === 0) return 0;
  return store.deleteSessions(toDelete.map((s) => s.id));
}

/**
 * List installed pack names with session counts.
 */
export function listInstalledPacks(store: ContextStore): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of store.getAllSessions()) {
    for (const t of s.userTags) {
      if (t.startsWith(PACK_TAG_PREFIX)) {
        const name = t.slice(PACK_TAG_PREFIX.length);
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  return Array.from(counts, ([name, count]) => ({ name, count })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
