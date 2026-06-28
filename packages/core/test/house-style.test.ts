import { describe, expect, it } from "vitest"
import { houseStyleInstructions, parseHouseStyle, resolveHouseStyle } from "../src/house-style"

describe("resolveHouseStyle", () => {
  it("collects collection ids workspace-first, profile appended, deduped", () => {
    expect(resolveHouseStyle({ collectionId: "ws" }, { collectionId: "me" }).collectionIds).toEqual(
      ["ws", "me"],
    )
    expect(resolveHouseStyle({ collectionId: "x" }, { collectionId: "x" }).collectionIds).toEqual([
      "x",
    ])
    expect(resolveHouseStyle(undefined, { collectionId: "me" }).collectionIds).toEqual(["me"])
    expect(resolveHouseStyle({}, {}).collectionIds).toEqual([])
  })

  it("merges theme tokens with the profile overriding the workspace per key", () => {
    const ws = {
      theme: { palette: { ink: "#111", accent: "#a00" }, fonts: { body: "Inter" } },
    }
    const profile = {
      theme: { palette: { accent: "#00b" }, dark: { palette: { paper: "#000" } } },
    }
    const { theme } = resolveHouseStyle(ws, profile)
    expect(theme).toEqual({
      palette: { ink: "#111", accent: "#00b" }, // profile accent wins, ws ink kept
      fonts: { body: "Inter" },
      dark: { palette: { paper: "#000" } },
    })
  })

  it("returns no theme when neither layer sets one", () => {
    expect(resolveHouseStyle({ collectionId: "ws" }, undefined).theme).toBeUndefined()
  })
})

describe("parseHouseStyle", () => {
  it("parses a JSON object, and returns undefined for null/garbage", () => {
    expect(parseHouseStyle('{"collectionId":"abc"}')).toEqual({ collectionId: "abc" })
    expect(parseHouseStyle(null)).toBeUndefined()
    expect(parseHouseStyle("")).toBeUndefined()
    expect(parseHouseStyle("not json")).toBeUndefined()
    expect(parseHouseStyle("42")).toBeUndefined()
  })
})

describe("houseStyleInstructions", () => {
  it("is empty with no docs and pluralizes otherwise", () => {
    expect(houseStyleInstructions(0)).toBe("")
    expect(houseStyleInstructions(1)).toContain("1 convention doc ")
    expect(houseStyleInstructions(2)).toContain("2 convention docs ")
    expect(houseStyleInstructions(2)).toContain("dock://house-style/*")
  })
})
