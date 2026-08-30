import { describe, expect, it, vi } from "vitest"
import { SourceTextCache, WeightedLruCache } from "../src/lib/source-text-cache"

describe("WeightedLruCache", () => {
  it("deletes an entry without disturbing the remaining byte budget", () => {
    const cache = new WeightedLruCache<string>({ maxBytes: 8, maxEntryBytes: 8 })
    cache.set("a", "a", 4)
    cache.set("b", "b", 4)
    cache.delete("a")
    cache.set("c", "c", 4)

    expect(cache.get("a")).toBeUndefined()
    expect(cache.get("b")).toBe("b")
    expect(cache.get("c")).toBe("c")
  })
})

describe("SourceTextCache", () => {
  it("keeps hot entries alive with a sliding idle timeout", async () => {
    let now = 0
    const cache = new SourceTextCache({ idleTtlMs: 10, now: () => now })
    const load = vi.fn(async () => ({ text: "source", bytes: 6 }))

    expect(await cache.get("key", load)).toBe("source")
    now = 8
    expect(await cache.get("key", load)).toBe("source")
    now = 15
    expect(await cache.get("key", load)).toBe("source")
    expect(load).toHaveBeenCalledOnce()

    now = 26
    expect(await cache.get("key", load)).toBe("source")
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("evicts the least recently used entry when the byte limit is reached", async () => {
    const cache = new SourceTextCache({ maxBytes: 8, maxEntryBytes: 8 })
    const load = (text: string) => vi.fn(async () => ({ text, bytes: 4 }))
    const loadA = load("a")
    const loadB = load("b")
    const loadC = load("c")

    await cache.get("a", loadA)
    await cache.get("b", loadB)
    await cache.get("a", loadA)
    await cache.get("c", loadC)
    await cache.get("a", loadA)
    await cache.get("b", loadB)

    expect(loadA).toHaveBeenCalledOnce()
    expect(loadB).toHaveBeenCalledTimes(2)
    expect(loadC).toHaveBeenCalledOnce()
  })

  it("does not retain oversized or missing sources", async () => {
    const cache = new SourceTextCache({ maxBytes: 8, maxEntryBytes: 4 })
    const oversized = vi.fn(async () => ({ text: "large", bytes: 5 }))
    const missing = vi.fn(async () => null)

    await cache.get("large", oversized)
    await cache.get("large", oversized)
    await cache.get("missing", missing)
    await cache.get("missing", missing)

    expect(oversized).toHaveBeenCalledTimes(2)
    expect(missing).toHaveBeenCalledTimes(2)
  })

  it("shares one in-flight load between concurrent readers", async () => {
    let resolve: ((source: { text: string; bytes: number }) => void) | undefined
    const load = vi.fn(
      () =>
        new Promise<{ text: string; bytes: number }>((done) => {
          resolve = done
        }),
    )
    const cache = new SourceTextCache()

    const first = cache.get("key", load)
    const second = cache.get("key", load)
    resolve?.({ text: "source", bytes: 6 })

    await expect(first).resolves.toBe("source")
    await expect(second).resolves.toBe("source")
    expect(load).toHaveBeenCalledOnce()
  })
})
