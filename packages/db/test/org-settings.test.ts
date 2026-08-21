import { describe, expect, it } from "vitest"
import { parseOrgSettings } from "../src/repos"

describe("parseOrgSettings", () => {
  it("an engaged stop survives its retired key — a pinned killswitch reads as writes-off", () => {
    // Nothing may release a stop an operator set except the operator flipping the switch.
    expect(parseOrgSettings(JSON.stringify({ agentKillswitch: true })).agentWrites).toBe(false)
    // Off (or absent) engages nothing — the default is writes on.
    expect(parseOrgSettings(JSON.stringify({ agentKillswitch: false })).agentWrites).toBe(true)
    expect(parseOrgSettings(null).agentWrites).toBe(true)
    // An explicit modern value always wins, whatever the retired keys say.
    expect(
      parseOrgSettings(JSON.stringify({ agentKillswitch: true, agentWrites: true })).agentWrites,
    ).toBe(true)
    // The retired keys themselves never surface.
    expect(parseOrgSettings(JSON.stringify({ agentKillswitch: true }))).not.toHaveProperty(
      "agentKillswitch",
    )
  })
})
