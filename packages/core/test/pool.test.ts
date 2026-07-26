import { describe, expect, it } from "vitest"
import { mapPool, mapPoolSettled } from "../src/pool"

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe("mapPoolSettled", () => {
  it("runs every item and never exceeds the concurrency limit", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i)
    const seen: number[] = []
    let inFlight = 0
    let peak = 0
    await mapPoolSettled(items, 4, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await tick()
      seen.push(n)
      inFlight--
    })
    expect(seen.sort((a, b) => a - b)).toEqual(items)
    expect(peak).toBeLessThanOrEqual(4) // bounded
    expect(peak).toBeGreaterThan(1) // and actually concurrent
  })

  it("swallows rejections so one bad item doesn't abort the rest", async () => {
    const done: number[] = []
    await expect(
      mapPoolSettled([1, 2, 3, 4], 2, async (n) => {
        if (n === 2) throw new Error("boom")
        done.push(n)
      }),
    ).resolves.toBeUndefined()
    expect(done.sort((a, b) => a - b)).toEqual([1, 3, 4])
  })

  it("handles an empty list", async () => {
    await expect(mapPoolSettled([], 8, async () => {})).resolves.toBeUndefined()
  })
})

describe("mapPool", () => {
  it("collects results in order with bounded concurrency", async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await tick()
      inFlight--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50])
    expect(peak).toBeLessThanOrEqual(2)
  })

  it("rejects on the first error", async () => {
    await expect(
      mapPool([1, 2, 3], 3, async (n) => {
        if (n === 2) throw new Error("nope")
        return n
      }),
    ).rejects.toThrow("nope")
  })
})
