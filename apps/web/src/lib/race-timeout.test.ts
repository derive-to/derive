import { afterEach, describe, expect, it, vi } from "vitest"
import { raceTimeout } from "./race-timeout"
import { reportVital } from "./vitals"

vi.mock("./vitals", () => ({
  reportVital: vi.fn(),
  reportWebVitals: vi.fn(),
}))

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("raceTimeout", () => {
  it("passes the value through when the promise resolves before the timeout", async () => {
    await expect(raceTimeout(Promise.resolve("warm"), 1000, "cold")).resolves.toBe("warm")
    expect(reportVital).not.toHaveBeenCalled()
  })

  it("falls back when the promise never settles", async () => {
    vi.useFakeTimers()
    const hang = new Promise<string>(() => {})
    const pending = raceTimeout(hang, 50, "cold", "cache-restore-timeout")
    await vi.advanceTimersByTimeAsync(50)
    await expect(pending).resolves.toBe("cold")
  })

  it("logs a vital on timeout when a name is provided", async () => {
    vi.useFakeTimers()
    const hang = new Promise<string>(() => {})
    const pending = raceTimeout(hang, 30, "cold", "cache-restore-timeout")
    await vi.advanceTimersByTimeAsync(30)
    await pending
    expect(reportVital).toHaveBeenCalledWith("cache-restore-timeout", 30, "poor")
  })

  it("does not log a vital when the promise wins the race", async () => {
    await raceTimeout(Promise.resolve(1), 500, 0, "cache-restore-timeout")
    expect(reportVital).not.toHaveBeenCalled()
  })

  it("propagates a rejection that arrives before the timeout", async () => {
    await expect(raceTimeout(Promise.reject(new Error("boom")), 1000, "cold")).rejects.toThrow(
      "boom",
    )
  })
})
