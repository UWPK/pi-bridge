/**
 * Log/secret redaction (需求文档 §7.3, §8.1).
 *
 * All model/terminal output and captured environment must pass through here before
 * it is written to logs or returned in a handoff. Never a security boundary by itself,
 * but it removes the common credential shapes from audit files and git.
 */

const PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // Bearer tokens and Authorization headers
  { re: /\b(bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi, replace: "$1<redacted>" },
  { re: /\b(authorization\s*[:=]\s*)([^\s"']+)/gi, replace: "$1<redacted>" },
  // api keys / tokens in key=value form
  {
    re: /\b([A-Za-z0-9_\-.]*(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd|client[_-]?secret)\b\s*[:=]\s*)(["']?)([^\s"',]+)\2/gi,
    replace: "$1$2<redacted>$2",
  },
  // Common provider key prefixes
  { re: /\b(sk-[A-Za-z0-9]{12,})/g, replace: "<redacted-key>" },
  { re: /\b(sk-ant-[A-Za-z0-9._\-]{12,})/g, replace: "<redacted-key>" },
  { re: /\b(sk-proj-[A-Za-z0-9._\-]{12,})/g, replace: "<redacted-key>" },
  { re: /\b(ghp_[A-Za-z0-9]{20,})/g, replace: "<redacted-token>" },
  { re: /\b(github_pat_[A-Za-z0-9_]{20,})/g, replace: "<redacted-token>" },
  { re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})/g, replace: "<redacted-token>" },
  { re: /\b(AIza[0-9A-Za-z\-_]{20,})/g, replace: "<redacted-key>" },
  // JSON "key": "value" with sensitive key names
  {
    re: /("(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret|password|client[_-]?secret|authorization)"\s*:\s*")([^"]*)(")/gi,
    replace: "$1<redacted>$3",
  },
  // JWT-like blobs
  { re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}/g, replace: "<redacted-jwt>" },
];

/** Environment variable names whose values must never be logged. */
const SENSITIVE_ENV =
  /(key|token|secret|password|passwd|pwd|credential|auth|cookie|session)/i;

export function redactText(input: string): string {
  if (!input) return input;
  let out = input;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/** Recursively redact strings inside an arbitrary JSON value. */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_ENV.test(k)) {
        out[k] = "<redacted>";
      } else {
        out[k] = redactValue(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

/** Build a redacted snapshot of specific environment keys for diagnostics. */
export function redactEnv(env: NodeJS.ProcessEnv, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const raw = env[key];
    if (raw === undefined) continue;
    out[key] = SENSITIVE_ENV.test(key) ? "<redacted>" : redactText(raw);
  }
  return out;
}
