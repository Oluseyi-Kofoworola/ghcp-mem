import type { CustomRedactionRule } from './types';

let policyRedactionRules: CustomRedactionRule[] = [];
let policySourceUrl: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function getPolicySource(): string | undefined {
  return policySourceUrl;
}

export function getPolicyRedactionRules(): CustomRedactionRule[] {
  return [...policyRedactionRules];
}

export function clearPolicyRedactionRules(): void {
  policySourceUrl = undefined;
  policyRedactionRules = [];
}

export function setPolicyRedactionRules(source: string, rules: CustomRedactionRule[]): void {
  policySourceUrl = source;
  policyRedactionRules = [...rules];
}

export function parsePolicyRedactionRules(raw: unknown): CustomRedactionRule[] {
  if (!Array.isArray(raw)) {
    throw new Error('Policy source must return a JSON array of redaction rules');
  }

  return raw.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Policy rule ${index} must be an object`);
    }
    if (typeof item.name !== 'string' || item.name.trim().length === 0) {
      throw new Error(`Policy rule ${index} is missing a valid "name"`);
    }
    if (typeof item.pattern !== 'string' || item.pattern.trim().length === 0) {
      throw new Error(`Policy rule ${index} is missing a valid "pattern"`);
    }
    if (item.replacement !== undefined && typeof item.replacement !== 'string') {
      throw new Error(`Policy rule ${index} has an invalid "replacement"`);
    }
    if (item.flags !== undefined && typeof item.flags !== 'string') {
      throw new Error(`Policy rule ${index} has an invalid "flags"`);
    }
    return {
      name: item.name.trim(),
      pattern: item.pattern,
      replacement: item.replacement,
      flags: item.flags,
    } satisfies CustomRedactionRule;
  });
}

export async function refreshPolicyRedactionRules(source: string | undefined): Promise<number> {
  const trimmed = source?.trim();
  if (!trimmed) {
    clearPolicyRedactionRules();
    return 0;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('baton.policySource must be a valid URL');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('baton.policySource must use http: or https:');
  }

  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('Fetch API is unavailable in this runtime');
  }

  const response = await fetchFn(url.toString(), {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Policy fetch failed with HTTP ${response.status}`);
  }

  const parsed = parsePolicyRedactionRules(await response.json());
  setPolicyRedactionRules(url.toString(), parsed);
  return parsed.length;
}
