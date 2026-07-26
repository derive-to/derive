import { describe, expect, it } from "vitest"
import { mapPool, mapPoolSettled } from "./pool"

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// A fn instrumented to record peak concurrency: bump a counter on entry, hold for a
// tick so workers actually overlap, then drop it. `peak` is the max ever in flight.
function concurrencyProbe() {
  let inFlight = 0
  let peak = 0
  const run = async () => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await delay(5)
    inFlight--
  }
  return {
    run,
    get peak() {
      return peak
    },
  }
}

describe("mapPool", () => {
  it("collects results in input order regardless of completion order", async () => {
    // Earlier items finish LAST (longer delay), yet results stay positional.
    const out = await mapPool([0, 1, 2, 3, 4], 5, async (n) => {
      await delay((5 - n) * 4)
      return n * 10
    })
    expect(out).toEqual([0, 10, 20, 30, 40])
  })

  it("runs every item exactly once, with the right index", async () => {
    const seen: Array<[unknown, number]> = []
    await mapPool(["a", "b", "c", "d"], 2, async (item, i) => {
      seen.push([item, i])
    })
    expect(seen.sort((x, y) => x[1] - y[1])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
    ])
  })

  it("never exceeds the concurrency limit, and uses it fully", async () => {
    const probe = concurrencyProbe()
    await mapPool(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      probe.run,
    )
    // 12 items, limit 3 -> at most 3 in flight, and it should saturate to exactly 3.
    expect(probe.peak).toBe(3)
  })

  it("caps in-flight at the item count when the limit exceeds it", async () => {
    const probe = concurrencyProbe()
    await mapPool([1, 2], 10, probe.run)
    expect(probe.peak).toBe(2)
  })

  it("clamps a zero/negative limit to a single worker", async () => {
    const probe = concurrencyProbe()
    const out = await mapPool([1, 2, 3], 0, async (n) => {
      await probe.run()
      return n
    })
    expect(probe.peak).toBe(1) // serialized, never zero workers (which would hang)
    expect(out).toEqual([1, 2, 3])
  })

  it("returns [] for empty input without calling fn", async () => {
    let calls = 0
    const out = await mapPool([], 4, async () => {
      calls++
    })
    expect(out).toEqual([])
    expect(calls).toBe(0)
  })

  it("rejects on the first error", async () => {
    await expect(
      mapPool([1, 2, 3, 4], 2, async (n) => {
        if (n === 3) throw new Error("boom")
        return n
      }),
    ).rejects.toThrow("boom")
  })
})

describe("mapPoolSettled", () => {
  it("processes every item even when some reject, and resolves to void", async () => {
    const processed: number[] = []
    const result = await mapPoolSettled([1, 2, 3, 4, 5], 2, async (n) => {
      processed.push(n)
      if (n % 2 === 0) throw new Error(`fail ${n}`)
    })
    expect(result).toBeUndefined()
    expect(processed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it("honors the concurrency limit", async () => {
    const probe = concurrencyProbe()
    await mapPoolSettled(
      Array.from({ length: 9 }, (_, i) => i),
      4,
      probe.run,
    )
    expect(probe.peak).toBe(4)
  })
})
