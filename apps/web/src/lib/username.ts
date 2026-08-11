/**
 * Client mirror of packages/core/src/username.ts — kept separate so the SPA
 * bundle doesn't pull in @derive/core (same reasoning as lib/parse-ref). The server
 * is authoritative (POST /v1/me/username re-validates); this is for instant form
 * feedback + a starting suggestion. Keep the rules in sync with core.
 */

export const USERNAME_MIN = 2
export const USERNAME_MAX = 30

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9]|[-_](?=[a-z0-9])){1,29}$/
const USERNAME_QUERY_RE = /^[a-z0-9_-]{0,30}$/i

const RESERVED = new Set([
  "admin",
  "administrator",
  "api",
  "app",
  "apps",
  "derive",
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

export const normalizeUsername = (raw: string): string => raw.trim().toLowerCase()

/** Safe incomplete text for a mention picker; canonical handles still use usernameError. */
export const isUsernameQuery = (value: unknown): value is string =>
  typeof value === "string" && USERNAME_QUERY_RE.test(value)

/** Runtime mirror for places that receive a handle over postMessage rather than from the API. */
export const isValidUsername = (value: unknown): value is string =>
  typeof value === "string" && usernameError(value) === null

/** null when legal + available-shaped, else a short human message. */
export const usernameError = (raw: string): string | null => {
  const u = normalizeUsername(raw)
  if (u.length < USERNAME_MIN) return `Use at least ${USERNAME_MIN} characters.`
  if (u.length > USERNAME_MAX) return `Keep it to ${USERNAME_MAX} characters or fewer.`
  if (!USERNAME_RE.test(u)) return "Use letters, numbers, and single - or _ between them."
  if (RESERVED.has(u)) return "That username is reserved."
  return null
}
