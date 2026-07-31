import { describe, expect, it } from "vitest"
import { withEdgeCache } from "../src/lib/edge-cache"

/**
 * The edge cache is keyed on the URL ALONE, so the rules about what may enter it are safety
 * rules, not tuning. A response that varies by caller must never be stored, and a failure must
 * never become sticky for a year.
 *
 * `caches` is a Workers global that does not exist under Node, so these install a fake for the
 * duration of a test — which also pins the Node behaviour (no cache, just call through).
 */

type Entry = { req: Request; res: Response }

const withFakeCache = async <T>(run: (store: Entry[]) => Promise<T>): Promise<T> => {
  const store: Entry[] = []
  const g = globalThis as { caches?: unknown }
  const had = "caches" in g
  const prev = g.caches
  g.caches = {
    default: {
      match: async (req: Request) =>
        store.find((e) => e.req.url === req.url)?.res.clone() ?? undefined,
      put: async (req: Request, res: Response) => {
        store.push({ req, res })
      },
    },
  }
  try {
    return await run(store)
  } finally {
    if (had) g.caches = prev
    else delete g.caches
  }
}

const req = (url = "https://x.test/blob/abc", init?: RequestInit) => new Request(url, init)

describe("edge cache", () => {
  it("calls through and stores a 200", async () => {
    await withFakeCache(async (store) => {
      let built = 0
      const produce = async () => {
        built += 1
        return new Response("bytes", { status: 200 })
      }
      const res = await withEdgeCache(req(), produce)
      expect(await res.text()).toBe("bytes") // the CALLER still gets a readable body
      expect(built).toBe(1)
      expect(store).toHaveLength(1)
    })
  })

  it("serves the second hit from the cache without rebuilding", async () => {
    await withFakeCache(async () => {
      let built = 0
      const produce = async () => {
        built += 1
        return new Response("bytes", { status: 200 })
      }
      await withEdgeCache(req(), produce)
      const second = await withEdgeCache(req(), produce)
      expect(built).toBe(1) // no database row, no R2 object, no origin work at all
      expect(await second.text()).toBe("bytes")
    })
  })

  it("keys on the URL, so a different hash is a different entry", async () => {
    await withFakeCache(async () => {
      let built = 0
      const produce = async () => {
        built += 1
        return new Response("bytes", { status: 200 })
      }
      await withEdgeCache(req("https://x.test/blob/aaa"), produce)
      await withEdgeCache(req("https://x.test/blob/bbb"), produce)
      expect(built).toBe(2)
    })
  })

  it("NEVER caches a 404 — a missing asset must not be sticky for a year", async () => {
    await withFakeCache(async (store) => {
      let built = 0
      const produce = async () => {
        built += 1
        return new Response("not found", { status: 404 })
      }
      await withEdgeCache(req(), produce)
      await withEdgeCache(req(), produce)
      expect(store).toHaveLength(0)
      expect(built).toBe(2) // asked again, so an asset that appears later is servable
    })
  })

  it("never caches a 5xx either", async () => {
    await withFakeCache(async (store) => {
      await withEdgeCache(req(), async () => new Response("blob missing", { status: 500 }))
      expect(store).toHaveLength(0)
    })
  })

  it("does not touch the cache for a non-GET request", async () => {
    await withFakeCache(async (store) => {
      const res = await withEdgeCache(
        req("https://x.test/blob/abc", { method: "POST" }),
        async () => new Response("ok", { status: 200 }),
      )
      expect(await res.text()).toBe("ok")
      expect(store).toHaveLength(0)
    })
  })

  it("falls back to producing when a cache read throws", async () => {
    const g = globalThis as { caches?: unknown }
    const had = "caches" in g
    const prev = g.caches
    g.caches = {
      default: {
        match: async () => {
          throw new Error("cache unavailable")
        },
        put: async () => {},
      },
    }
    try {
      const res = await withEdgeCache(req(), async () => new Response("bytes", { status: 200 }))
      expect(await res.text()).toBe("bytes")
    } finally {
      if (had) g.caches = prev
      else delete g.caches
    }
  })

  it("is a plain call-through on Node, where there is no edge at all", async () => {
    const g = globalThis as { caches?: unknown }
    const had = "caches" in g
    const prev = g.caches
    delete g.caches
    try {
      let built = 0
      const produce = async () => {
        built += 1
        return new Response("bytes", { status: 200 })
      }
      await withEdgeCache(req(), produce)
      await withEdgeCache(req(), produce)
      expect(built).toBe(2) // no caching, and crucially no crash on the missing global
    } finally {
      if (had) g.caches = prev
    }
  })
})
