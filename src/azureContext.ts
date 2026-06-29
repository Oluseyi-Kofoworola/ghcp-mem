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
const cache = new Map<string, { snapshot: AzureContextSnapshot; at: number }>();

function cacheKey(opts?: { includeResources?: boolean; resourceGroup?: string }): string {
  const include = opts?.includeResources ? '1' : '0';
  const rg = (opts?.resourceGroup ?? '').trim().toLowerCase();
  return `includeResources=${include};rg=${rg}`;
}

function runAz(args: string[], timeoutMs = 4000): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const cp = execFile(
        'az',
        args,
        { timeout: timeoutMs, windowsHide: true, shell: false },
        (err, stdout) => {
          if (err) resolve(undefined);
          else resolve(stdout);
        },
      );
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
export async function captureAzureContext(opts?: {
  includeResources?: boolean;
  resourceGroup?: string;
}): Promise<AzureContextSnapshot> {
  const now = Date.now();
  const key = cacheKey(opts);
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.snapshot;

  const snapshot: AzureContextSnapshot = { capturedAt: new Date().toISOString() };

  const accountJson = await runAz(['account', 'show', '--output', 'json']);
  if (!accountJson) {
    snapshot.notes = 'az CLI unavailable or not signed in';
    cache.set(key, { snapshot, at: now });
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
    } catch {
      /* ignore */
    }
  }
  if (opts?.resourceGroup) snapshot.resourceGroup = opts.resourceGroup;

  if (opts?.includeResources && snapshot.resourceGroup) {
    const resJson = await runAz(
      [
        'resource',
        'list',
        '--resource-group',
        snapshot.resourceGroup,
        '--query',
        '[].id',
        '--output',
        'json',
      ],
      6000,
    );
    if (resJson) {
      try {
        const ids = JSON.parse(resJson);
        if (Array.isArray(ids))
          snapshot.resourceIds = ids.filter((x): x is string => typeof x === 'string').slice(0, 50);
      } catch {
        /* ignore */
      }
    }
  }

  cache.set(key, { snapshot, at: now });
  return snapshot;
}

/** For tests. */
export function _resetAzureContextCache(): void {
  cache.clear();
}

/**
 * Apply `ghcpMem.preserveCloudContextLevel` to a snapshot before it gets
 * persisted on a `CompressedSession.azureContext` field. v1.13.0+.
 *
 *   level === 'full'         → return the snapshot unchanged (pre-v1.13 behavior).
 *   level === 'summary-only' → return a snapshot where every cloud identifier
 *     (subscriptionId, tenantId, resourceGroup, resourceIds) is replaced with
 *     a deterministic opaque tag. `subscriptionName`, `defaultLocation`, and
 *     `notes` are preserved because they help the LM contextualise without
 *     leaking IDs that can be cross-referenced with billing/audit logs.
 *   level === 'none'         → return `undefined` so the caller skips
 *     persisting any Azure context at all.
 *
 * The opaque tags share a stable hash suffix so two captures from the same
 * subscription still hash-match — preserving the "this is the same env"
 * signal — without disclosing the value.
 */
export function applyPreserveLevel(
  snapshot: AzureContextSnapshot,
  level: 'full' | 'summary-only' | 'none',
): AzureContextSnapshot | undefined {
  if (level === 'none') return undefined;
  if (level === 'full') return snapshot;
  // summary-only: redact every identifier but keep the human-readable
  // breadcrumbs (subscription name, location, notes).
  const out: AzureContextSnapshot = {
    capturedAt: snapshot.capturedAt,
    subscriptionName: snapshot.subscriptionName,
    defaultLocation: snapshot.defaultLocation,
    notes: snapshot.notes,
  };
  if (snapshot.subscriptionId) {
    out.subscriptionId = `[REDACTED:azure-subscription-id]#${stableHashSuffix(snapshot.subscriptionId)}`;
  }
  if (snapshot.tenantId) {
    out.tenantId = `[REDACTED:azure-tenant-id]#${stableHashSuffix(snapshot.tenantId)}`;
  }
  if (snapshot.resourceGroup) {
    out.resourceGroup = `[REDACTED:azure-resource-group]#${stableHashSuffix(snapshot.resourceGroup)}`;
  }
  if (snapshot.resourceIds?.length) {
    // Each resource ID is a full ARM path containing the (already-redacted) subscriptionId
    // and resourceGroup as substrings. We keep the resource TYPE segment so the LM can
    // still tell "an azure storage account was touched" without leaking the path.
    out.resourceIds = snapshot.resourceIds.map((id) => summariseResourceId(id));
  }
  return out;
}

/**
 * Reduce an ARM resource ID like
 *   "/subscriptions/<guid>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/foo"
 * to a typed summary like "Microsoft.Storage/storageAccounts (redacted)" so
 * downstream consumers can tell what KIND of resource was touched without
 * being able to address it.
 */
function summariseResourceId(id: string): string {
  const m = id.match(/\/providers\/([^/]+)\/([^/]+)(?:\/[^/]+)*$/i);
  if (!m) return '[REDACTED:azure-resource-id]';
  return `${m[1]}/${m[2]} (redacted)`;
}

/**
 * Truncated, deterministic hash of a cloud identifier for the [REDACTED:..]#xxxxxxxx
 * suffix. Same value → same suffix so cross-session correlation is possible
 * locally, but the suffix isn't reversible to the original ID.
 */
function stableHashSuffix(value: string): string {
  // Tiny FNV-1a so we don't pull crypto for what's an obfuscation suffix.
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}
