import { describe, expect, it } from "vitest"
import { rawTokenNeedsRefresh } from "./raw-token"

describe("rawTokenNeedsRefresh", () => {
  const now = Date.parse("2026-08-15T12:00:00.000Z")

  it("accepts a capability with useful life remaining", () => {
    expect(rawTokenNeedsRefresh("2026-08-15T12:01:00.000Z", now - 60_000, now)).toBe(false)
  })

  it("refreshes an expired or nearly-expired capability before mounting the iframe", () => {
    expect(rawTokenNeedsRefresh("2026-08-15T11:59:59.000Z", now, now)).toBe(true)
    expect(rawTokenNeedsRefresh("2026-08-15T12:00:10.000Z", now, now)).toBe(true)
  })

  it("accepts a freshly fetched legacy detail but refreshes an old cached one", () => {
    expect(rawTokenNeedsRefresh(undefined, now - 10_000, now)).toBe(false)
    expect(rawTokenNeedsRefresh(undefined, now - 31_000, now)).toBe(true)
  })
})
