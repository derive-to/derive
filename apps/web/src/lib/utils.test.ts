import { describe, expect, it } from "vitest"
import { cn } from "./utils"

describe("cn", () => {
  it("joins class names", () => {
    expect(cn("a", "b")).toBe("a b")
  })

  it("drops falsy conditional classes", () => {
    expect(cn("a", false && "b", null, undefined, "c")).toBe("a c")
  })

  it("de-dupes conflicting Tailwind utilities (last wins)", () => {
    expect(cn("p-2", "p-4")).toBe("p-4")
    expect(cn("text-sm text-foreground", "text-lg")).toBe("text-foreground text-lg")
  })
})
