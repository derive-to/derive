/**
 * Vanity subdomain labels: the `<label>` in `<label>.<base>` (DERIVE_SUBDOMAIN_BASE),
 * claimed per artifact or per workspace. Both claims insert into the same host-keyed
 * table, so they share one namespace and one grammar. Shared with the web client so
 * the claim form refuses what the API would 400.
 */

// A single DNS label: 1-63 chars, a-z0-9 and hyphens, not hyphen-edged.
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

// Labels that belong to the app or common infra, or would read as first-party.
export const RESERVED_LABELS: ReadonlySet<string> = new Set([
  // app + product
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
  // infra + mail
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
  // support surfaces
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
  if (RESERVED_LABELS.has(label)) return "That name is reserved."
  return null
}
