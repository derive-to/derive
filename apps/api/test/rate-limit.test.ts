import type { RateLimit } from "@cloudflare/workers-types"
import { Hono } from "hono"
import { describe, expect, it, vi } from "vitest"
import {
  inMemoryLimiter,
  inMemoryRateLimiters,
  ipRateLimit,
  nativeLimiter,
} from "../src/lib/rate-limit"

describe("inMemoryLimiter (fixed-window, in-process)", () => {
  it("counts up, trips at the cap, and isolates distinct keys", async () => {
    const limit = inMemoryLimiter(60_000, 2)
    expect((await limit("k")).ok).toBe(true)
    const second = await limit("k")
    expect(second.ok).toBe(true) // 2 == max
    expect(second.retryAfter).toBe(60) // ceil(60000 / 1000)
    expect((await limit("k")).ok).toBe(false) // 3 > max
    expect((await limit("other")).ok).toBe(true) // distinct key, fresh window
  })

  it("rolls over to a fresh window once it elapses", async () => {
    vi.useFakeTimers()
    try {
      const limit = inMemoryLimiter(1_000, 1)
      expect((await limit("k")).ok).toBe(true)
      expect((await limit("k")).ok).toBe(false) // still in window
      vi.advanceTimersByTime(1_001)
      expect((await limit("k")).ok).toBe(true) // new window, count starts over
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("ipRateLimit (IP middleware)", () => {
  const build = (max: number) => {
    const app = new Hono()
    app.use("*", ipRateLimit(inMemoryLimiter(60_000, max)))
    app.get("/", (c) => c.text("ok"))
    return app
  }

  it("429s with a Retry-After header once an IP exceeds the cap", async () => {
    const app = build(2)
    const ip = { "x-forwarded-for": "203.0.113.9" }
    expect((await app.request("/", { headers: ip })).status).toBe(200)
    expect((await app.request("/", { headers: ip })).status).toBe(200)
    const blocked = await app.request("/", { headers: ip })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0)
  })

  it("scopes the window per IP", async () => {
    const app = build(1)
    expect((await app.request("/", { headers: { "x-forwarded-for": "1.1.1.1" } })).status).toBe(200)
    // a different IP still has its own fresh window
    expect((await app.request("/", { headers: { "x-forwarded-for": "2.2.2.2" } })).status).toBe(200)
  })
})

describe("nativeLimiter (Cloudflare native binding adapter)", () => {
  it("maps success→ok and reports the period as retryAfter", async () => {
    let n = 0
    const binding: RateLimit = {
      limit: async () => {
        n++
        return { success: n <= 2 }
      },
    }
    const limit = nativeLimiter(binding, 60)
    expect(await limit("a")).toEqual({ ok: true, retryAfter: 60 })
    expect((await limit("a")).ok).toBe(true)
    expect((await limit("a")).ok).toBe(false) // 3rd hit over the fake's cap
  })

  it("namespaces the key by prefix so one binding can back two surfaces", async () => {
    const seen: string[] = []
    const binding: RateLimit = {
      limit: async ({ key }) => {
        seen.push(key)
        return { success: true }
      },
    }
    await nativeLimiter(binding, 60, "unlock")("ip:x")
    await nativeLimiter(binding, 60, "oauth-register")("ip:x")
    expect(seen).toEqual(["unlock:ip:x", "oauth-register:ip:x"]) // distinct counts on a shared binding
  })
})

describe("inMemoryRateLimiters (default set)", () => {
  it("honors the configured publish rate and gives each surface its own window", async () => {
    const rl = inMemoryRateLimiters({ publishRate: 1 })
    expect((await rl.publish("id:1")).ok).toBe(true)
    expect((await rl.publish("id:1")).ok).toBe(false) // publishRate = 1
    expect((await rl.comment("id:1")).ok).toBe(true) // different surface, own counter
  })
})
