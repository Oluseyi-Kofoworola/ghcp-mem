/**
 * Thin wrapper around the `az` CLI to snapshot the current Azure context.
 *
 * Design goals:
 *   - Zero hard dependency: fails silent if `az` isn't installed or the user isn't logged in.
 *   - Cheap: caches results for 5 minutes so it can be called per-session without latency.
 *   - No secrets: deliberately never captures tokens — only IDs + names that are safe to persist.
 */
import { execFile } from 'child_process';

export interface AzureContextSnapshot {
  subscriptionId?: string;
  subscriptionName?: string;
  tenantId?: string;
  resourceGroup?: string;
  defaultLocation?: string;
  resourceIds?: string[];
  /** ISO timestamp this snapshot was captured. */
  capturedAt: string;
  /** Why the snapshot may be incomplete (e.g. 'az not installed', 'not logged in'). */
  notes?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { snapshot: AzureContextSnapshot; at: number } | undefined;

function runAz(args: string[], timeoutMs = 4000): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const cp = execFile('az', args, { timeout: timeoutMs, windowsHide: true, shell: false }, (err, stdout) => {
        if (err) resolve(undefined);
        else resolve(stdout);
      });
      cp.on('error', () => resolve(undefined));
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Take a snapshot of the current Azure context. Never throws.
 * Returns a skeleton snapshot (with notes) even if `az` is unavailable.
 */
export async function captureAzureContext(opts?: { includeResources?: boolean; resourceGroup?: string }): Promise<AzureContextSnapshot> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.snapshot;

  const snapshot: AzureContextSnapshot = { capturedAt: new Date().toISOString() };

  const accountJson = await runAz(['account', 'show', '--output', 'json']);
  if (!accountJson) {
    snapshot.notes = 'az CLI unavailable or not signed in';
    cache = { snapshot, at: now };
    return snapshot;
  }

  try {
    const acc = JSON.parse(accountJson);
    snapshot.subscriptionId = typeof acc?.id === 'string' ? acc.id : undefined;
    snapshot.subscriptionName = typeof acc?.name === 'string' ? acc.name : undefined;
    snapshot.tenantId = typeof acc?.tenantId === 'string' ? acc.tenantId : undefined;
  } catch {
    snapshot.notes = 'failed to parse az account output';
  }

  const configJson = await runAz(['configure', '--list-defaults', '--output', 'json']);
  if (configJson) {
    try {
      const defaults = JSON.parse(configJson) as Array<{ name: string; value: string }>;
      for (const d of defaults ?? []) {
        if (d.name === 'group' && !opts?.resourceGroup) snapshot.resourceGroup = d.value;
        if (d.name === 'location') snapshot.defaultLocation = d.value;
      }
    } catch { /* ignore */ }
  }
  if (opts?.resourceGroup) snapshot.resourceGroup = opts.resourceGroup;

  if (opts?.includeResources && snapshot.resourceGroup) {
    const resJson = await runAz(['resource', 'list', '--resource-group', snapshot.resourceGroup, '--query', '[].id', '--output', 'json'], 6000);
    if (resJson) {
      try {
        const ids = JSON.parse(resJson);
        if (Array.isArray(ids)) snapshot.resourceIds = ids.filter((x): x is string => typeof x === 'string').slice(0, 50);
      } catch { /* ignore */ }
    }
  }

  cache = { snapshot, at: now };
  return snapshot;
}

/** For tests. */
export function _resetAzureContextCache(): void {
  cache = undefined;
}
