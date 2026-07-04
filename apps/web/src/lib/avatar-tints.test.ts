import { describe, expect, it } from "vitest"
import { colorForName } from "./avatar-tints"

describe("colorForName", () => {
  it("is deterministic — the same name always maps to the same tint", () => {
    expect(colorForName("Alice Smith")).toBe(colorForName("Alice Smith"))
  })
  it("returns one of the allow-listed hex tints", () => {
    expect(colorForName("Alice")).toMatch(/^#[0-9a-f]{6}$/)
  })
  it("spreads different names across more than one tint", () => {
    const names = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Heidi"]
    expect(new Set(names.map(colorForName)).size).toBeGreaterThan(1)
  })
  it("handles an empty string without throwing", () => {
    expect(colorForName("")).toMatch(/^#[0-9a-f]{6}$/)
  })
})
