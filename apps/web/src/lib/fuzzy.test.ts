import { describe, expect, it } from "vitest"
import { fuzzyTitles } from "./fuzzy"

const row = (short_id: string, title: string, updated_at = "2026-01-01") => ({
  short_id,
  title,
  updated_at,
})

describe("fuzzyTitles", () => {
  it("empty query returns newest-first recents", () => {
    const rows = [row("a", "Old", "2026-01-01"), row("b", "New", "2026-06-01")]
    expect(fuzzyTitles(rows, "").map((r) => r.short_id)).toEqual(["b", "a"])
  })

  it("ranks prefix over word-boundary over substring over subsequence", () => {
    const rows = [
      row("sub", "Superfast pipeline"),
      row("word", "Derive perf register"),
      row("prefix", "Perf handoff"),
      row("subseq", "populate every ranked feed"),
    ]
    expect(fuzzyTitles(rows, "perf").map((r) => r.short_id)).toEqual([
      "prefix",
      "word",
      "sub",
      "subseq",
    ])
  })

  it("drops non-matches and dedupes by short_id", () => {
    const rows = [row("a", "Alpha"), row("a", "Alpha"), row("b", "Beta")]
    expect(fuzzyTitles(rows, "alp").map((r) => r.short_id)).toEqual(["a"])
  })

  it("caps at the limit", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(String(i), `Doc ${i}`))
    expect(fuzzyTitles(rows, "doc", 8)).toHaveLength(8)
  })

  it("matches case-insensitively", () => {
    expect(fuzzyTitles([row("a", "HANDOFF")], "hand")).toHaveLength(1)
  })
})
