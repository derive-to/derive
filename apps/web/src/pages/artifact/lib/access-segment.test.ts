import { describe, expect, it } from "vitest"
import {
  accessSegmentNeedsConfirm,
  accessSegmentOf,
  accessSegmentToast,
  decideAccessSegmentChange,
  draftForAccessSegment,
} from "./access-segment"

// Share-dialog "WHO CAN OPEN THIS" decisions. The confirm gate only fires when
// widening to Anyone — accidental public exposure is the bug (BUG-16). Toast copy
// names the new reach so a silent apply can't happen again.

describe("accessSegmentOf", () => {
  it("projects the triple onto the widest reach", () => {
    expect(accessSegmentOf("viewer", "none")).toBe("anyone")
    expect(accessSegmentOf("none", "member")).toBe("workspace")
    expect(accessSegmentOf("none", "none")).toBe("invite")
    // world link outranks workspace seat
    expect(accessSegmentOf("editor", "member")).toBe("anyone")
  })
})

describe("accessSegmentNeedsConfirm", () => {
  it("confirms only when widening TO anyone", () => {
    expect(accessSegmentNeedsConfirm("invite", "anyone")).toBe(true)
    expect(accessSegmentNeedsConfirm("workspace", "anyone")).toBe(true)
  })
  it("stays one-click for narrowing and non-anyone moves", () => {
    expect(accessSegmentNeedsConfirm("anyone", "invite")).toBe(false)
    expect(accessSegmentNeedsConfirm("anyone", "workspace")).toBe(false)
    expect(accessSegmentNeedsConfirm("invite", "workspace")).toBe(false)
    expect(accessSegmentNeedsConfirm("workspace", "invite")).toBe(false)
    expect(accessSegmentNeedsConfirm("anyone", "anyone")).toBe(false)
  })
})

describe("accessSegmentToast", () => {
  it("names the new reach in plain language", () => {
    expect(accessSegmentToast("anyone")).toBe("Anyone with the link can now open this")
    expect(accessSegmentToast("workspace")).toBe("Everyone in the workspace can now open this")
    expect(accessSegmentToast("invite")).toBe("Only people you've added can open this")
  })
})

describe("decideAccessSegmentChange", () => {
  it("pairs the confirm gate with the landing toast", () => {
    expect(decideAccessSegmentChange("invite", "anyone")).toEqual({
      needsConfirm: true,
      toast: "Anyone with the link can now open this",
    })
    expect(decideAccessSegmentChange("anyone", "invite")).toEqual({
      needsConfirm: false,
      toast: "Only people you've added can open this",
    })
    expect(decideAccessSegmentChange("invite", "workspace")).toEqual({
      needsConfirm: false,
      toast: "Everyone in the workspace can now open this",
    })
  })
})

describe("draftForAccessSegment", () => {
  it("invite clears every general-access field", () => {
    expect(draftForAccessSegment("invite", "editor", "public")).toEqual({
      workspaceAccess: "none",
      linkRole: "none",
      listed: "none",
    })
  })
  it("workspace keeps an existing workspace listing, drops the world link", () => {
    expect(draftForAccessSegment("workspace", "viewer", "workspace")).toEqual({
      workspaceAccess: "member",
      linkRole: "none",
      listed: "workspace",
    })
    expect(draftForAccessSegment("workspace", "viewer", "public")).toEqual({
      workspaceAccess: "member",
      linkRole: "none",
      listed: "none",
    })
  })
  it("anyone defaults the world link to viewer and keeps a public listing", () => {
    expect(draftForAccessSegment("anyone", "none", "none")).toEqual({
      workspaceAccess: "member",
      linkRole: "viewer",
      listed: "none",
    })
    expect(draftForAccessSegment("anyone", "commenter", "public")).toEqual({
      workspaceAccess: "member",
      linkRole: "commenter",
      listed: "public",
    })
  })
})
