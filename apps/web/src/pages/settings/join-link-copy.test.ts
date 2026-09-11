import { describe, expect, it } from "vitest"
import {
  joinLinkActiveLine,
  joinLinkConfirmDescription,
  joinLinkConfirmTitle,
  joinLinkSeatLine,
} from "./join-link-copy"

const free = { tier: "free" as const, interval: null, subscribed: false, beta: false }
const team = { tier: "team" as const, interval: "month" as const, subscribed: true, beta: false }
const teamAnnual = {
  tier: "team" as const,
  interval: "year" as const,
  subscribed: true,
  beta: false,
}
const business = {
  tier: "business" as const,
  interval: "month" as const,
  subscribed: true,
  beta: false,
}
const beta = { ...free, beta: true }

describe("join link copy", () => {
  it("tells a free workspace that a 4th Creator moves everyone onto Team billing", () => {
    expect(joinLinkSeatLine(free, "editor")).toBe(
      "Free covers 3 Creators. A 4th moves you to Team, where every Creator and Admin is $15/mo.",
    )
  })
  it("tells a Team workspace that every Creator and Admin already bills", () => {
    expect(joinLinkSeatLine(team, "editor")).toBe(
      "Every Creator and Admin is $15/mo. Each join adds one.",
    )
  })
  it("prices from the plan, so Business and annual read correctly", () => {
    expect(joinLinkSeatLine(business, "editor")).toContain("$30/mo")
    expect(joinLinkSeatLine(teamAnnual, "editor")).toContain("$12/mo")
  })
  it("says billing is off on a beta instance", () => {
    expect(joinLinkSeatLine(beta, "editor")).toBe(
      "Billing is off on this instance, so Creators stay free.",
    )
  })
  it("has no seat line for a Viewer link", () => {
    expect(joinLinkSeatLine(team, "commenter")).toBeNull()
    expect(joinLinkSeatLine(free, "commenter")).toBeNull()
  })
  it("keeps the live-link line and the confirm dialog on the same price", () => {
    expect(joinLinkActiveLine(team)).toBe("Each join adds a Creator at $15/mo.")
    expect(joinLinkConfirmTitle).toBe("Create a Creator link?")
    expect(joinLinkConfirmDescription(team, "Acme")).toBe(
      "Everyone who joins becomes a Creator and adds $15/mo to Acme's bill. Revoke the link any time.",
    )
  })
  it("falls back to the Team monthly price when billing is unknown", () => {
    expect(joinLinkSeatLine(undefined, "editor")).toContain("$15/mo")
    expect(joinLinkActiveLine(undefined)).toBe("Each join adds a Creator at $15/mo.")
  })
})
