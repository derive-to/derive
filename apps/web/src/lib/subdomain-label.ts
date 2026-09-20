/**
 * Client mirror of packages/core/src/subdomain-label.ts, kept separate so the SPA
 * bundle doesn't pull in @derive/core (same reasoning as lib/username). The server
 * re-validates on PUT /v1/workspace/subdomain; this is for instant form feedback.
 * Keep the rules in sync with core.
 */

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const RESERVED = new Set([
  "www",
  "app",
  "api",
  "raw",
  "admin",
  "dashboard",
  "settings",
  "login",
  "logout",
  "signin",
  "signup",
  "register",
  "auth",
  "oauth",
  "sso",
  "account",
  "billing",
  "checkout",
  "derive",
  "mcp",
  "cli",
  "share",
  "embed",
  "mail",
  "smtp",
  "imap",
  "pop",
  "mx",
  "ns",
  "ns1",
  "ns2",
  "dns",
  "cdn",
  "static",
  "assets",
  "ftp",
  "vpn",
  "git",
  "status",
  "health",
  "localhost",
  "docs",
  "help",
  "support",
  "blog",
  "security",
  "abuse",
  "legal",
  "privacy",
  "terms",
])

export const normalizeLabel = (raw: string): string => raw.trim().toLowerCase()

/** Null for a legal, unreserved label, else a short message for the claim form. */
export const labelError = (raw: string): string | null => {
  const label = normalizeLabel(raw)
  if (!label) return "Enter a name."
  if (!LABEL_RE.test(label))
    return "Letters, numbers and hyphens only, and it can't start or end with a hyphen."
  if (RESERVED.has(label)) return "That name is reserved."
  return null
}
