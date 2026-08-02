import type { LinkRole, Listed, Role, WorkspaceAccess } from "@derive/core"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { z } from "zod"

/**
 * The one error-response shape. Routes return `fail(c, status, message)` rather
 * than a bare `c.json({ error }, status)`, so the error contract lives in one
 * place. Enforced by the no-ad-hoc-error guard (scripts/check-api.mjs).
 * `extra` carries machine-readable context a client renders a flow around (e.g.
 * the invite accept page's email_mismatch confirm) — never secrets, always additive.
 */
export const fail = (
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  extra?: Record<string, unknown>,
) => c.json({ error: message, ...extra }, status)

/**
 * Parse + validate a JSON request body against a zod schema. Returns the typed,
 * validated data, or a 400 `Response` the caller returns directly:
 *
 *   const body = await readJson(c, z.object({ title: z.string().min(1) }))
 *   if (body instanceof Response) return body
 *
 * Replaces the unchecked `(await c.req.json().catch(() => ({}))) as T` cast, so a
 * new or renamed field can't slip past validation. Enforced by the
 * no-raw-json-cast guard (scripts/check-api.mjs).
 */
export const readJson = async <T>(c: Context, schema: z.ZodType<T>): Promise<T | Response> => {
  const raw = await c.req.json().catch(() => ({}))
  const parsed = schema.safeParse(raw)
  if (!parsed.success)
    return fail(c, 400, parsed.error.issues[0]?.message ?? "invalid request body")
  return parsed.data
}

/**
 * Pass a guard's early-return `Response` through an `@hono/zod-openapi` handler.
 * That library types a handler's return as ONLY the route's declared responses, but
 * our shared guards (`requireUser`, `readJson`, per-route `resolve`) return a plain
 * `Response` for the error paths — already-correct HTTP replies. `bail` relaxes just
 * the compile-time return type (to `never`, which unions away, leaving the checked
 * success shape intact); it changes nothing at runtime. Contract-first routes only:
 *
 *   const me = await requireUser(c)
 *   if (me instanceof Response) return bail(me)
 */
export const bail = (r: Response): never => r as never

export const DEFAULT_WORKSPACE_NAME = "My Workspace"
/** Cookie holding the active workspace id (multi-workspace mode). */
export const WS_COOKIE = "derive_ws"
/** Long-lived cookie that gives an anonymous browser one stable identity — used
 *  for unique-view counts and a stable presence name across opens. */
export const VIEWER_COOKIE = "derive_vid"
/** Better Auth's session cookie, both spellings (useSecureCookies adds the
 *  __Secure- prefix on https origins). For presence-only checks; never validate
 *  a session by cookie name alone. */
export const SESSION_COOKIE_NAMES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
]

// Friendly, anonymous presence handles — `helpful-kitty-95` style. An anonymous
// viewer never picks their own name (no impersonation/spam); the server derives a
// stable one from their viewer cookie, so the same browser keeps the same handle.
const ANON_ADJECTIVES = [
  "helpful",
  "brave",
  "calm",
  "clever",
  "eager",
  "gentle",
  "jolly",
  "keen",
  "lively",
  "mellow",
  "nimble",
  "plucky",
  "quiet",
  "swift",
  "witty",
  "zesty",
  "sunny",
  "breezy",
  "cosy",
  "merry",
  "spry",
  "chipper",
  "dapper",
  "snappy",
] as const
const ANON_ANIMALS = [
  "kitty",
  "otter",
  "panda",
  "koala",
  "finch",
  "lynx",
  "heron",
  "tapir",
  "gecko",
  "moth",
  "wren",
  "yak",
  "ibis",
  "puma",
  "seal",
  "crane",
  "fox",
  "robin",
  "badger",
  "newt",
  "vole",
  "swan",
  "hare",
  "owl",
] as const

/** A deterministic `adjective-animal-NN` handle for an anonymous viewer, keyed to
 *  a stable seed (their viewer cookie) so it doesn't change between heartbeats. */
