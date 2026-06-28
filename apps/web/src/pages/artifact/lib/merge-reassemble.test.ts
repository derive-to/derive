import { describe, expect, it } from "vitest"
import type { MergeHunk } from "@/api"
import {
  allResolved,
  type Choice,
  conflictProgress,
  mergeSeparator,
  reassembleMerge,
} from "./merge-reassemble"

describe("mergeSeparator", () => {
  it("joins markdown blocks with nothing (block .raw carries its own separators)", () => {
    expect(mergeSeparator("md")).toBe("")
  })
  it("joins line-based kinds with a newline", () => {
    expect(mergeSeparator("html")).toBe("\n")
  })
})

describe("reassembleMerge", () => {
  const md: MergeHunk[] = [
    { t: "clean", text: "# Title\n\n" },
    { t: "conflict", base: "Old para\n", ours: "Live para\n", theirs: "My para\n" },
    { t: "clean", text: "\nThe end\n" },
  ]

  it("takes the current side (ours) for a markdown conflict", () => {
    const choices: Record<number, Choice> = { 1: { pick: "ours" } }
    expect(reassembleMerge(md, choices, "md")).toBe("# Title\n\nLive para\n\nThe end\n")
  })

  it("takes the editor's side (theirs)", () => {
    const choices: Record<number, Choice> = { 1: { pick: "theirs" } }
    expect(reassembleMerge(md, choices, "md")).toBe("# Title\n\nMy para\n\nThe end\n")
  })

  it("takes a hand-written reconciliation (edit)", () => {
    const choices: Record<number, Choice> = { 1: { pick: "edit", text: "Reconciled para\n" } }
    expect(reassembleMerge(md, choices, "md")).toBe("# Title\n\nReconciled para\n\nThe end\n")
  })

  it("joins line-based hunks with newlines", () => {
    const lines: MergeHunk[] = [
      { t: "clean", text: "line1" },
      { t: "conflict", base: "b", ours: "o", theirs: "t" },
      { t: "clean", text: "line4" },
    ]
    expect(reassembleMerge(lines, { 1: { pick: "theirs" } }, "html")).toBe("line1\nt\nline4")
  })

  it("resolves multiple conflicts independently", () => {
    const hunks: MergeHunk[] = [
      { t: "conflict", base: "b1", ours: "o1", theirs: "t1" },
      { t: "clean", text: "mid" },
      { t: "conflict", base: "b2", ours: "o2", theirs: "t2" },
    ]
    const choices: Record<number, Choice> = { 0: { pick: "ours" }, 2: { pick: "theirs" } }
    expect(reassembleMerge(hunks, choices, "html")).toBe("o1\nmid\nt2")
  })

  it("is the exact inverse of the kind's tokenize+join (line-based)", () => {
    // Core decomposes `allToks.join(sep)` into hunks; reassembling clean hunks with
    // the same sep must reproduce the document byte-for-byte.
    const doc = "a\nb\nc\nd"
    const hunks: MergeHunk[] = [
      { t: "clean", text: "a\nb" },
      { t: "clean", text: "c\nd" },
    ]
    expect(reassembleMerge(hunks, {}, "html")).toBe(doc)
  })

  it("is the exact inverse for markdown (empty separator)", () => {
    const doc = "# H\n\nPara\n"
    const hunks: MergeHunk[] = [
      { t: "clean", text: "# H\n\n" },
      { t: "clean", text: "Para\n" },
    ]
    expect(reassembleMerge(hunks, {}, "md")).toBe(doc)
  })

  it("throws if a conflict has no chosen resolution (publish is gated on this)", () => {
    expect(() => reassembleMerge(md, {}, "md")).toThrow(/unresolved conflict/)
  })

  it("preserves an empty side (a deletion) verbatim", () => {
    const hunks: MergeHunk[] = [
      { t: "clean", text: "keep\n" },
      { t: "conflict", base: "gone\n", ours: "", theirs: "stays\n" },
    ]
    expect(reassembleMerge(hunks, { 1: { pick: "ours" } }, "md")).toBe("keep\n")
  })
})

describe("conflictProgress / allResolved", () => {
  const hunks: MergeHunk[] = [
    { t: "clean", text: "x" },
    { t: "conflict", base: "b1", ours: "o1", theirs: "t1" },
    { t: "conflict", base: "b2", ours: "o2", theirs: "t2" },
  ]

  it("counts only conflict hunks, and how many are chosen", () => {
    expect(conflictProgress(hunks, {})).toEqual({ total: 2, resolved: 0 })
    expect(conflictProgress(hunks, { 1: { pick: "ours" } })).toEqual({ total: 2, resolved: 1 })
  })

  it("is resolved only when every conflict has a choice", () => {
    expect(allResolved(hunks, {})).toBe(false)
    expect(allResolved(hunks, { 1: { pick: "ours" } })).toBe(false)
    expect(allResolved(hunks, { 1: { pick: "ours" }, 2: { pick: "theirs" } })).toBe(true)
  })

  it("treats an all-clean hunk list as fully resolved", () => {
    expect(allResolved([{ t: "clean", text: "x" }], {})).toBe(true)
  })
})
