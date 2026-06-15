/**
 * Client mirror of packages/core/src/username.ts — kept separate so the SPA
 * bundle doesn't pull in @dock/core (same reasoning as lib/parse-ref). The server
 * is authoritative (POST /v1/me/username re-validates); this is just for instant
 * inline feedback while renaming. Keep the rules in sync with core.
 */

const USERNAME_MIN = 2
const USERNAME_MAX = 30

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9]|[-_](?=[a-z0-9])){1,29}$/

const RESERVED = new Set([
  "admin",
  "administrator",
  "api",
  "app",
  "apps",
  "dock",
  "root",
  "system",
  "support",
  "help",
  "about",
  "status",
  "security",
  "login",
  "logout",
  "signin",
  "signup",
  "signout",
  "auth",
  "oauth",
  "oauth2",
  "settings",
  "account",
  "accounts",
  "me",
  "you",
  "user",
  "users",
  "u",
  "a",
  "raw",
  "static",
  "assets",
  "public",
  "new",
  "edit",
  "delete",
  "profile",
  "profiles",
  "workspace",
  "workspaces",
  "org",
  "orgs",
  "team",
  "teams",
  "agent",
  "agents",
  "collection",
  "collections",
  "notification",
  "notifications",
  "search",
  "explore",
  "discover",
  "feed",
  "home",
  "dashboard",
  "billing",
  "terms",
  "privacy",
  "legal",
  "docs",
  "blog",
  "www",
  "mail",
  "cdn",
  "null",
  "undefined",
  "none",
  "anonymous",
  "everyone",
  "follow",
  "following",
  "followers",
])

const normalizeUsername = (raw: string): string => raw.trim().toLowerCase()

/** null when legal + available-shaped, else a short human message. */
export const usernameError = (raw: string): string | null => {
  const u = normalizeUsername(raw)
  if (u.length < USERNAME_MIN) return `Use at least ${USERNAME_MIN} characters.`
  if (u.length > USERNAME_MAX) return `Keep it to ${USERNAME_MAX} characters or fewer.`
  if (!USERNAME_RE.test(u)) return "Use letters, numbers, and single - or _ between them."
  if (RESERVED.has(u)) return "That username is reserved."
  return null
}
