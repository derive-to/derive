import { describe, expect, it } from "vitest"
import { reworkState } from "./rework-state"

// The Rework ⋯ item's four states (spec: set-up / connect / fire / picker).
describe("reworkState", () => {
  it("routes to setup when no Brandprint exists, regardless of agents", () => {
    expect(reworkState(false, 0)).toBe("setup")
    expect(reworkState(false, 3)).toBe("setup")
  })

  it("routes to connect when a Brandprint exists but no agent is registered", () => {
    expect(reworkState(true, 0)).toBe("connect")
  })

  it("fires with a sole agent; picks among several", () => {
    expect(reworkState(true, 1)).toBe("fire")
    expect(reworkState(true, 2)).toBe("picker")
  })
})
