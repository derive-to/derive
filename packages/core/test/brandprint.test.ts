import { describe, expect, it } from "vitest"
import {
  brandprintInstructions,
  buildProfileInstruction,
  parseBrandprint,
  pendingRequestsPointer,
  profileState,
  resolveBrandprint,
  reworkInstruction,
} from "../src/brandprint"

describe("profileState", () => {
  it("is pending on the intake stub (v1) and live from v2", () => {
    expect(profileState(1)).toBe("pending")
    expect(profileState(2)).toBe("live")
    expect(profileState(5)).toBe("live")
  })
})

describe("resolveBrandprint", () => {
  it("collects collection ids workspace-first, profile appended, deduped", () => {
    expect(resolveBrandprint({ collectionId: "ws" }, { collectionId: "me" }).collectionIds).toEqual(
      ["ws", "me"],
    )
    expect(resolveBrandprint({ collectionId: "x" }, { collectionId: "x" }).collectionIds).toEqual([
      "x",
    ])
    expect(resolveBrandprint(undefined, { collectionId: "me" }).collectionIds).toEqual(["me"])
    expect(resolveBrandprint({}, {}).collectionIds).toEqual([])
  })

  it("carries the workspace profileId and ignores a personal one", () => {
    expect(
      resolveBrandprint(
        { collectionId: "c1", profileId: "p1" },
        { collectionId: "c2", profileId: "nope" },
      ),
    ).toEqual({ collectionIds: ["c1", "c2"], profileId: "p1" })
    expect(
      resolveBrandprint({ collectionId: "c1" }, { profileId: "nope" }).profileId,
    ).toBeUndefined()
  })
})

describe("parseBrandprint", () => {
  it("parses a JSON object, and returns undefined for null/garbage", () => {
    expect(parseBrandprint('{"collectionId":"abc"}')).toEqual({ collectionId: "abc" })
    expect(parseBrandprint(null)).toBeUndefined()
    expect(parseBrandprint("")).toBeUndefined()
    expect(parseBrandprint("not json")).toBeUndefined()
    expect(parseBrandprint("42")).toBeUndefined()
  })
})

describe("brandprintInstructions", () => {
  it("is empty with no docs and pluralizes otherwise", () => {
    expect(brandprintInstructions(0)).toBe("")
    expect(brandprintInstructions(1)).toContain("1 convention doc ")
    expect(brandprintInstructions(2)).toContain("2 convention docs ")
    expect(brandprintInstructions(2)).toContain("derive://brandprint/*")
  })

  it("live profile points at derive://brandprint/profile", () => {
    const s = brandprintInstructions(3, { state: "live", shortId: "abc123" })
    expect(s).toContain("derive://brandprint/profile")
    expect(s).toContain("personal Brandprint takes precedence")
    expect(s).toContain("3 source docs")
  })

  it("pending profile is factual and user-conditioned, never solicits", () => {
    const s = brandprintInstructions(2, { state: "pending", shortId: "abc123" })
    expect(s).toContain("If the user asks")
    expect(s).toContain("for_review")
    expect(s).toContain("abc123")
    expect(s).toContain("derive://brandprint/reference")
    expect(s.toLowerCase()).not.toContain("offer")
  })
})

describe("reworkInstruction", () => {
  it("points at the brandprint resources and asks for a new version", () => {
    const s = reworkInstruction(false)
    expect(s).toContain("derive://brandprint/*")
    expect(s).toContain("Preserve the meaning and the facts")
    expect(s).toContain("Publish the result as a new version.")
    expect(s).not.toContain("derive://brandprint/profile")
  })

  it("names the live profile as the first read", () => {
    const s = reworkInstruction(true)
    expect(s).toContain("Read derive://brandprint/profile first")
    expect(s).toContain("derive://brandprint/*")
  })
})

describe("buildProfileInstruction", () => {
  it("names the reference, the template, the sources, and the review-gated target", () => {
    const s = buildProfileInstruction("czwrd32q")
    expect(s).toContain("derive://brandprint/reference")
    expect(s).toContain("derive://brandprint/template")
    expect(s).toContain("derive://brandprint/*")
    expect(s).toContain("for_review: true")
    expect(s).toContain("artifact czwrd32q")
  })
})

describe("pendingRequestsPointer", () => {
  it("is empty with nothing queued, and steers to check_requests when work waits", () => {
    expect(pendingRequestsPointer(0)).toBe("")
    expect(pendingRequestsPointer(1)).toContain("1 pending request:")
    expect(pendingRequestsPointer(2)).toContain("2 pending requests:")
    expect(pendingRequestsPointer(1)).toContain("check_requests")
  })
})
