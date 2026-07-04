import { describe, expect, it } from "vitest"
import { ALL_EVENTS } from "./webhook-events"

describe("webhook events", () => {
  it("exposes the subscribable event set", () => {
    expect(ALL_EVENTS).toContain("version.published")
    expect(ALL_EVENTS).toHaveLength(3)
  })
})
