import { afterEach, describe, expect, it, vi } from "vitest"
import { ago, until } from "./time"

// `ago` reads Date.now(), so pin the clock and feed ISO timestamps at known offsets.
const NOW = new Date("2026-06-14T12:00:00.000Z")
const offset = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

describe("ago", () => {
  afterEach(() => vi.useRealTimers())

  const at = (ms: number) => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    return ago(offset(ms))
  }

  it("renders each bucket", () => {
    expect(at(0)).toBe("just now")
    expect(at(30_000)).toBe("just now") // < 1m
    expect(at(5 * 60_000)).toBe("5m ago")
    expect(at(3 * 3600_000)).toBe("3h ago")
    expect(at(2 * 86400_000)).toBe("2d ago")
  })

  it("clamps a future timestamp to 'just now' (no negative)", () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(ago(new Date(NOW.getTime() + 60_000).toISOString())).toBe("just now")
  })
})

describe("until", () => {
  afterEach(() => vi.useRealTimers())

  const at = (ms: number) => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    return until(new Date(NOW.getTime() + ms).toISOString())
  }

  it("renders each bucket", () => {
    expect(at(30_000)).toBe("under a minute")
    expect(at(5 * 60_000)).toBe("5m")
    expect(at(3 * 3600_000)).toBe("3h")
    expect(at(2 * 86400_000)).toBe("2d")
  })

  it("clamps a past deadline to 'under a minute' (no negative)", () => {
    expect(at(-60_000)).toBe("under a minute")
  })
})