export const anonName = (seed: string): string => {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h >>>= 0
  const adj = ANON_ADJECTIVES[h % ANON_ADJECTIVES.length]
  const animal = ANON_ANIMALS[(h >>> 8) % ANON_ANIMALS.length]
  return `${adj}-${animal}-${(h >>> 16) % 100}`
}

export const VISIBILITIES = ["public", "org", "private"] as const

/** Pre-v2 wire vocabulary, still accepted on the publish/access params below
 *  (legacyAccessOf) so old clients keep working. Purely a request-body dialect —
 *  the v1 DB columns it once named are gone. */
type Visibility = (typeof VISIBILITIES)[number]

/** Pre-collapse visibility vocabulary, mapped so old clients (a pinned CLI, a
 *  self-hosted stdio MCP, saved derive.json files) keep publishing without an
 *  upgrade. `password` maps to public — its hash, when supplied, is the lock.
 *  `workspace` is the MCP tools' human-friendly spelling of `org`. */
const LEGACY_VISIBILITY: Record<string, Visibility> = {
  link: "public",
  password: "public",
  unlisted: "private",
  workspace: "org",
}

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/** Repeat opens by the same viewer of the same version inside this window collapse
 *  to one recorded view — a refresh or quick re-open doesn't inflate the count. */
export const VIEW_DEDUP_MS = 30 * 60_000

/** Versioned, fully-public artifact paths are immutable by construction. */
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

/** The raw-content capability token: how long a token stays VALID, and how coarsely its
 *  timestamp is bucketed when minted.
 *
 *  The window is deliberately SHORTER than the max age, and the gap is the point. Minting
 *  with a bucketed timestamp makes the token — and therefore the viewer's iframe URL —
 *  byte-identical for every mint inside the window, which is what makes its cached bytes
 *  reachable on a re-open. But if the bucket were as long as the validity, a token minted
 *  at the end of a window would expire seconds later. With a 2-minute window inside a
 *  5-minute validity, every token has at least 3 minutes of life left when it is handed
 *  out, and the maximum life is still 5 minutes — exactly what it was before bucketing.
 *
 *  The raw response is cached for the WINDOW, not the validity, so a cache entry can
 *  never outlive the URL that reaches it. */
export const RAW_TOKEN_MAX_AGE_MS = 5 * 60 * 1000
export const RAW_TOKEN_WINDOW_MS = 2 * 60 * 1000

/** Headers for everything inside the artifact sandbox. */
export const RAW_HEADERS: Record<string, string> = {
  // Opaque origin: scripts run, but can touch no cookies, storage, or APIs.
  "Content-Security-Policy":
    "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  // Raw artifact bytes are never the indexable surface; keeping them out of
  // search engines also blunts using the host for SEO-spam/phishing.
  "X-Robots-Tag": "noindex",
  "Cache-Control": IMMUTABLE_CACHE,
}

/**
 * Cache-Control for an artifact's bytes by access model. Only an UNLOCKED
 * artifact whose world link grants access (`link_role != none`) is safe to sit
 * in a shared/CDN cache: everyone hitting the URL reads the same bytes. Workspace-
 * and share-only access is per-identity, and a password lock is a per-visitor gate
 * the cache key doesn't carry — a shared cache must never store one response and
 * replay it to a viewer who never passed the gate. Everything else ⇒ `private, no-store`.
 */
export const cacheControlFor = (linkRole: LinkRole, locked = false): string =>
  linkRole !== "none" && !locked ? IMMUTABLE_CACHE : "private, no-store"

/** A taken-down artifact: content is gone (410), the record is preserved. */
export const TOMBSTONE = "This artifact was removed."

/** Copy into a plain ArrayBuffer — what Hono's body() accepts. */
export const toBody = (u: Uint8Array): ArrayBuffer => new Uint8Array(u).buffer as ArrayBuffer

/**
 * Embedded mode serves bundles under /raw/:id/v/:n/, so root-absolute URLs
 * (href="/x", src="/x", url(/x)) must be prefixed or they escape the artifact.
 * Domain mode (per-artifact origin) makes this a no-op later.
 */
