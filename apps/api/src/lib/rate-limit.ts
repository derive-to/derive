import type { RateLimit } from "@cloudflare/workers-types"
import type { Context, Next } from "hono"

/** A rate-limit verdict for one request: within the cap, and seconds to retry if not. */
export type RateLimitVerdict = { ok: boolean; retryAfter: number }

/**
 * Check one request against a cap, keyed by IP or actor id. Async because the backing
 * limiter may be remote: in-process on a single container (Node / self-host), or the
 * Cloudflare native per-colo limiter on the edge.
 */
export type Limiter = (key: string) => Promise<RateLimitVerdict>

/**
 * An in-process fixed-window limiter — one counter Map. Authoritative on a single
 * container (Node / self-host) and the universal default + test path. A lazy sweep of
 * expired entries caps the Map so a flood of distinct keys can't grow it without bound.
 */
export function inMemoryLimiter(windowMs: number, max: number): Limiter {
  const hits = new Map<string, { count: number; reset: number }>()
  return async (key) => {
    const now = Date.now()
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k)
    const cur = hits.get(key)
    const b = !cur || cur.reset < now ? { count: 0, reset: now + windowMs } : cur
    b.count++
    hits.set(key, b)
    return { ok: b.count <= max, retryAfter: Math.ceil((b.reset - now) / 1000) }
  }
}

/**
 * A limiter over a Cloudflare native rate-limit binding (per-colo, fixed window declared
 * in wrangler). The binding returns only success/fail, so `period` (its configured window,
 * 10 or 60s) is reported as Retry-After. `prefix` namespaces the key when one binding
 * backs more than one surface, so their counts stay separate.
 */
export function nativeLimiter(binding: RateLimit, period: number, prefix = ""): Limiter {
  return async (key) => {
    const { success } = await binding.limit({ key: prefix ? `${prefix}:${key}` : key })
    return { ok: success, retryAfter: period }
  }
}

/** The rate-limited surfaces, as ready-to-call limiters. Built from in-process counters
 *  (Node / self-host / tests) or native bindings (the edge). */
export interface RateLimiters {
  auth: Limiter
  /** Tight cap on the auth endpoints that SEND email (password reset, verification,
   *  change-email): each request emails a (possibly unwilling) address, so this bounds
   *  inbox-bombing far below the general `auth` cap. */
  authEmail: Limiter
  oauthRegister: Limiter
  write: Limiter
  publish: Limiter
  comment: Limiter
  unlock: Limiter
  /** Invite creation (workspace + artifact). Each request emails an arbitrary,
   *  possibly unwilling address with caller-influenced content (the artifact
   *  title rides the subject) — cap it well below the general write rate. */
  invite: Limiter
  /** MCP `ask` — each ask triggers a model run on a context owner's runner, so a
   *  looping agent is the realistic flood. Keyed by the acting human's id. */
  ask: Limiter
  /** Anonymous draft publishes (POST /v1/drafts) — the one unauthenticated write
   *  that creates durable state, so it gets its own tight long-window cap on top
   *  of the general publish limiter. Keyed by IP (there is no principal). */
  draftPublish: Limiter
}

/**
 * The default in-process limiter set, each surface at its real window — including the
 * long ones (unlock 5 min, oauth registration 1 hr) that the edge's native binding can't
 * express (its period is capped at 60s). publish/comment honor the configured per-minute
 * rates.
 */
export function inMemoryRateLimiters(
  opts: { publishRate?: number; commentRate?: number; askRate?: number } = {},
): RateLimiters {
  return {
    auth: inMemoryLimiter(60_000, 20),
    // 5 mail-triggering requests per 15 min per IP — room for a legitimate retry, but no
    // inbox-bombing. Same shape as `unlock` (a tight, long-window credential surface).
    authEmail: inMemoryLimiter(15 * 60_000, 5),
    oauthRegister: inMemoryLimiter(3_600_000, 10),
    write: inMemoryLimiter(60_000, 120),
    publish: inMemoryLimiter(60_000, opts.publishRate ?? 30),
    comment: inMemoryLimiter(60_000, opts.commentRate ?? 60),
    unlock: inMemoryLimiter(5 * 60_000, 5),
    // 10 invite emails per minute per actor: a whole team invited in one sitting
    // clears it; a spam cannon doesn't.
    invite: inMemoryLimiter(60_000, 10),
    // 10 asks per minute per acting human: a human-paced agent never sees it; a
    // runaway ask loop does — each ask is a model run on someone's runner.
    ask: inMemoryLimiter(60_000, opts.askRate ?? 10),
    // 12 anonymous drafts per hour per IP: an agent iterating on a page never sees
    // it; a bulk-hosting abuser does. The general publish limiter still applies.
    draftPublish: inMemoryLimiter(3_600_000, 12),
  }
}

/** The caller's IP from the proxy headers (first x-forwarded-for hop, then x-real-ip),
 *  falling back to `fallback` when neither is present ("global" = one shared bucket). */
export const clientIp = (c: Context, fallback = "global"): string =>
  (c.req.header("x-forwarded-for")?.split(",")[0] ?? c.req.header("x-real-ip") ?? fallback).trim()

/** The 429 response for a caller over a rate cap: a Retry-After header + a consistent body. */
export const rateLimited = (c: Context, retryAfter: number): Response => {
  c.header("Retry-After", String(retryAfter))
  return c.json({ error: "rate limit exceeded" }, 429)
}

/**
 * IP-keyed limiter middleware (brute-force / abuse backstop): 429 + Retry-After once the
 * caller's IP is over the cap, else passes through.
 */
export function ipRateLimit(limiter: Limiter) {
  return async (c: Context, next: Next) => {
    const r = await limiter(clientIp(c))
    if (r.ok) return next()
    return rateLimited(c, r.retryAfter)
  }
}
