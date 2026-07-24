import { type MetaStore, newId, parseRef } from "@derive/core"
import type { Context, MiddlewareHandler } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { SESSION_COOKIE_NAMES } from "./http"

/**
 * Signup-source capture. An external GET on an HTML entry point — an
 * `/artifacts/:ref` share link, or `/` / `/pricing` carrying a `?src=` campaign
 * tag — stamps an httpOnly `d_src` cookie: the surface (`badge`, `comment_wall`,
 * a campaign token, or bare `artifact_visit`), the artifact, the landing path,
 * and the external referrer host. Last touch wins.
 *
 * The other half runs at signup: Better Auth's user-create hook feeds the Cookie
 * header to `signupAttributionHook`, which parses the stamp and writes the
 * account's `signup_attribution` row (unique per user, so first write wins).
 * No stamp — or a garbage one — is an organic signup, never an error.
 */

/** Cookie name for the signup-source stamp. */
export const SRC_COOKIE = "d_src"

/** 30 days: long enough to span seeing a shared artifact and signing up later. */
const MAX_AGE_S = 30 * 24 * 3600

// A campaign/surface token (`badge`, `comment_wall`, `hn-launch`) — never markup.
const KIND = /^[a-z0-9][a-z0-9_-]{0,39}$/i
// An artifact short id (the shape core's parseRef extracts).
const SHORT_ID = /^[0-9a-z]{6,12}$/

/** What the capture middleware stamped, decoded for the signup hook. */
export interface ParsedSrc {
  source_kind: string
  source_artifact: string | null
  landing_path: string | null
  referrer: string | null
}

// A hand-typed or truncated share link can carry broken percent-encoding;
// decodeURIComponent would throw and 500 the page over a tracking cookie.
const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** The external referrer's host — null when missing, unparsable, or same-host
 *  (internal navigation is not a source). */
const referrerHost = (referer: string | undefined, ownHost: string): string | null => {
  if (!referer) return null
  try {
    const host = new URL(referer).host
    return host && host !== ownHost ? host.slice(0, 100) : null
  } catch {
    return null
  }
}

const stamp = (c: Context): void => {
  if (c.req.method !== "GET") return
  const path = c.req.path
  // Only the HTML entry points stamp — never API, raw-viewer, or asset paths.
  const ref = path.startsWith("/artifacts/") ? path.slice("/artifacts/".length) : null
  if (ref === null && path !== "/" && path !== "/pricing") return
  // A signed-in visitor can't sign up again; skip the write (presence-only check,
  // a stale cookie just skips the stamp).
  if (SESSION_COOKIE_NAMES.some((n) => getCookie(c, n))) return

  const srcParam = c.req.query("src")
  const kind =
    srcParam && KIND.test(srcParam)
      ? srcParam.toLowerCase()
      : ref !== null
        ? "artifact_visit"
        : null
  // A bare marketing view is not a source — organic stays unattributed.
  if (!kind) return

  // `?art=` lets a campaign link name the artifact; a share link carries it in the ref.
  const artParam = c.req.query("art")
  const fromRef = ref !== null ? parseRef(safeDecode(ref)).shortId : null
  const artifact =
    artParam && SHORT_ID.test(artParam)
      ? artParam
      : fromRef && SHORT_ID.test(fromRef)
        ? fromRef
        : null
  // Host is the origin the visitor actually hit; a same-host referer is internal
  // navigation, not a source.
  const referrer = referrerHost(c.req.header("referer"), c.req.header("host") ?? "")

  const value = JSON.stringify({
    k: kind,
    ...(artifact ? { a: artifact } : {}),
    p: path.slice(0, 200),
    ...(referrer ? { r: referrer } : {}),
  })
  setCookie(c, SRC_COOKIE, value, {
    path: "/",
    // Deliberately NOT HttpOnly: the SPA rewrites this cookie on badge/CTA clicks
    // to refine WHICH surface converted (lib/src-stamp.ts in apps/web), and JS
    // writes to an HttpOnly cookie are silently ignored. Contents are a path and
    // a token — nothing sensitive — and artifacts render on an opaque origin that
    // can't reach app cookies.
    sameSite: "Lax",
    maxAge: MAX_AGE_S,
    secure: c.req.url.startsWith("https://"),
  })
}

/** Mount once with `app.use("*", …)`; `stamp` itself scopes to the entry points. */
export const captureSignupSource = (): MiddlewareHandler => async (c, next) => {
  stamp(c)
  await next()
}

/** The signup half: parse the arriving Cookie header, record the row. Wired into
 *  AuthHooks by both the Node and Worker entries. */
export const signupAttributionHook =
  (meta: MetaStore) =>
  async (userId: string, cookieHeader: string | null): Promise<void> => {
    const src = parseSrcCookie(cookieHeader)
    if (!src) return
    await meta.recordSignupAttribution({ id: newId("src"), user_id: userId, ...src })
  }

/** Decode the `d_src` stamp from a raw Cookie header; null for absent or invalid. */
export const parseSrcCookie = (cookieHeader: string | null): ParsedSrc | null => {
  if (!cookieHeader) return null
  const pair = cookieHeader.split(/;\s*/).find((p) => p.startsWith(`${SRC_COOKIE}=`))
  if (!pair) return null
  try {
    const v = JSON.parse(decodeURIComponent(pair.slice(SRC_COOKIE.length + 1))) as Record<
      string,
      unknown
    >
    const kind = typeof v.k === "string" && KIND.test(v.k) ? v.k.toLowerCase() : null
    if (!kind) return null
    return {
      source_kind: kind,
      source_artifact: typeof v.a === "string" && SHORT_ID.test(v.a) ? v.a : null,
      landing_path: typeof v.p === "string" ? v.p.slice(0, 200) : null,
      referrer: typeof v.r === "string" ? v.r.slice(0, 100) : null,
    }
  } catch {
    return null
  }
}
