import { describe, expect, it } from "vitest"
import { CACHE_STATUS_HEADER, withEdgeCache } from "../src/lib/edge-cache"

// The edge cache is otherwise unprovable from outside: Cloudflare sets cf-cache-status
// for its OWN CDN cache, not for a Cache API hit a Worker serves, so a response being
// served from cache looks identical to one that is not. This header is what turns
// "I believe this caches" into something a single curl can settle — and it is what
// diagnosed the share page (a Set-Cookie on the response, which the Cache API refuses
// to store, so every repeat request was a silent miss).
describe("withEdgeCache status header", () => {
  it("reports `unavailable` where there is no caches global (Node, tests)", async () => {
    const res = await withEdgeCache(
      new Request("https://x/blob/abc"),
      async () => new Response("bytes", { status: 200 }),
    )
    expect(res.headers.get(CACHE_STATUS_HEADER)).toBe("unavailable")
    expect(await res.text()).toBe("bytes")
  })

  it("passes the produced status and body through untouched", async () => {
    const res = await withEdgeCache(
      new Request("https://x/blob/missing"),
      async () => new Response("nope", { status: 404 }),
    )
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("nope")
  })
})
