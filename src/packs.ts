import * as vscode from 'vscode';
import { CompressedSession } from './types';
import { redact } from './redactor';
import { ContextStore } from './contextStore';

export const PACK_SCHEMA_VERSION = 1;
export const PACK_TAG_PREFIX = 'pack:';

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

export function buildPack(
  store: ContextStore,
  opts: ExportPackOptions,
): MemoryPack {
  const all = store.getAllSessions();
  let filtered = all;

  if (opts.filterTags?.length) {
    const wanted = new Set(opts.filterTags);
    filtered = filtered.filter(s => s.userTags.some(t => wanted.has(t)));
  }
  if (opts.filterTypes?.length) {
    const wanted = new Set(opts.filterTypes);
    filtered = filtered.filter(s => wanted.has(s.observationType));
  }

  const packTag = `${PACK_TAG_PREFIX}${opts.name}`;
  const redactAgain = opts.redactAgain !== false;

  const sessions: CompressedSession[] = filtered.map(s => {
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
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') throw new Error('Pack is not a JSON object.');
  if (typeof parsed.name !== 'string' || !parsed.name.trim()) throw new Error('Pack missing "name".');
  if (!Array.isArray(parsed.sessions)) throw new Error('Pack missing "sessions" array.');
  if (typeof parsed.schemaVersion !== 'number') throw new Error('Pack missing "schemaVersion".');
  if (parsed.schemaVersion > PACK_SCHEMA_VERSION) {
    throw new Error(`Pack schema v${parsed.schemaVersion} is newer than supported v${PACK_SCHEMA_VERSION}.`);
  }
  return parsed as MemoryPack;
}

/**
 * Import a pack. Sessions are added with `pack:<name>` tag. Returns imported count.
 */
export async function importPack(store: ContextStore, pack: MemoryPack): Promise<{ imported: number; skipped: number }> {
  const packTag = `${PACK_TAG_PREFIX}${pack.name}`;
  const existingIds = new Set(store.getAllSessions().map(s => s.id));
  let imported = 0;
  let skipped = 0;
  const r = (txt: string) => redact(txt, { redactSecrets: true, honorPrivateTags: true }).text;
  for (const raw of pack.sessions) {
    if (existingIds.has(raw.id)) { skipped++; continue; }
    // Re-run redaction on every imported session to guard against unredacted pack data.
    const tagged: CompressedSession = {
      ...raw,
      userTags: Array.from(new Set([...(raw.userTags ?? []), packTag])),
      summary: r(raw.summary),
      decisions: (raw.decisions ?? []).map(r),
      problemsSolved: (raw.problemsSolved ?? []).map(r),
      keyTopics: (raw.keyTopics ?? []).map(r),
    };
    await store.addSession(tagged);
    imported++;
  }
  return { imported, skipped };
}

/**
 * Delete all sessions belonging to a pack (identified by pack:<name> tag).
 */
export async function uninstallPack(store: ContextStore, name: string): Promise<number> {
  const packTag = `${PACK_TAG_PREFIX}${name}`;
  const toDelete = store.getAllSessions().filter(s => s.userTags.includes(packTag));
  for (const s of toDelete) await store.deleteSession(s.id);
  return toDelete.length;
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
  return Array.from(counts, ([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}