export const rewriteAbsoluteUrls = (text: string, prefix: string): string =>
  text
    .replace(/(\b(?:href|src|action|srcset|poster)=["'])\/(?!\/)/g, `$1${prefix}/`)
    .replace(/(url\(\s*['"]?)\/(?!\/)/g, `$1${prefix}/`)

// Workspace membership is three simple roles, presented to people as
// Admin / Creator / Viewer:
//   - owner     → Admin:   manage members + settings (and everything below)
//   - editor    → Creator: create + publish artifacts
//   - commenter → Viewer:  read + comment
// The canonical Role vocabulary is unchanged; a bare read-only "viewer" isn't
// offered as a workspace role (a Viewer can always comment).
export const isWorkspaceRole = (v: unknown): v is Role =>
  v === "owner" || v === "editor" || v === "commenter"

export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined

/** The v2 access model's three single-purpose fields (see access-model.md):
 *  who the workspace's members reach the doc as, what the world link confers,
 *  and where the doc surfaces for discovery. */
export const WORKSPACE_ACCESSES = ["none", "member"] as const
export const LINK_ROLES = ["none", "viewer", "commenter", "editor"] as const
export const LISTEDS = ["none", "workspace", "public"] as const

export const workspaceAccessOf = (v: unknown): WorkspaceAccess | undefined =>
  typeof v === "string" && (WORKSPACE_ACCESSES as readonly string[]).includes(v)
    ? (v as WorkspaceAccess)
    : undefined

/** `general_role` is a legacy wire alias for the world link role: pre-v2 clients
 *  only ever sent `viewer`/`commenter`, both valid LinkRole literals, so this just
 *  accepts either field name. */
export const linkRoleOf = (v: unknown): LinkRole | undefined =>
  typeof v === "string" && (LINK_ROLES as readonly string[]).includes(v)
    ? (v as LinkRole)
    : undefined

export const listedOf = (v: unknown): Listed | undefined =>
  typeof v === "string" && (LISTEDS as readonly string[]).includes(v) ? (v as Listed) : undefined

/** Access triple a legacy `visibility` maps onto, so a pinned CLI, a self-hosted
 *  stdio MCP, or a saved derive.json keeps publishing without an upgrade. Same
 *  mapping the one-time boot backfill applies to stored rows (see backfillAccess):
 *    private → nobody but shares; org → the workspace, listed in its library;
 *    public → the workspace + a world link (its role from `general_role`, default
 *    viewer), listed in the public directory. Returns undefined for an unknown
 *    value so the caller can 400 rather than silently publish more openly. */
export const legacyAccessOf = (
  v: string,
  generalRole?: LinkRole,
): { workspace_access: WorkspaceAccess; link_role: LinkRole; listed: Listed } | undefined => {
  const canon = (VISIBILITIES as readonly string[]).includes(v)
    ? (v as Visibility)
    : LEGACY_VISIBILITY[v]
  if (!canon) return undefined
  if (canon === "private") return { workspace_access: "none", link_role: "none", listed: "none" }
  if (canon === "org") return { workspace_access: "member", link_role: "none", listed: "workspace" }
  return { workspace_access: "member", link_role: generalRole ?? "viewer", listed: "public" }
}

/**
 * Echo-origin CORS middleware so the cross-origin SPA can send cookies. Headers
 * are written onto the final response after next() — the Better Auth handler
 * returns its own Response, so setting them beforehand would be discarded.
 */
export const corsFor = (allowed: Set<string>) => async (c: Context, next: () => Promise<void>) => {
  const origin = c.req.header("origin")
  const ok = !!origin && allowed.has(origin)
  if (ok && c.req.method === "OPTIONS")
    return c.body(null, 204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    })
  await next()
  if (ok) {
    c.res.headers.set("Access-Control-Allow-Origin", origin)
    c.res.headers.set("Access-Control-Allow-Credentials", "true")
    c.res.headers.append("Vary", "Origin")
  }
}
