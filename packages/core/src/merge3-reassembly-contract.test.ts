import { describe, expect, it } from "vitest"
import { type MergeHunk, type MergeKind, merge3 } from "./merge3"

// The web resolver (apps/web/src/pages/artifact/lib/merge-reassemble.ts) rebuilds a
// document from merge3's hunks: clean hunks pass through, each conflict hunk takes a
// chosen side, joined with the kind's separator. This fuzz mirrors that reassembly
// and round-trips it against the REAL engine across hostile inputs — so any drift
// between the engine's decomposition and the resolver's reassembly (the silent
// data-corruption risk) trips here. The mirror MUST match the FE helper.
type Choice = { pick: "ours" } | { pick: "theirs" } | { pick: "edit"; text: string }
const sepFor = (kind: MergeKind): string => (kind === "markdown" ? "" : "\n")
const reassemble = (hunks: MergeHunk[], choices: Record<number, Choice>, kind: MergeKind): string =>
  hunks
    .map((h, i) => {
      if (h.t === "clean") return h.text
      const c = choices[i]
      if (!c) throw new Error(`unresolved conflict at hunk ${i}`)
      return c.pick === "ours" ? h.ours : c.pick === "theirs" ? h.theirs : c.text
    })
    .join(sepFor(kind))

// Deterministic PRNG so any failure reproduces from its seed.
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
// Adversarial atoms: empty, whitespace, unicode, markdown structure, html, markers.
const ATOMS = [
  "a",
  "b",
  "",
  " ",
  "\t",
  "héllo",
  "🙂",
  "</div>",
  "|--|",
  "- item",
  "# h",
  "> q",
  "```",
]
const randomDoc = (rand: () => number, n: number): string[] =>
  Array.from({ length: n }, () => ATOMS[Math.floor(rand() * ATOMS.length)] as string)
const mutate = (rand: () => number, src: string[], tag: string): string[] => {
  const out = [...src]
  const edits = Math.floor(rand() * 4)
  for (let e = 0; e < edits; e++) {
    if (out.length === 0) {
      out.push(`ins_${tag}_${e}`)
      continue
    }
    const i = Math.floor(rand() * out.length)
    const op = rand()
    if (op < 0.4) out[i] = `${out[i] ?? ""}_${tag}${e}`
    else if (op < 0.7) out.splice(i, 1)
    else out.splice(i, 0, `ins_${tag}_${e}`)
  }
  return out
}
const conflictChoices = (hunks: MergeHunk[], pick: Choice): Record<number, Choice> =>
  Object.fromEntries(hunks.flatMap((h, i) => (h.t === "conflict" ? [[i, pick]] : [])))

describe("merge3 ↔ resolver reassembly contract (fuzz)", () => {
  it("clean merge: reassembling the hunks reproduces `merged` byte-for-byte", () => {
    const rand = prng(0xc0ffee)
    const kinds: MergeKind[] = ["text", "markdown"]
    let cleanSeen = 0
    for (let i = 0; i < 6000; i++) {
      const base = randomDoc(rand, Math.floor(rand() * 12))
      const kind = kinds[Math.floor(rand() * kinds.length)] as MergeKind
      const b = base.join("\n")
      const ours = mutate(rand, base, "O").join("\n")
      const theirs = mutate(rand, base, "T").join("\n")
      const r = merge3(b, ours, theirs, kind)
      if (r.clean && r.merged !== null) {
        cleanSeen++
        // The exact inverse: what the resolver shows as "no conflict" rebuilds to merged.
        expect(reassemble(r.hunks, {}, kind)).toBe(r.merged)
      }
    }
    expect(cleanSeen).toBeGreaterThan(500) // the fuzz actually exercised the clean path
  })

  it("conflict: every resolution reassembles to a string and places the chosen text", () => {
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
      // An unresolved conflict is gated, never silently published.
      expect(() => reassemble(r.hunks, {}, kind)).toThrow(/unresolved conflict/)
      // Picking either side, or a hand-edit, always yields a string with that text in it.
      for (const side of ["ours", "theirs"] as const) {
        const out = reassemble(r.hunks, conflictChoices(r.hunks, { pick: side }), kind)
        expect(typeof out).toBe("string")
        for (const h of r.hunks)
          if (h.t === "conflict" && h[side].trim()) expect(out).toContain(h[side])
      }
      const marker = `EDIT_${i}_ZZ`
      const edited = reassemble(
        r.hunks,
        conflictChoices(r.hunks, { pick: "edit", text: marker }),
        kind,
      )
      expect(edited).toContain(marker)
    }
    expect(conflictSeen).toBeGreaterThan(200)
  })

  it("a resolved document always republishes cleanly (base==ours fast path)", () => {
    // resolveConflict republishes the reassembled doc with baseVersion = the live
    // version, so the server merges base==ours and fast-paths to the resolved text.
    const rand = prng(0x5eed)
    for (let i = 0; i < 2000; i++) {
      const base = randomDoc(rand, 1 + Math.floor(rand() * 10))
      const kind = (["text", "markdown"] as MergeKind[])[Math.floor(rand() * 2)] as MergeKind
      const ours = mutate(rand, base, "O").join("\n")
      const r = merge3(base.join("\n"), ours, mutate(rand, base, "T").join("\n"), kind)
      if (r.clean) continue
      const resolved = reassemble(r.hunks, conflictChoices(r.hunks, { pick: "theirs" }), kind)
      const republish = merge3(ours, ours, resolved, kind) // base==ours==current
      expect(republish.clean).toBe(true)
      expect(republish.merged).toBe(resolved)
    }
  })
})
