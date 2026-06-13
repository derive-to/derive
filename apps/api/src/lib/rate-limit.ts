import type { Context, Next } from "hono"

/** Fixed-window per-IP limiter. In-memory (per instance); good enough as a
 *  brute-force / abuse backstop on a single container. */
export function makeRateLimiter(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; reset: number }>()
  return async (c: Context, next: Next) => {
    const now = Date.now()
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k)
    const ip = (
      c.req.header("x-forwarded-for")?.split(",")[0] ??
      c.req.header("x-real-ip") ??
      "global"
    ).trim()
    let b = hits.get(ip)
    if (!b || b.reset < now) {
      b = { count: 0, reset: now + windowMs }
      hits.set(ip, b)
    }
    b.count++
    if (b.count > max) {
      c.header("Retry-After", String(Math.ceil((b.reset - now) / 1000)))
      return c.json({ error: "rate limit exceeded" }, 429)
    }
    return next()
  }
}

/** Fixed-window limiter keyed by an arbitrary string (e.g. an actor id), for
 *  identity-based limits on specific actions — distinct from the IP middleware. */
export function makeKeyedLimiter(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; reset: number }>()
  return (key: string): { ok: boolean; retryAfter: number } => {
    const now = Date.now()
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k)
    let b = hits.get(key)
    if (!b || b.reset < now) {
      b = { count: 0, reset: now + windowMs }
      hits.set(key, b)
    }
    b.count++
    return { ok: b.count <= max, retryAfter: Math.ceil((b.reset - now) / 1000) }
  }
}
