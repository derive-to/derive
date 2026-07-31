import { describe, expect, it } from "vitest"
import {
  ANON_SHELL_CACHE_CONTROL,
  hasSessionCookie,
  withAnonEdgeCache,
} from "../src/lib/edge-cache"

// The share page is public but NOT universal: `readable()` authorises per viewer, so a
// member can see a title an anonymous visitor must not. Caching it on URL alone would
// eventually serve a member's rendering to the public — so the cookie guard is the whole
// safety argument, and these assert it directly rather than trusting the wrapper.

const req = (url: string, cookie?: string) =>
  new Request(url, cookie ? { headers: { cookie } } : undefined)

describe("hasSessionCookie", () => {
  it("detects both Better Auth spellings", () => {
    expect(hasSessionCookie(req("https://x/a", "better-auth.session_token=abc"))).toBe(true)
    expect(hasSessionCookie(req("https://x/a", "__Secure-better-auth.session_token=abc"))).toBe(
      true,
    )
  })

  it("is false for a cookieless request and for non-session cookies", () => {
    expect(hasSessionCookie(req("https://x/a"))).toBe(false)
    // The anonymous viewer id and the workspace cookie must NOT count as a session, or
    // every anonymous visitor with a viewer cookie would bypass the cache entirely.
    expect(hasSessionCookie(req("https://x/a", "derive_vid=v1; derive_ws=ws_1"))).toBe(false)
  })

  it("does not confuse a cookie whose VALUE mentions the name", () => {
    expect(hasSessionCookie(req("https://x/a", "other=better-auth.session_token"))).toBe(false)
  })
})

describe("withAnonEdgeCache", () => {
  it("runs produce() for a signed-in caller and does not cache", async () => {
    let built = 0
    const produce = async () => {
      built++
      return new Response("member view", { status: 200 })
    }
    const r = req("https://x/artifacts/a-1", "better-auth.session_token=abc")
    const first = await withAnonEdgeCache(r, produce)
    const second = await withAnonEdgeCache(r, produce)
    expect(await first.text()).toBe("member view")
    // Built twice: no cache participation at all on the signed-in path.
    expect(built).toBe(2)
    expect(second.headers.get("Cache-Control")).not.toBe(ANON_SHELL_CACHE_CONTROL)
  })

  it("stamps the short public TTL on an anonymous 200", async () => {
    const res = await withAnonEdgeCache(
      req("https://x/artifacts/a-2"),
      async () =>
        // No `caches` global in this environment, so withEdgeCache degrades to produce()
        // and we are asserting the header contract the edge would store.
        new Response("anon view", { status: 200, headers: { "Content-Type": "text/html" } }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe(ANON_SHELL_CACHE_CONTROL)
    expect(res.headers.get("Content-Type")).toBe("text/html")
    expect(await res.text()).toBe("anon view")
  })

  it("leaves a non-200 alone — a redirect or miss must never go sticky", async () => {
    const redirect = await withAnonEdgeCache(
      req("https://x/artifacts/stale-ref"),
      async () => new Response(null, { status: 302, headers: { location: "/artifacts/a-1" } }),
    )
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get("Cache-Control")).not.toBe(ANON_SHELL_CACHE_CONTROL)
  })
})
