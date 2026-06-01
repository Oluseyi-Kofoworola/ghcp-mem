import * as vscode from 'vscode';
import { createHash } from 'crypto';

/**
 * Derive a stable "repo scope" identifier so memories can be partitioned by
 * source repository — mirroring GitHub Copilot agentic memory's
 * repository-specific scoping, but without any cloud requirement.
 *
 * Resolution order:
 *  1. Git remote `origin` URL of the first workspace folder (normalised).
 *  2. First workspace folder URI string (fallback when no git is present).
 *  3. `'no-workspace'` sentinel when no folder is open.
 *
 * The result is a short SHA-256 prefix so the value is opaque and stable
 * across machines for the same logical repo.
 */

export interface RepoScopeInfo {
  /** Opaque stable identifier (16-hex SHA-256 prefix). */
  id: string;
  /** Human-readable label for UI ("github.com/foo/bar" or workspace name). */
  label: string;
  /** True when we resolved a git remote (highest-confidence scope). */
  fromGitRemote: boolean;
}

const NO_WORKSPACE: RepoScopeInfo = {
  id: 'no-workspace',
  label: '(no workspace)',
  fromGitRemote: false,
};

/** In-process cache so we don't re-shell-out to git on every retrieval. */
let cached: { folderUri: string; info: RepoScopeInfo; configMtime: number } | undefined;

/** For tests. */
export function _clearRepoScopeCache(): void {
  cached = undefined;
}

/**
 * Get the active workspace's repo scope info. Best-effort: never throws.
 * Cache is invalidated when `.git/config` mtime changes (covers
 * `git remote set-url`, branch switches that change the remote, etc.).
 */
export async function getRepoScope(): Promise<RepoScopeInfo> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return NO_WORKSPACE;

  const key = folder.uri.toString();
  const cfgUri = vscode.Uri.joinPath(folder.uri, '.git', 'config');
  let mtime = 0;
  try {
    const stat = await vscode.workspace.fs.stat(cfgUri);
    mtime = stat.mtime;
  } catch {
    // No .git/config — keep mtime=0 so cache key is stable across calls.
  }

  if (cached && cached.folderUri === key && cached.configMtime === mtime) {
    return cached.info;
  }

  let remote: string | undefined;
  try {
    remote = await readGitRemote(folder.uri);
  } catch {
    remote = undefined;
  }

  const info: RepoScopeInfo = remote
    ? {
        id: hashId(`git:${remote}`),
        label: prettyRemote(remote),
        fromGitRemote: true,
      }
    : {
        id: hashId(`ws:${key}`),
        label: folder.name,
        fromGitRemote: false,
      };

  cached = { folderUri: key, info, configMtime: mtime };
  return info;
}

/**
 * Synchronous variant — returns the workspace-fallback scope only.
 * Used in hot paths (search) where we can't await; falls back to whatever
 * `getRepoScope` last cached so the first retrieval after activate() works.
 */
export function getRepoScopeSync(): RepoScopeInfo {
  if (cached) return cached.info;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return NO_WORKSPACE;
  return {
    id: hashId(`ws:${folder.uri.toString()}`),
    label: folder.name,
    fromGitRemote: false,
  };
}

/** Hard ceiling on .git/config size we'll parse. Any sane config is well under 64 KB;
 *  going higher means we're either being fed a fake file or something is wrong. */
const MAX_GIT_CONFIG_BYTES = 1_000_000;

async function readGitRemote(workspaceUri: vscode.Uri): Promise<string | undefined> {
  // Read .git/config directly — avoids spawning a child process which is
  // unavailable in the VS Code web extension host and slow on first call.
  const cfgUri = vscode.Uri.joinPath(workspaceUri, '.git', 'config');
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(cfgUri);
  } catch {
    return undefined;
  }
  // Size cap before regex — protects against catastrophic backtracking on
  // pathological inputs (the negated character class is fine for small inputs
  // but is still O(n) work the engine doesn't need to do on a 100MB file).
  if (bytes.byteLength > MAX_GIT_CONFIG_BYTES) {
    console.warn(
      `[GHCP-MEM] .git/config too large (${bytes.byteLength} bytes), skipping remote detection`,
    );
    return undefined;
  }
  const text = Buffer.from(bytes).toString('utf-8');
  // Look for [remote "origin"] block, then the url = ... line within it.
  const re = /\[remote\s+"origin"\][^\[]*?url\s*=\s*([^\r\n]+)/i;
  const m = re.exec(text);
  if (!m) return undefined;
  return normalizeRemoteUrl(m[1].trim());
}

/**
 * Normalize common git URL forms so the same repo always maps to the same id:
 *   git@github.com:foo/bar.git    → github.com/foo/bar
 *   https://github.com/foo/bar.git → github.com/foo/bar
 *   ssh://git@github.com/foo/bar  → github.com/foo/bar
 */
export function normalizeRemoteUrl(url: string): string {
  let s = url.trim();
  // SSH shorthand: git@host:path
  const ssh = /^git@([^:]+):(.+)$/.exec(s);
  if (ssh) s = `https://${ssh[1]}/${ssh[2]}`;
  // ssh://, https://, http://
  s = s.replace(/^[a-z]+:\/\//i, '');
  s = s.replace(/^[^@]+@/, ''); // strip user@
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/+$/g, '');
  return s.toLowerCase();
}

function prettyRemote(normalized: string): string {
  return normalized;
}

function hashId(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
