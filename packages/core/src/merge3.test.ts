import { describe, expect, it } from "vitest"
import { merge3, mergeKindFor } from "./merge3"

const lines = (...xs: string[]): string => xs.join("\n")

describe("merge3 fast paths", () => {
  it("returns the shared text when both sides are identical", () => {
    expect(merge3("base", "same", "same", "text")).toMatchObject({
      clean: true,
      merged: "same",
      conflicts: 0,
    })
  })
  it("takes theirs when only theirs changed", () => {
    expect(merge3("base", "base", "theirs", "text")).toMatchObject({
      clean: true,
      merged: "theirs",
    })
  })
  it("takes ours when only ours changed", () => {
    expect(merge3("base", "ours", "base", "text")).toMatchObject({ clean: true, merged: "ours" })
  })
})

describe("merge3 text (line-level diff3)", () => {
  it("auto-merges disjoint line edits, keeping both changes", () => {
    const r = merge3(
      lines("a", "b", "c", "d", "e"),
      lines("a", "B!", "c", "d", "e"),
      lines("a", "b", "c", "D!", "e"),
      "text",
    )
    expect(r.clean).toBe(true)
    expect(r.merged).toBe(lines("a", "B!", "c", "D!", "e"))
  })
  it("conflicts when both edit the same line differently", () => {
    const r = merge3(lines("a", "b", "c"), lines("a", "X", "c"), lines("a", "Y", "c"), "text")
    expect(r).toMatchObject({ clean: false, merged: null, conflicts: 1 })
    expect(r.hunks.find((h) => h.t === "conflict")).toMatchObject({
      base: "b",
      ours: "X",
      theirs: "Y",
    })
  })
  it("treats delete-on-one-side vs edit-on-the-other as a conflict (no silent drop)", () => {
    const r = merge3(lines("a", "b", "c"), lines("a", "c"), lines("a", "b!", "c"), "text")
    expect(r).toMatchObject({ clean: false, conflicts: 1 })
  })
  it("merges a both-same insertion together with a one-sided append", () => {
    const r = merge3(lines("a", "c"), lines("a", "b", "c"), lines("a", "b", "c", "d"), "text")
    expect(r).toMatchObject({ clean: true, merged: lines("a", "b", "c", "d") })
  })
  it("conflicts on different insertions at the same point", () => {
    expect(merge3(lines("a", "c"), lines("a", "X", "c"), lines("a", "Y", "c"), "text").clean).toBe(
      false,
    )
  })
})

describe("merge3 markdown (block-level diff3)", () => {
  it("auto-merges edits to different blocks", () => {
    const base = "# Title\n\nIntro paragraph.\n\nConclusion paragraph.\n"
    const ours = "# Title\n\nIntro paragraph EDITED.\n\nConclusion paragraph.\n"
    const theirs = "# Title\n\nIntro paragraph.\n\nConclusion paragraph EDITED.\n"
    const r = merge3(base, ours, theirs, "markdown")
    expect(r.clean).toBe(true)
    expect(r.merged).toContain("Intro paragraph EDITED.")
    expect(r.merged).toContain("Conclusion paragraph EDITED.")
  })
  it("conflicts when both edit the same block", () => {
    const base = "# Title\n\nShared paragraph.\n"
    expect(
      merge3(
        base,
        "# Title\n\nShared paragraph, mine.\n",
        "# Title\n\nShared paragraph, theirs.\n",
        "markdown",
      ),
    ).toMatchObject({ clean: false, conflicts: 1 })
  })
  it("reassembles byte-for-byte (fast path returns ours exactly)", () => {
    const base = "# A\n\npara one\n\npara two\n"
    const ours = "# A CHANGED\n\npara one\n\npara two\n"
    expect(merge3(base, ours, base, "markdown").merged).toBe(ours)
  })
})

describe("merge3 html/deck (whole-blob conflict in v1)", () => {
  it("returns one whole-blob conflict when html diverges on both sides", () => {
    const r = merge3("<p>a</p>", "<p>OURS</p>", "<p>THEIRS</p>", "html")
    expect(r).toMatchObject({ clean: false, conflicts: 1 })
    expect(r.hunks).toHaveLength(1)
    expect(r.hunks[0]).toMatchObject({ t: "conflict" })
  })
  it("still fast-paths html when only one side changed", () => {
    expect(merge3("<p>a</p>", "<p>a</p>", "<p>b</p>", "html")).toMatchObject({
      clean: true,
      merged: "<p>b</p>",
    })
  })
  it("treats decks as a whole-blob conflict on divergence", () => {
    expect(merge3("s0", "s0-ours", "s0-theirs", "deck").clean).toBe(false)
  })
})

