/** High-confidence credential patterns for content crossing a template boundary. */
const PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["database URL", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/i],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  [
    "named secret",
    /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret)\b\s*[:=]\s*["']?[^\s"'{}<>$]{12,}/i,
  ],
]

/**
 * This is a publication guard for common, high-confidence secrets—not a claim
 * that arbitrary prose can be proven secret-free. Template bindings and the
 * conventional placeholder forms are removed before scanning.
 */
export const likelySecrets = (source: string): string[] => {
  const withoutPlaceholders = source
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\$\{[^{}]*\}/g, "")
    .replace(/<(?:YOUR|INSERT|REPLACE)[^>]*>/gi, "")
  return PATTERNS.filter(([, pattern]) => pattern.test(withoutPlaceholders)).map(([name]) => name)
}
