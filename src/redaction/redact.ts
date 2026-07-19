/**
 * Credential redaction.
 *
 * Runs before any evidence, diagnostic, approval text, JSON, or log leaves the
 * process. Patterns are ordered most-specific first so a structured token
 * format is masked before a broader key/value rule can partially expose it.
 *
 * This is best-effort defense in depth, not a secrets scanner. It never sees a
 * real secret in tests (fixtures use fake credentials only) and never logs raw
 * input by default.
 */

const REDACTED = '[REDACTED]';

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

/** Keep a short, non-reversible hint of the value's shape without the value. */
function label(tag: string): string {
  return `[REDACTED:${tag}]`;
}

const RULES: readonly Rule[] = [
  // PEM private key blocks (multi-line) — mask the whole block.
  {
    name: 'pem-private-key',
    pattern:
      /-----BEGIN (?:[A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]*)PRIVATE KEY-----/g,
    replace: () => label('PRIVATE_KEY'),
  },
  // Authorization / Proxy-Authorization header values (curl -H "...", raw headers).
  {
    name: 'authorization-header',
    pattern: /((?:Proxy-)?Authorization"?\s*:\s*)(?:Bearer\s+|Basic\s+)?[^\s"']+/gi,
    replace: (_m, p1: string) => `${p1}${REDACTED}`,
  },
  // Bearer tokens anywhere.
  {
    name: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g,
    replace: () => `Bearer ${REDACTED}`,
  },
  // Anthropic keys (must precede the generic sk- rule).
  {
    name: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    replace: () => label('ANTHROPIC_KEY'),
  },
  // OpenAI-style keys.
  {
    name: 'openai-key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
    replace: () => label('OPENAI_KEY'),
  },
  // Stripe keys.
  {
    name: 'stripe-key',
    pattern: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
    replace: () => label('STRIPE_KEY'),
  },
  // AWS access key IDs.
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA|AROA|AIDA|ANPA|AIPA)[0-9A-Z]{12,}\b/g,
    replace: () => label('AWS_KEY_ID'),
  },
  // GitHub tokens (classic + fine-grained + OAuth/refresh).
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replace: () => label('GITHUB_TOKEN'),
  },
  // GitLab personal / project access tokens.
  {
    name: 'gitlab-token',
    pattern: /\b(?:glpat|gldt|glrt|glsoat)-[A-Za-z0-9_-]{20,}\b/g,
    replace: () => label('GITLAB_TOKEN'),
  },
  // Slack tokens.
  {
    name: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => label('SLACK_TOKEN'),
  },
  // Google API keys.
  {
    name: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: () => label('GOOGLE_API_KEY'),
  },
  // JWT-shaped tokens.
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: () => label('JWT'),
  },
  // URLs carrying userinfo: scheme://user:password@host -> mask the password.
  {
    name: 'url-userinfo',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+):([^\s@/"']+)@/gi,
    replace: (_m, p1: string) => `${p1}:${REDACTED}@`,
  },
  // scheme://token@host (single userinfo component) -> mask the token.
  {
    name: 'url-userinfo-single',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@"']+)@/gi,
    replace: (_m, p1: string) => `${p1}${REDACTED}@`,
  },
  // Long-form CLI flags carrying a secret value: --token=xxx / --token xxx.
  {
    name: 'sensitive-flag',
    pattern:
      /(--(?:[a-z0-9-]*(?:token|secret|password|passwd|api-key|apikey|access-key|secret-access-key|private-key|api-token|auth|credential)[a-z0-9-]*))(\s*=\s*|\s+)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[\s\S]*?(?=\s+-{1,2}[a-z0-9][a-z0-9-]*(?:\s|=|$)|\s*(?:&&|\|\||[;|\n])|$))/gi,
    replace: (_m, flag: string, sep: string, value: string) => {
      const quote = value[0];
      const replacement = quote === '"' || quote === "'" ? `${quote}${REDACTED}${quote}` : REDACTED;
      return `${flag}${sep}${replacement}`;
    },
  },
  // key/value assignments (env, JSON, YAML, dotenv): NAME=value / "name": "value".
  {
    name: 'sensitive-assignment',
    pattern:
      /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key|secret[_-]?access[_-]?key|private[_-]?key|credential|auth[_-]?token)[A-Za-z0-9_.-]*)("?\s*[=:]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[\s\S]*?(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s+-{1,2}[a-z0-9][a-z0-9-]*(?:\s|=|$)|\s*(?:&&|\|\||[;|\n])|$))/gi,
    replace: (_m, name: string, sep: string, value: string) => {
      const quote = value[0];
      const replacement = quote === '"' || quote === "'" ? `${quote}${REDACTED}${quote}` : REDACTED;
      return `${name}${sep}${replacement}`;
    },
  },
];

/**
 * Redact possible credentials from a single string.
 * Deterministic and idempotent enough that a redacted string re-redacts to
 * itself.
 */
export function redact(input: string): string {
  if (input.length === 0) return input;
  let out = input;
  for (const rule of RULES) {
    // Fresh lastIndex each pass because patterns are global.
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, rule.replace as (...args: string[]) => string);
  }
  return out;
}

/** Redact and clamp evidence to a bounded length for compact output. */
export function redactEvidence(input: string, maxLength = 200): string {
  const redacted = redact(input.trim());
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength - 1)}…`;
}
