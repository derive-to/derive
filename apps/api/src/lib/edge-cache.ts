import { edgeWaitUntil } from "../realtime-do"
import { SESSION_COOKIE_NAMES } from "./http"

/**
 * Serving an immutable response from Cloudflare's edge cache instead of rebuilding it.
 *
 * WHY THIS IS NEEDED AT ALL. A `Cache-Control` header on a Worker-generated response does not
 * populate the edge cache. Cloudflare caches what it fetches from an origin; a response this
 * Worker composed from a database row plus an R2 object is not that, so the header only ever
 * reached the browser. The app has set careful immutable headers on content-addressed bytes for
 * a long time and every request still ran the whole pipeline — the Cache API is the missing
 * half, and it has to be called explicitly.
 *
 * WHAT MAY USE THIS. Only responses that are a pure function of the URL and identical for every
 * caller. The edge cache key here is the request URL alone, so anything that varies by cookie,
 * header or role would be served to the wrong person — that is not a tuning mistake, it is a
 * data leak. Content-addressed bytes qualify because the hash IS the content: the same URL can
 * never mean different bytes, and there is nothing user-specific to vary on.
 *
 * ON NODE THIS IS A NO-OP. `caches` is a Workers global; self-hosted Node has no edge in front
 * of it, so the helper degrades to calling `produce()` and returning it.
 */

/** The Workers `caches.default`, or null anywhere that global does not exist (Node, tests). */
const edgeCache = (): Cache | null => {
  const c = (globalThis as { caches?: { default?: Cache } }).caches
  return c?.default ?? null
}

/**
 * Return a cached response for this request, else build one and cache it.
 *
 * `produce` runs only on a miss. Its response is cached only when it is a 200 — an error or a
 * 404 must never become sticky for a year, and a partial (206) is not the whole resource.
 *
 * The `put` is deliberately NOT awaited: it rides `waitUntil`, so the caller gets its bytes
 * without waiting for the cache write. A failed write is swallowed for the same reason a failed
 * cache read is — the origin path just runs again next time, which is exactly today's behaviour.
 */
/** Response header naming which path the edge cache took: `hit`, `miss`, `bypass` (the
 *  caller opted out, e.g. a signed-in request on an anon-only cache), or `unavailable`
 *  (no `caches` global — Node, tests, and possibly a workers.dev preview).
 *
 *  This exists because the cache is otherwise UNPROVABLE from outside. Cloudflare sets
 *  `cf-cache-status` for its own CDN cache, not for a Cache API hit a Worker serves, so
 *  a repeat request that is genuinely being served from cache looks identical to one
 *  that is not — which is exactly the position the share-page work got stuck in. One
 *  header turns "I believe this caches" into something a curl can settle, on any host. */
export const CACHE_STATUS_HEADER = "x-derive-cache"

const withStatus = (res: Response, status: "hit" | "miss" | "bypass" | "unavailable") => {
  const headers = new Headers(res.headers)
  headers.set(CACHE_STATUS_HEADER, status)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export const withEdgeCache = async (
  req: Request,
  produce: () => Promise<Response>,
): Promise<Response> => {
  const cache = edgeCache()
  // No `caches` global at all: Node, tests, and — a real possibility this header exists
  // to confirm or refute — a workers.dev preview hostname.
  if (!cache) return withStatus(await produce(), "unavailable")
  // Only GET is cacheable, and `cache.match` would throw on anything else.
  if (req.method !== "GET") return withStatus(await produce(), "bypass")

  const hit = await cache.match(req).catch(() => undefined)
  if (hit) return withStatus(hit, "hit")

  const res = await produce()
  if (res.status === 200) {
    // The body can only be consumed once, so the cache gets a clone and the caller the
    // original. The clone is stored WITHOUT the status header (it is stamped on the way
    // out), so a later hit is not mislabelled as the miss that populated it.
    edgeWaitUntil(cache.put(req, res.clone()).catch(() => {}))
  }
  return withStatus(res, "miss")
}

/**
 * The same edge cache, for a response that is public but NOT universal: the
 * server-rendered share page (`/artifacts/:ref`). It carries unfurl meta for crawlers and
 * strangers, and it is the slowest shell Derive serves — TTFB 266-618ms against ~56ms for
 * the static app shell, because `run_worker_first` sends it through the Worker and a
 * database read on every single visit. It is also the surface a stranger judges Derive by,
 * and the one where a regression is least likely to be noticed by anyone who works here.
 *
 * WHY IT CANNOT USE `withEdgeCache`. That helper's contract is "identical for every
 * caller", and this page is not: `readable()` authorises per viewer, so a member can see a
 * title an anonymous visitor must not. Caching it on URL alone would eventually serve a
 * member's rendering of a private artifact to the public. That is the failure this guard
 * exists to make impossible.
 *
 * THE GUARD. A request carrying ANY Better Auth session cookie skips the cache completely —
 * it neither reads nor writes. So the cache only ever contains responses built for an
 * anonymous viewer, and only anonymous viewers can ever read them. A signed-in member always
 * gets a fresh render. The check is deliberately cookie-PRESENCE, not session validity: it
 * is a routing decision, not an authorization one, and erring toward "bypass the cache" is
 * always safe (worst case is today's behaviour, a fresh render).
 *
 * TTL. Short and explicit, because unfurl meta is derived from live data (title, version
 * count, comment count) and a share link whose card is a day stale is worse than one that
 * costs 300ms. `stale-while-revalidate` keeps the fast path during the refresh.
 */
export const ANON_SHELL_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=600"

export const hasSessionCookie = (req: Request): boolean => {
  const cookie = req.headers.get("cookie")
  return !!cookie && SESSION_COOKIE_NAMES.some((name) => cookie.includes(`${name}=`))
}

export const withAnonEdgeCache = async (
  req: Request,
  produce: () => Promise<Response>,
): Promise<Response> => {
  // A signed-in caller never touches this cache, in either direction.
  if (hasSessionCookie(req)) return withStatus(await produce(), "bypass")
  return withEdgeCache(req, async () => {
    const res = await produce()
    if (res.status !== 200) return res
    // Set the TTL on the response the cache stores AND on the one the caller gets, so the
    // browser and the edge agree about how long this rendering is good for.
    const headers = new Headers(res.headers)
    headers.set("Cache-Control", ANON_SHELL_CACHE_CONTROL)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  })
}
