import { edgeWaitUntil } from "../realtime-do"

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
export const withEdgeCache = async (
  req: Request,
  produce: () => Promise<Response>,
): Promise<Response> => {
  const cache = edgeCache()
  if (!cache) return produce()
  // Only GET is cacheable, and `cache.match` would throw on anything else.
  if (req.method !== "GET") return produce()

  const hit = await cache.match(req).catch(() => undefined)
  if (hit) return hit

  const res = await produce()
  if (res.status === 200) {
    // The body can only be consumed once, so the cache gets a clone and the caller the original.
    edgeWaitUntil(cache.put(req, res.clone()).catch(() => {}))
  }
  return res
}
