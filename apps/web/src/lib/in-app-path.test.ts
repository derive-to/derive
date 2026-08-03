import { describe, expect, it } from "vitest"
import { isInAppPath } from "./in-app-path"

describe("in-app paths", () => {
  it("accepts root-relative paths, with query and fragment", () => {
    expect(isInAppPath("/")).toBe(true)
    expect(isInAppPath("/settings/members")).toBe(true)
    expect(isInAppPath("/artifacts/ab12cd34")).toBe(true)
    expect(isInAppPath("/search?q=refunds")).toBe(true)
    expect(isInAppPath("/artifacts/ab12cd34#risks")).toBe(true)
  })

  it("refuses the paths that LOOK root-relative and leave the origin", () => {
    // The whole point: these pass `startsWith("/")`, which is what the app used to check.
    expect(isInAppPath("//evil.com")).toBe(false)
    expect(isInAppPath("//evil.com/settings/members")).toBe(false)
    // Browsers normalise the backslash, so this reaches the same place.
    expect(isInAppPath("/\\evil.com")).toBe(false)
  })

  it("refuses anything with a scheme, and anything absent", () => {
    expect(isInAppPath("https://evil.com")).toBe(false)
    expect(isInAppPath("javascript:alert(1)")).toBe(false)
    expect(isInAppPath("mailto:a@b.com")).toBe(false)
    expect(isInAppPath("settings/members")).toBe(false)
    expect(isInAppPath("")).toBe(false)
    expect(isInAppPath(null)).toBe(false)
    expect(isInAppPath(undefined)).toBe(false)
  })
})
