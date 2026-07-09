import { describe, expect, it } from "vitest"
import { brandprintInstructions, parseBrandprint, resolveBrandprint } from "../src/brandprint"

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

  it("merges theme tokens with the profile overriding the workspace per key", () => {
    const ws = {
      theme: { palette: { ink: "#111", accent: "#a00" }, fonts: { body: "Inter" } },
    }
    const profile = {
      theme: { palette: { accent: "#00b" }, dark: { palette: { paper: "#000" } } },
    }
    const { theme } = resolveBrandprint(ws, profile)
    expect(theme).toEqual({
      palette: { ink: "#111", accent: "#00b" }, // profile accent wins, ws ink kept
      fonts: { body: "Inter" },
      dark: { palette: { paper: "#000" } },
    })
  })

  it("returns no theme when neither layer sets one", () => {
    expect(resolveBrandprint({ collectionId: "ws" }, undefined).theme).toBeUndefined()
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
})
