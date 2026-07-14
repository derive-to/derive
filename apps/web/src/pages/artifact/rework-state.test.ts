import { describe, expect, it } from "vitest"
import { resolveRework } from "./rework-state"

// The Rework ⋯ item's four states (set-up / connect / fire / picker).
describe("resolveRework", () => {
  const a = { id: "ag_1", name: "Reviser" }
  const b = { id: "ag_2", name: "Stylist" }

  it("routes to setup when no Brandprint exists, regardless of agents", () => {
    expect(resolveRework(false, [])).toEqual({ state: "setup" })
    expect(resolveRework(false, [a, b])).toEqual({ state: "setup" })
  })

  it("routes to connect when a Brandprint exists but no agent is registered", () => {
    expect(resolveRework(true, [])).toEqual({ state: "connect" })
  })

  it("fires with a sole agent, carrying it; picks among several", () => {
    expect(resolveRework(true, [a])).toEqual({ state: "fire", agent: a })
    expect(resolveRework(true, [a, b])).toEqual({ state: "picker", agents: [a, b] })
  })
})
