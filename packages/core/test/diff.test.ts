import { describe, expect, it } from "vitest"
import { diffLines, formatDiff } from "../src/diff"

describe("diffLines", () => {
  it("marks context, deletions, and additions", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
      { t: "ctx", line: "a" },
      { t: "del", line: "b" },
      { t: "add", line: "x" },
      { t: "ctx", line: "c" },
    ])
  })

  it("handles pure additions and removals", () => {
    expect(diffLines("a", "a\nb").filter((o) => o.t === "add")).toEqual([{ t: "add", line: "b" }])
    expect(diffLines("a\nb", "a").filter((o) => o.t === "del")).toEqual([{ t: "del", line: "b" }])
  })

  it("formats a unified-style text diff", () => {
    expect(formatDiff(diffLines("x\ny", "x\nz"))).toBe("  x\n- y\n+ z")
  })
})
