import { describe, expect, it } from "vitest"
import { BLOCKED_COPY } from "./use-inline-edit"

describe("BLOCKED_COPY", () => {
  it("has a cross-boundary entry mentioning boundary", () => {
    expect(BLOCKED_COPY["cross-boundary"]).toBeDefined()
    expect(BLOCKED_COPY["cross-boundary"]).toContain("boundary")
  })

  it("cross-boundary message is a non-empty string", () => {
    expect(typeof BLOCKED_COPY["cross-boundary"]).toBe("string")
    expect((BLOCKED_COPY["cross-boundary"] as string).length).toBeGreaterThan(0)
  })
})
