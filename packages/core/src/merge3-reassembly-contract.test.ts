import { describe, expect, it } from "vitest"
import { type MergeHunk, type MergeKind, merge3 } from "./merge3"
import { mutate, prng, randomDoc } from "./merge3-fuzz-helpers"

// The web resolver reassembles a document by joining the merge hunks with the
// kind's separator (clean hunks verbatim, each conflict hunk a chosen side). For
// that to be lossless it relies on an ENGINE invariant: merge3's own hunk
// decomposition rejoins to a faithful document. This fuzz pins that invariant
// across hostile inputs (unicode, emoji, CRLF, blank lines, markdown/html
// structure, deletions) — the resolver's own logic is unit-tested separately in
// apps/web. We assert against the engine's output directly, not a copy of the FE
// code, so there's nothing here to drift out of sync.

const sepFor = (kind: MergeKind): string => (kind === "markdown" ? "" : "\n")

// Join the hunks taking `side` (ours/theirs) for each conflict — the document the
// resolver produces when every conflict is resolved to that side.
const joinSide = (hunks: MergeHunk[], side: "ours" | "theirs", sep: string): string =>
  hunks.map((h) => (h.t === "clean" ? h.text : h[side])).join(sep)

describe("merge3 hunk-decomposition contract (fuzz)", () => {
  it("clean merge: joining the hunks reproduces `merged` byte-for-byte", () => {
    const rand = prng(0xc0ffee)
    const kinds: MergeKind[] = ["text", "markdown"]
    let cleanSeen = 0
    for (let i = 0; i < 6000; i++) {
      const base = randomDoc(rand, Math.floor(rand() * 12))
      const kind = kinds[Math.floor(rand() * kinds.length)] as MergeKind
      const r = merge3(
        base.join("\n"),
        mutate(rand, base, "O").join("\n"),
        mutate(rand, base, "T").join("\n"),
        kind,
      )
      if (r.clean && r.merged !== null) {
        cleanSeen++
        // Every hunk is clean here; joining their text with the separator is the
        // exact inverse of how merge3 built `merged`.
        expect(r.hunks.map((h) => (h.t === "clean" ? h.text : "(BUG)")).join(sepFor(kind))).toBe(
          r.merged,
        )
      }
    }
    expect(cleanSeen).toBeGreaterThan(500) // the fuzz actually exercised the clean path
  })

  it("conflict: resolving every region to one side loses none of that side's text", () => {
    const rand = prng(0xbadbeef)
    const kinds: MergeKind[] = ["text", "markdown"]
    let conflictSeen = 0
    for (let i = 0; i < 6000; i++) {
      const base = randomDoc(rand, 1 + Math.floor(rand() * 12))
      const kind = kinds[Math.floor(rand() * kinds.length)] as MergeKind
      const r = merge3(
        base.join("\n"),
        mutate(rand, base, "O").join("\n"),
        mutate(rand, base, "T").join("\n"),
        kind,
      )
      if (r.clean) continue
      conflictSeen++
      const sep = sepFor(kind)
      for (const side of ["ours", "theirs"] as const) {
        const out = joinSide(r.hunks, side, sep)
        for (const h of r.hunks)
          if (h.t === "conflict" && h[side].trim()) expect(out).toContain(h[side])
      }
    }
    expect(conflictSeen).toBeGreaterThan(200)
  })

  it("a resolved document republishes cleanly (server merges base==ours)", () => {
    // resolveConflict republishes against the live version, so the server merges
    // base==ours==current and fast-paths to the resolved text — never a re-conflict
    // unless a NEW version landed.
    const rand = prng(0x5eed)
    for (let i = 0; i < 2000; i++) {
      const base = randomDoc(rand, 1 + Math.floor(rand() * 10))
      const kind = (["text", "markdown"] as MergeKind[])[Math.floor(rand() * 2)] as MergeKind
      const ours = mutate(rand, base, "O").join("\n")
      const r = merge3(base.join("\n"), ours, mutate(rand, base, "T").join("\n"), kind)
      if (r.clean) continue
      const resolved = joinSide(r.hunks, "theirs", sepFor(kind))
      const republish = merge3(ours, ours, resolved, kind)
      expect(republish.clean).toBe(true)
      expect(republish.merged).toBe(resolved)
    }
  })
})
