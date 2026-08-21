import { describe, expect, it } from "vitest"
import { needsSeatConfirm, unitPrice } from "./billing-plans"

describe("needsSeatConfirm", () => {
  it("gates a fresh editor invite on a subscribed workspace", () => {
    expect(needsSeatConfirm({ subscribed: true }, "editor")).toBe(true)
  })

  it("lets a commenter invite through with no gate", () => {
    expect(needsSeatConfirm({ subscribed: true }, "commenter")).toBe(false)
  })

  it("never gates on an unsubscribed workspace", () => {
    expect(needsSeatConfirm({ subscribed: false }, "editor")).toBe(false)
  })

  it("never gates when billing is unknown (undefined)", () => {
    expect(needsSeatConfirm(undefined, "editor")).toBe(false)
  })

  it("gates promoting an existing commenter to editor", () => {
    expect(needsSeatConfirm({ subscribed: true }, "editor", "commenter")).toBe(true)
  })

  it("does not gate a re-role between the two billable roles", () => {
    expect(needsSeatConfirm({ subscribed: true }, "owner", "editor")).toBe(false)
  })

  it("does not gate demoting an editor to commenter", () => {
    expect(needsSeatConfirm({ subscribed: true }, "commenter", "editor")).toBe(false)
  })
})

describe("unitPrice", () => {
  it("treats a null interval (never billed yet) as monthly", () => {
    expect(unitPrice("team", null)).toBe(15)
  })
})
