/**
 * Secret & PII redactor.
 *
 * Improvement over claude-mem: claude-mem relies on manual `<private>` tags
 * only. This scanner catches accidentally-leaked secrets automatically.
 */

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string | ((m: string) => string);
}

const RULES: RedactionRule[] = [
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED:aws-access-key]' },
  // Bounded lookahead (max 120 chars, no newline) — the previous /(?=.*aws)/
  // pattern was unbounded and risked O(n²) scan / ReDoS on large event logs.
  { name: 'aws-secret', pattern: /\b[A-Za-z0-9/+=]{40}\b(?=[^\n]{0,120}aws)/gi, replacement: '[REDACTED:aws-secret]' },
  // GitHub tokens — classic ghp_ and newer fine-grained github_pat_ formats
  { name: 'github-token', pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g, replacement: '[REDACTED:github-token]' },
  { name: 'github-pat-fine', pattern: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g, replacement: '[REDACTED:github-token]' },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g, replacement: '[REDACTED:npm-token]' },
  // OpenAI — sk- is also used by Anthropic so order matters (anthropic matched first)
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED:anthropic-key]' },
  { name: 'openai-key', pattern: /\bsk-(?!ant-)[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED:openai-key]' },
  // Stripe live keys
  { name: 'stripe-key', pattern: /\b(?:sk|pk|rk)_live_[A-Za-z0-9]{24,}\b/g, replacement: '[REDACTED:stripe-key]' },
  { name: 'google-api', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: '[REDACTED:google-api]' },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED:slack-token]' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '[REDACTED:jwt]' },
  // Bearer token in Authorization header (HTTP headers, curl -H, etc.)
  { name: 'bearer-token', pattern: /\bBearer\s+([A-Za-z0-9\-._~+/]+=*){20,}/gi, replacement: 'Bearer [REDACTED:bearer-token]' },
  // Database connection URLs with embedded credentials (postgres://, mysql://, mongodb://, etc.)
  { name: 'db-url-password', pattern: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|amqps):\/\/[^:@\s]{1,64}:[^@\s]{4,}@/gi, replacement: (m: string) => m.replace(/:([^@\s]{4,})@/, ':[REDACTED:db-password]@') },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED:private-key-block]' },

  // ── Azure-specific rules ───────────────────────────────────
  // Azure Storage connection string: whole value stripped
  { name: 'azure-storage-conn', pattern: /DefaultEndpointsProtocol=[^;]+;AccountName=[^;]+;AccountKey=[^;"'\s]+(?:;EndpointSuffix=[^;"'\s]+)?/gi, replacement: '[REDACTED:azure-storage-conn]' },
  // Service Bus / Event Hubs connection string
  { name: 'azure-sb-conn', pattern: /Endpoint=sb:\/\/[^;]+;SharedAccessKeyName=[^;]+;SharedAccessKey=[^;"'\s]+(?:;EntityPath=[^;"'\s]+)?/gi, replacement: '[REDACTED:azure-sb-conn]' },
  // Cosmos DB connection string
  { name: 'azure-cosmos-conn', pattern: /AccountEndpoint=https:\/\/[^;]+;AccountKey=[^;"'\s]+/gi, replacement: '[REDACTED:azure-cosmos-conn]' },
  // Azure SQL connection string
  { name: 'azure-sql-conn', pattern: /Server=tcp:[^,;]+\.database\.windows\.net[^;]*;[^"'\n]*?Password=[^;"'\s]+/gi, replacement: '[REDACTED:azure-sql-conn]' },
  // SAS token query-string (sig= is the signature part — always present)
  { name: 'azure-sas', pattern: /(?:\?|&)(?:sv|sig|se|sp|st|spr|srt|ss|skoid|sktid)=[A-Za-z0-9%_\-.=+\/]+(?:&(?:sv|sig|se|sp|st|spr|srt|ss|skoid|sktid)=[A-Za-z0-9%_\-.=+\/]+){2,}/gi, replacement: '?[REDACTED:azure-sas]' },
  // Azure Storage account key (88-char base64 ending in ==)
  { name: 'azure-storage-key', pattern: /\b[A-Za-z0-9+\/]{86}==/g, replacement: '[REDACTED:azure-storage-key]' },
  // Service-principal client secret (new format: starts with two-char prefix + ~ then base64-ish, 40 chars)
  { name: 'azure-sp-secret', pattern: /\b[A-Za-z0-9]{2}~[A-Za-z0-9._~-]{34,40}\b/g, replacement: '[REDACTED:azure-sp-secret]' },
  // Azure subscription/tenant/client GUID when prefixed by contextual keyword
  { name: 'azure-guid-context', pattern: /\b(subscription(?:[-_ ]?id)?|tenant(?:[-_ ]?id)?|client(?:[-_ ]?id)?|object(?:[-_ ]?id)?)\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']?/gi, replacement: '$1=[REDACTED:azure-guid]' },

  { name: 'password-assign', pattern: /(password|passwd|pwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*["']?([^\s"',;]{4,})["']?/gi, replacement: '$1=[REDACTED]' },
  { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[REDACTED:email]' },
  { name: 'ipv4', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g, replacement: '[REDACTED:ip]' },
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
}

export interface RedactionResult {
  text: string;
  redactionCount: number;
  categories: string[];
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
      text = typeof rule.replacement === 'function'
        ? text.replace(rule.pattern, rule.replacement as (m: string) => string)
        : text.replace(rule.pattern, rule.replacement);
      if (text !== before) {
        count++;
        categories.add(rule.name);
      }
    }
  }

  return { text, redactionCount: count, categories: Array.from(categories) };
}

/** Quick check whether a string contains any obvious secret. */
export function looksSensitive(input: string): boolean {
  if (!input) return false;
  // Re-create each regex to avoid lastIndex state leaking between calls on
  // rules that use the /g flag — a subtle JS gotcha that caused false negatives
  // when looksSensitive was called multiple times in the same JS tick.
  return RULES.some(r => new RegExp(r.pattern.source, r.pattern.flags).test(input));
}
