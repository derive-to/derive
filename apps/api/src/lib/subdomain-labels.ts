/**
 * The one rulebook for a vanity label under DERIVE_SUBDOMAIN_BASE, shared by the
 * per-artifact claim (routes/domains.ts) and the workspace claim
 * (routes/workspace-domains.ts). Both write into the same `domain` table keyed by
 * host, so they share one namespace: a label an artifact holds is a label no
 * workspace can take, and vice versa. Keeping the validator and the reserved list
 * here means the two claims can never disagree about what a legal label is.
 */

// Labels nobody may claim: they belong to the app, common infra, or read as ours.
// Kept generous on purpose; a label here is a support ticket avoided, and a real
// customer never wanted "login" as their brand.
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
  "agent",
  "agents",
  "share",
  "embed",
  "preview",
  "public",
  "internal",
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
  "media",
  "img",
  "files",
  "ftp",
  "vpn",
  "git",
  "status",
  "health",
  "metrics",
  "test",
  "staging",
  "dev",
  "beta",
  "demo",
  "localhost",
  // support surfaces we or a customer would expect to be first-party
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

// A single DNS label: 1-63 chars, a-z0-9 and hyphens, not hyphen-edged.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Lower-cased and trimmed; the shape every claim stores and compares. */
export const normalizeLabel = (raw: string): string => raw.trim().toLowerCase()

/** True when `label` (already normalized) is a legal, unreserved subdomain label. */
export const isClaimableLabel = (label: string): boolean =>
  LABEL.test(label) && !RESERVED_LABELS.has(label)
