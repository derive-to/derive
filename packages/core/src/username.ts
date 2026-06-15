/**
 * Account handles — the public, GitHub-style username that is becoming the
 * primary way to identify, @mention, share with, and link to a person (the
 * Profiles & Accounts direction). Lowercased; letters, digits, and single
 * `-`/`_` separators between them; 2–30 chars; starts and ends with a letter or
 * digit. Reserved words protect the app's own top-level routes so a handle can
 * never shadow `/login`, `/settings`, an API path, etc.
 */

export const USERNAME_MIN = 2
export const USERNAME_MAX = 30

// Alnum-bounded with interior single separators: start alnum, then up to MAX-1
// more chars where every `-`/`_` must be followed by an alnum (so no trailing or
// doubled separators). The {1,29} also enforces the 2–30 length window.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9]|[-_](?=[a-z0-9])){1,29}$/

// Handles that would collide with a top-level route or carry reserved meaning.
// Lowercased. Profiles live at /u/:handle today, but reserving these keeps a
// handle safe even as more top-level routes (a vanity /:handle, /following, …)
// get added later.
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
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

/** Lowercase + trim — the canonical stored form. */
export const normalizeUsername = (raw: string): string => raw.trim().toLowerCase()

/**
 * Validate a handle. Returns null when it's a legal, available-shaped handle, or
 * a short human message naming the problem (shown on the claim form). Normalizes
 * first, so callers can pass raw input.
 */
export const usernameError = (raw: string): string | null => {
  const u = normalizeUsername(raw)
  if (u.length < USERNAME_MIN) return `Use at least ${USERNAME_MIN} characters.`
  if (u.length > USERNAME_MAX) return `Keep it to ${USERNAME_MAX} characters or fewer.`
  if (!USERNAME_RE.test(u)) return "Use letters, numbers, and single - or _ between them."
  if (RESERVED_USERNAMES.has(u)) return "That username is reserved."
  return null
}

/**
 * A starting handle suggestion from a display name or email local-part: keep the
 * legal characters, collapse separator runs, trim to the max, and pad if it came
 * out too short. Best-effort — the caller still checks validity + availability.
 */
export const suggestUsername = (nameOrEmail: string): string => {
  const base = nameOrEmail.split("@")[0] ?? ""
  let s = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, USERNAME_MAX)
    .replace(/[-_]+$/g, "")
  // Pad a too-short stem past the minimum, and never collapse an all-punctuation
  // input to a bare reserved word ("" → "newuser", not "user").
  if (s.length < USERNAME_MIN) s = `${s || "new"}user`.slice(0, USERNAME_MAX)
  return s
}
