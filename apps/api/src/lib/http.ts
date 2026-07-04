import type { Role, Visibility } from "@derive/core"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { z } from "zod"

/**
 * The one error-response shape. Routes return `fail(c, status, message)` rather
 * than a bare `c.json({ error }, status)`, so the error contract lives in one
 * place. Enforced by the no-ad-hoc-error guard (scripts/check-api.mjs).
 */
export const fail = (c: Context, status: ContentfulStatusCode, message: string) =>
  c.json({ error: message }, status)

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

export const DEFAULT_WORKSPACE_NAME = "My Workspace"
/** Cookie holding the active workspace id (multi-workspace mode). */
export const WS_COOKIE = "derive_ws"
/** Long-lived cookie that gives an anonymous browser one stable identity — used
 *  for unique-view counts and a stable presence name across opens. */
export const VIEWER_COOKIE = "derive_vid"

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

export const VISIBILITIES = ["public", "link", "org", "password", "private"] as const

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/** Repeat opens by the same viewer of the same version inside this window collapse
 *  to one recorded view — a refresh or quick re-open doesn't inflate the count. */
export const VIEW_DEDUP_MS = 30 * 60_000

/** Versioned, fully-public artifact paths are immutable by construction. */
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

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
 * Cache-Control for an artifact's bytes by access model. Only fully `public`
 * artifacts are safe to sit in a shared/CDN cache: `link`, `org`, and `password`
 * are gated (per-identity authorization, or a secret the cache key doesn't carry),
 * so a shared cache must never store one response and replay it to a viewer who
 * never passed the gate. Non-public ⇒ `private, no-store`.
 */
export const cacheControlFor = (visibility: Visibility): string =>
  visibility === "public" ? IMMUTABLE_CACHE : "private, no-store"

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

export const visibilityOf = (v: unknown): Visibility | undefined =>
  typeof v === "string" && (VISIBILITIES as readonly string[]).includes(v)
    ? (v as Visibility)
    : undefined

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
