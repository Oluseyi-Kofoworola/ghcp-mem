/**
 * Secret & PII redactor.
 *
 * Improvement over claude-mem: claude-mem relies on manual `<private>` tags
 * only. This scanner catches accidentally-leaked secrets automatically.
 */

import { createHash } from 'crypto';
import { getPolicyRedactionRules } from './policySource';
import type { CustomRedactionRule } from './types';

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: any[]) => string);
}

const LOCAL_SECRET_HASH_SALT = createHash('sha256')
  .update(
    [
      process.env.GHCP_MEM_SECRET_SALT ?? '',
      process.env.USER ?? process.env.USERNAME ?? 'unknown-user',
      process.env.HOME ?? '',
    ].join('|'),
  )
  .digest('hex');

function secretHash(label: string, value: string): string {
  return createHash('sha256')
    .update(LOCAL_SECRET_HASH_SALT)
    .update('\0')
    .update(label)
    .update('\0')
    .update(value)
    .digest('hex')
    .slice(0, 16);
}

function hashedTag(label: string, value: string): string {
  return `[REDACTED:${label}]#${secretHash(label, value)}`;
}

const RULES: RedactionRule[] = [
  {
    name: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: (m: string) => hashedTag('aws-access-key', m),
  },
  // Bounded lookahead (max 120 chars, no newline) — the previous /(?=.*aws)/
  // pattern was unbounded and risked O(n²) scan / ReDoS on large event logs.
  {
    name: 'aws-secret',
    pattern: /\b[A-Za-z0-9/+=]{40}\b(?=[^\n]{0,120}aws)/gi,
    replacement: (m: string) => hashedTag('aws-secret', m),
  },
  // GitHub tokens — classic ghp_ and newer fine-grained github_pat_ formats
  {
    name: 'github-token',
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g,
    replacement: (m: string) => hashedTag('github-token', m),
  },
  {
    name: 'github-pat-fine',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g,
    replacement: (m: string) => hashedTag('github-token', m),
  },
  {
    name: 'npm-token',
    pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g,
    replacement: (m: string) => hashedTag('npm-token', m),
  },
  // OpenAI — sk- is also used by Anthropic so order matters (anthropic matched first)
  {
    name: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: (m: string) => hashedTag('anthropic-key', m),
  },
  {
    name: 'openai-key',
    pattern: /\bsk-(?!ant-)[A-Za-z0-9]{20,}\b/g,
    replacement: (m: string) => hashedTag('openai-key', m),
  },
  // Stripe live keys
  {
    name: 'stripe-key',
    pattern: /\b(?:sk|pk|rk)_live_[A-Za-z0-9]{24,}\b/g,
    replacement: (m: string) => hashedTag('stripe-key', m),
  },
  {
    name: 'google-api',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: (m: string) => hashedTag('google-api', m),
  },
  {
    name: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: (m: string) => hashedTag('slack-token', m),
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: (m: string) => hashedTag('jwt', m),
  },
  // Bearer token in Authorization header (HTTP headers, curl -H, etc.)
  {
    name: 'bearer-token',
    pattern: /\bBearer\s+([A-Za-z0-9\-._~+/]+=*){20,}/gi,
    replacement: (m: string) => `Bearer ${hashedTag('bearer-token', m)}`,
  },
  // Database connection URLs with embedded credentials (postgres://, mysql://, mongodb://, etc.)
  {
    name: 'db-url-password',
    pattern:
      /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|amqps):\/\/[^:@\s]{1,64}:[^@\s]{4,}@/gi,
    replacement: (m: string) =>
      m.replace(
        /:([^@\s]{4,})@/,
        (_full, secret) => `:${hashedTag('db-password', String(secret))}@`,
      ),
  },
  // PEM private key blocks. The body is constrained to base64 + whitespace
  // characters only (no arbitrary [\s\S]) to prevent catastrophic backtracking
  // on large inputs that contain a BEGIN line but no matching END line.
  {
    name: 'private-key-block',
    pattern:
      /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[A-Za-z0-9+/=\s]{0,8192}-----END [A-Z ]{0,30}PRIVATE KEY-----/g,
    replacement: (m: string) => hashedTag('private-key-block', m),
  },

  // ── Azure-specific rules ───────────────────────────────────
  // Azure Storage connection string: whole value stripped
  {
    name: 'azure-storage-conn',
    pattern:
      /DefaultEndpointsProtocol=[^;]+;AccountName=[^;]+;AccountKey=[^;"'\s]+(?:;EndpointSuffix=[^;"'\s]+)?/gi,
    replacement: (m: string) => hashedTag('azure-storage-conn', m),
  },
  // Service Bus / Event Hubs connection string
  {
    name: 'azure-sb-conn',
    pattern:
      /Endpoint=sb:\/\/[^;]+;SharedAccessKeyName=[^;]+;SharedAccessKey=[^;"'\s]+(?:;EntityPath=[^;"'\s]+)?/gi,
    replacement: (m: string) => hashedTag('azure-sb-conn', m),
  },
  // Cosmos DB connection string
  {
    name: 'azure-cosmos-conn',
    pattern: /AccountEndpoint=https:\/\/[^;]+;AccountKey=[^;"'\s]+/gi,
    replacement: (m: string) => hashedTag('azure-cosmos-conn', m),
  },
  // Azure SQL connection string
  {
    name: 'azure-sql-conn',
    pattern: /Server=tcp:[^,;]+\.database\.windows\.net[^;]*;[^"'\n]*?Password=[^;"'\s]+/gi,
    replacement: (m: string) => hashedTag('azure-sql-conn', m),
  },
  // SAS token query-string (sig= is the signature part — always present)
  {
    name: 'azure-sas',
    pattern:
      /(?:\?|&)(?:sv|sig|se|sp|st|spr|srt|ss|skoid|sktid)=[A-Za-z0-9%_\-.=+\/]+(?:&(?:sv|sig|se|sp|st|spr|srt|ss|skoid|sktid)=[A-Za-z0-9%_\-.=+\/]+){2,}/gi,
    replacement: (m: string) => `${m.startsWith('&') ? '&' : '?'}${hashedTag('azure-sas', m)}`,
  },
  // Azure Storage account key (88-char base64 ending in ==)
  {
    name: 'azure-storage-key',
    pattern: /\b[A-Za-z0-9+\/]{86}==/g,
    replacement: (m: string) => hashedTag('azure-storage-key', m),
  },
  // Service-principal client secret (new format: starts with two-char prefix + ~ then base64-ish, 40 chars)
  {
    name: 'azure-sp-secret',
    pattern: /\b[A-Za-z0-9]{2}~[A-Za-z0-9._~-]{34,40}\b/g,
    replacement: (m: string) => hashedTag('azure-sp-secret', m),
  },
  // Azure subscription/tenant/client GUID when prefixed by contextual keyword
  {
    name: 'azure-guid-context',
    pattern:
      /\b(subscription(?:[-_ ]?id)?|tenant(?:[-_ ]?id)?|client(?:[-_ ]?id)?|object(?:[-_ ]?id)?)\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']?/gi,
    replacement: (_m: string, key: string, guid: string) =>
      `${key}=[REDACTED:azure-guid]#${secretHash('azure-guid', String(guid))}`,
  },

  {
    name: 'password-assign',
    pattern:
      /(password|passwd|pwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*["']?([^\s"',;]{4,})["']?/gi,
    replacement: (_m: string, key: string, secret: string) =>
      `${key}=[REDACTED]#${secretHash('password-assign', String(secret))}`,
  },
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[REDACTED:email]',
  },
  // Only redact IP addresses that appear in a credential/connection context to avoid
  // false positives in log lines, route tables, or diagnostic output.
  {
    name: 'ipv4',
    pattern:
      /\b(host|server|endpoint|addr(?:ess)?|ip(?:_addr(?:ess)?)?|remote|peer|bind|listen)\s*[:=]\s*["']?(\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b)["']?/gi,
    replacement: '$1=[REDACTED:ip]',
  },
  // Restricted to common 4-4-4-4 / 4-4-4-4-suffix CC layouts. The earlier
  // /\b(?:\d[ -]*?){13,16}\b/ combined a greedy quantifier with an inner lazy
  // one which is a classic ReDoS shape on digit-heavy strings (log lines,
  // hashes, sequence ids). This form is linear-time.
  { name: 'credit-card', pattern: /\b(?:\d{4}[ -]?){3}\d{4}\b/g, replacement: '[REDACTED:card]' },
];

// Content between <private> tags is stripped entirely.
const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/g;

export interface RedactOptions {
  redactSecrets: boolean;
  honorPrivateTags: boolean;
  /** User-defined regex rules appended after the built-in 26-rule set. */
  customRules?: CustomRedactionRule[];
  /**
   * Phase 5 NER-lite: plain-string entity names to redact verbatim
   * (case-insensitive, word-boundary anchored). Use for organisation-,
   * project-, or codename-specific terms that don't match any built-in
   * pattern — e.g. ["AcmeCorp internal", "Project Hydra"]. No ML needed:
   * each entry compiles to a literal-escape regex and runs after the
   * rule-based redaction pass.
   */
  customSensitiveEntities?: string[];
}

export interface RedactionResult {
  text: string;
  redactionCount: number;
  categories: string[];
}

/**
 * Escape regex metacharacters in a literal string so it can be safely
 * compiled into a RegExp. Used by the customSensitiveEntities NER-lite
 * path to compile every entity name into a literal pattern.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redact(input: string, opts: RedactOptions): RedactionResult {
  if (!input) return { text: input, redactionCount: 0, categories: [] };
  let text = input;
  let count = 0;
  const categories = new Set<string>();

  if (opts.honorPrivateTags) {
    const matches = text.match(PRIVATE_TAG_RE);
    if (matches) {
      count += matches.length;
      categories.add('private-tag');
      text = text.replace(PRIVATE_TAG_RE, '[PRIVATE_REDACTED]');
    }
  }

  if (opts.redactSecrets) {
    for (const rule of RULES) {
      const before = text;
      text =
        typeof rule.replacement === 'function'
          ? text.replace(rule.pattern, rule.replacement as (m: string) => string)
          : text.replace(rule.pattern, rule.replacement);
      if (text !== before) {
        count++;
        categories.add(rule.name);
      }
    }

    const policyRules = getPolicyRedactionRules();
    if (policyRules.length > 0) {
      for (const rule of policyRules) {
        const before = text;
        const re = new RegExp(rule.pattern, rule.flags ?? 'g');
        const repl = rule.replacement ?? '[REDACTED:policy]';
        text = text.replace(re, repl);
        if (text !== before) {
          count++;
          categories.add(`policy:${rule.name}`);
        }
      }
    }

    // User-defined rules applied after built-in rules so enterprise overrides
    // compose on top of the default set without replacing it.
    if (opts.customRules && opts.customRules.length > 0) {
      for (const rule of opts.customRules) {
        try {
          const re = new RegExp(rule.pattern, rule.flags ?? 'g');
          const repl = rule.replacement ?? '[REDACTED:custom]';
          const before = text;
          text = text.replace(re, repl);
          if (text !== before) {
            count++;
            categories.add(`custom:${rule.name}`);
          }
        } catch {
          // Invalid regex — skip this rule silently rather than crashing capture.
        }
      }
    }

    // Phase 5 NER-lite: redact each declared entity name as a literal,
    // word-boundary-anchored, case-insensitive substring. Runs LAST so
    // built-in rules can match more specific patterns first.
    if (opts.customSensitiveEntities && opts.customSensitiveEntities.length > 0) {
      for (const raw of opts.customSensitiveEntities) {
        const term = (raw ?? '').trim();
        if (!term) continue;
        try {
          // For multi-word entities, replace internal spaces with `\s+` so
          // line breaks / tabs / multiple spaces don't escape the filter.
          const pattern = escapeRegex(term).replace(/\\ /g, '\\s+');
          // Word-boundary on alphanumeric edges only — required so entities
          // like "Project Hydra" match in prose without false positives
          // inside identifiers like "ProjectHydraService".
          const re = new RegExp(`(?<![\\w])${pattern}(?![\\w])`, 'gi');
          const before = text;
          text = text.replace(re, '[REDACTED:entity]');
          if (text !== before) {
            count++;
            categories.add('custom-entity');
          }
        } catch {
          // Invalid regex from unexpected unicode → skip silently.
        }
      }
    }
  }

  return { text, redactionCount: count, categories: Array.from(categories) };
}

/** Quick check whether a string contains any obvious secret. */
export function looksSensitive(input: string): boolean {
  if (!input) return false;
  // Reset lastIndex on each rule's /g RegExp before .test() so stateful
  // iteration from a previous call can't produce a false negative on the
  // next one. This avoids allocating a fresh RegExp per rule per call,
  // which was a notable hot path when the autosave trigger streamed
  // hundreds of events through the pre-filter.
  for (const r of RULES) {
    r.pattern.lastIndex = 0;
    if (r.pattern.test(input)) {
      r.pattern.lastIndex = 0;
      return true;
    }
  }
  return false;
}