describe("merge3 guards + kind mapping", () => {
  it("falls back to a whole-blob conflict on oversized input", () => {
    const big = "x".repeat(600 * 1024)
    const r = merge3(big, big + "A", big + "B", "text")
    expect(r).toMatchObject({ clean: false })
    expect(r.hunks).toHaveLength(1)
  })
  it("maps content types to merge kinds", () => {
    expect(mergeKindFor("text/markdown")).toBe("markdown")
    expect(mergeKindFor("text/html")).toBe("html")
    expect(mergeKindFor("text/x-dock-deck")).toBe("deck")
    expect(mergeKindFor("application/whatever")).toBe("text")
    expect(mergeKindFor("text/html; charset=utf-8")).toBe("html") // bundle types carry a charset
    expect(mergeKindFor("text/markdown; charset=utf-8")).toBe("markdown")
    expect(mergeKindFor("text/css; charset=utf-8")).toBe("text")
  })
})

// Seeded PRNG so a failure reproduces (no Math.random flakiness).
const rng = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe("merge3 invariants (fuzz)", () => {
  it("clean iff merged is non-null, and never silently drops a change", () => {
    const rand = rng(1234)
    for (let iter = 0; iter < 400; iter++) {
      const n = 4 + Math.floor(rand() * 16)
      const base = Array.from({ length: n }, (_, i) => `L${i}`)
      const mutate = (tag: string): string[] => {
        const out = [...base]
        const edits = 1 + Math.floor(rand() * 3)
        for (let e = 0; e < edits; e++) {
          if (out.length === 0) break
          const i = Math.floor(rand() * out.length)
          const op = rand()
          if (op < 0.4) out[i] = `${out[i]}_${tag}${iter}_${e}`
          else if (op < 0.7) out.splice(i, 1)
          else out.splice(i, 0, `NEW_${tag}${iter}_${e}`)
        }
        return out
      }
      const ours = mutate("O")
      const theirs = mutate("T")
      const r = merge3(base.join("\n"), ours.join("\n"), theirs.join("\n"), "text")
      expect(r.clean).toBe(r.merged !== null)
      expect(r.clean).toBe(r.conflicts === 0)
      if (r.clean && r.merged !== null) {
        const out = r.merged.split("\n")
        for (const u of ours) if (!base.includes(u)) expect(out).toContain(u)
        for (const u of theirs) if (!base.includes(u)) expect(out).toContain(u)
      }
    }
  })

  it("auto-merges genuinely disjoint edits and includes both", () => {
    for (let iter = 0; iter < 200; iter++) {
      const base = ["a0", "a1", "b0", "MID", "c0", "c1", "c2"]
      const ours = [...base]
      ours[1] = `a1_ours${iter}`
      const theirs = [...base]
      theirs[5] = `c1_theirs${iter}`
      const r = merge3(base.join("\n"), ours.join("\n"), theirs.join("\n"), "text")
      expect(r.clean).toBe(true)
      expect(r.merged).toContain(`a1_ours${iter}`)
      expect(r.merged).toContain(`c1_theirs${iter}`)
      expect(r.merged).toContain("MID")
    }
  })
})

describe("merge3 markdown prose (word-level recursion within a paragraph)", () => {
  it("auto-merges two disjoint edits inside the SAME paragraph", () => {
    const base = "Intro.\n\nThe quick brown fox jumps over the lazy dog.\n\nOutro.\n"
    const ours = "Intro.\n\nThe quick RED fox jumps over the lazy dog.\n\nOutro.\n"
    const theirs = "Intro.\n\nThe quick brown fox jumps over the SLEEPY dog.\n\nOutro.\n"
    const r = merge3(base, ours, theirs, "markdown")
    expect(r.clean).toBe(true)
    expect(r.merged).toContain("RED fox")
    expect(r.merged).toContain("SLEEPY dog")
  })

  it("still conflicts when both edit the SAME word/run of a paragraph", () => {
    const base = "The quick brown fox.\n"
    const ours = "The quick RED fox.\n"
    const theirs = "The quick GREEN fox.\n"
    expect(merge3(base, ours, theirs, "markdown").clean).toBe(false)
  })

  it("does NOT word-merge inside a fenced code block (stays a conflict)", () => {
    const base = "```js\nconst x = 1\nconst y = 2\n```\n"
    const ours = "```js\nconst x = 11\nconst y = 2\n```\n"
    const theirs = "```js\nconst x = 1\nconst y = 22\n```\n"
    // One fenced block edited on both sides → a single block conflict, never a word splice.
    expect(merge3(base, ours, theirs, "markdown").clean).toBe(false)
  })

  it("keeps a clean paragraph word-merge byte-exact on reassembly", () => {
    const base = "alpha beta gamma\n"
    const ours = "alpha BETA gamma\n"
    const theirs = "alpha beta GAMMA\n"
    const r = merge3(base, ours, theirs, "markdown")
    expect(r.clean).toBe(true)
    expect(r.merged).toBe("alpha BETA GAMMA\n")
  })
})

describe("merge3 prose safety net", () => {
  it("rejects a word merge that would change the block's structure (→ conflict)", () => {
    // ours turns the first word into "#"; theirs edits the last word. A blind word
    // merge would yield "# z\n" — a HEADING, not the original paragraph — so the
    // safety net keeps it a conflict instead of silently restructuring.
    const r = merge3("x y\n", "# y\n", "x z\n", "markdown")
    expect(r.clean).toBe(false)
  })
})
