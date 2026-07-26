import { describe, expect, it } from "vitest"
import { type DiffOp, diffLines, formatDiff } from "./diff"

// The defining property of a correct line diff: dropping the additions and
// rejoining recovers the OLD text exactly; dropping the deletions recovers the NEW
// text. (ctx lines belong to both, add only to new, del only to old.)
const oldFrom = (ops: DiffOp[]) =>
  ops
    .filter((o) => o.t !== "add")
    .map((o) => o.line)
    .join("\n")
const newFrom = (ops: DiffOp[]) =>
  ops
    .filter((o) => o.t !== "del")
    .map((o) => o.line)
    .join("\n")

describe("diffLines — reconstruction invariant", () => {
  const cases: [string, string][] = [
    ["", ""],
    ["", "a\nb"],
    ["a\nb", ""],
    ["same\ntext", "same\ntext"],
    ["1\n2\n3", "1\n3"], // a deletion in the middle
    ["1\n3", "1\n2\n3"], // an insertion in the middle
    ["x", "y"], // a full one-line replace
    ["a\nb\nc", "c\nb\na"], // a reorder
    ["alpha\nbeta\ngamma", "alpha\nBETA\ngamma\ndelta"], // change + append
    ["the\nquick\nbrown\nfox", "the\nslow\nbrown\ncat"], // two scattered changes
  ]

  it.each(cases)("rebuilds both sides for %j -> %j", (a, b) => {
    const ops = diffLines(a, b)
    expect(oldFrom(ops)).toBe(a)
    expect(newFrom(ops)).toBe(b)
  })
})

describe("diffLines — shape of the result", () => {
  it("marks identical text entirely as context, one op per line", () => {
    const ops = diffLines("one\ntwo\nthree", "one\ntwo\nthree")
    expect(ops).toEqual([
      { t: "ctx", line: "one" },
      { t: "ctx", line: "two" },
      { t: "ctx", line: "three" },
    ])
  })

  it("keeps the surrounding lines as context around a single edit", () => {
    expect(diffLines("1\n2\n3", "1\n3")).toEqual([
      { t: "ctx", line: "1" },
      { t: "del", line: "2" },
      { t: "ctx", line: "3" },
    ])
  })

  it("maximizes context: the number of ctx ops equals the LCS length", () => {
    // LCS of (1,2,3,4) and (1,3,4,5) is (1,3,4) -> 3 context lines.
    const ops = diffLines("1\n2\n3\n4", "1\n3\n4\n5")
    expect(ops.filter((o) => o.t === "ctx").map((o) => o.line)).toEqual(["1", "3", "4"])
  })

  it("emits deletions before additions on a changed line (stable tie-break)", () => {
    expect(diffLines("x", "y")).toEqual([
      { t: "del", line: "x" },
      { t: "add", line: "y" },
    ])
  })

  it("treats a pure append as context + additions, never deletions", () => {
    const ops = diffLines("intro", "intro\nbody\noutro")
    expect(ops.some((o) => o.t === "del")).toBe(false)
    expect(ops.filter((o) => o.t === "add").map((o) => o.line)).toEqual(["body", "outro"])
  })
})

describe("formatDiff", () => {
  it("prefixes each op: two spaces for context, + for add, - for del", () => {
    const ops: DiffOp[] = [
      { t: "ctx", line: "kept" },
      { t: "del", line: "gone" },
      { t: "add", line: "new" },
    ]
    expect(formatDiff(ops)).toBe("  kept\n- gone\n+ new")
  })

  it("renders an empty diff as an empty string", () => {
    expect(formatDiff([])).toBe("")
  })

  it("round-trips through diffLines into a readable unified diff", () => {
    expect(formatDiff(diffLines("a\nb\nc", "a\nB\nc"))).toBe("  a\n- b\n+ B\n  c")
  })
})
