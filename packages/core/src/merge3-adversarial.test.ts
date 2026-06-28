import { describe, expect, it } from "vitest"
import { type MergeKind, merge3 } from "./merge3"

// Deterministic PRNG (mulberry32) so any failure reproduces from its seed.
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// A pool of adversarial line atoms: empty, whitespace, unicode, markers, repeats.
const ATOMS = [
  "a",
  "b",
  "c",
  "",
  " ",
  "  ",
  "\t",
  "héllo",
  "🙂",
  "</div>",
  "|---|",
  "- item",
  "# h",
]

const randomDoc = (rand: () => number, n: number): string[] =>
  Array.from({ length: n }, () => ATOMS[Math.floor(rand() * ATOMS.length)] as string)

const mutate = (rand: () => number, src: string[], tag: string): string[] => {
  const out = [...src]
  const edits = Math.floor(rand() * 4)
  for (let e = 0; e < edits; e++) {
    if (out.length === 0 && rand() < 0.5) {
      out.push(`ins_${tag}_${e}`)
      continue
    }
    const i = Math.floor(rand() * Math.max(1, out.length))
    const op = rand()
    if (op < 0.4)
      out[i] = `${out[i] ?? ""}_${tag}${e}` // edit → unique marker
    else if (op < 0.7)
      out.splice(i, 1) // delete
    else out.splice(i, 0, `ins_${tag}_${e}`) // insert → unique marker
  }
  return out
}

describe("merge3 adversarial: universal invariants (text + markdown)", () => {
  it("never throws; clean ⇔ merged!=null ⇔ conflicts==0; and is deterministic", () => {
    const rand = prng(20260627)
    const kinds: MergeKind[] = ["text", "markdown"]
    for (let i = 0; i < 3000; i++) {
      const base = randomDoc(rand, Math.floor(rand() * 12))
      const ours = mutate(rand, base, "O").join("\n")
      const theirs = mutate(rand, base, "T").join("\n")
      const b = base.join("\n")
      const kind = kinds[Math.floor(rand() * kinds.length)] as MergeKind
      const r = merge3(b, ours, theirs, kind)
      // result-shape consistency
      expect(r.clean).toBe(r.merged !== null)
      expect(r.clean).toBe(r.conflicts === 0)
      expect(r.conflicts).toBe(r.hunks.filter((h) => h.t === "conflict").length)
      // determinism: identical call → identical result
      expect(merge3(b, ours, theirs, kind)).toEqual(r)
    }
  })

  it("never silently drops a change: clean text merge keeps every unit a side introduced", () => {
    const rand = prng(424242)
    for (let i = 0; i < 3000; i++) {
      const base = Array.from({ length: 2 + Math.floor(rand() * 12) }, (_, k) => `L${k}`)
      const ours = mutate(rand, base, "O")
      const theirs = mutate(rand, base, "T")
      const r = merge3(base.join("\n"), ours.join("\n"), theirs.join("\n"), "text")
      if (!r.clean || r.merged === null) continue
      const out = r.merged.split("\n")
      for (const u of ours) if (!base.includes(u)) expect(out).toContain(u)
      for (const u of theirs) if (!base.includes(u)) expect(out).toContain(u)
    }
  })
})

describe("merge3 adversarial: identity laws", () => {
  const cases = [
    "",
    "x",
    "a\nb\nc\n",
    "line",
    "a\r\nb\r\n",
    "  ",
    "🙂\nz",
    "</div>\n</div>\n</div>\n",
  ]
  for (const kind of ["text", "markdown"] as MergeKind[]) {
    for (const doc of cases) {
      it(`merge3(x,x,x)=x · (b,b,t)=t · (b,o,b)=o  [${kind}] ${JSON.stringify(doc).slice(0, 14)}`, () => {
        const other = `${doc}\nEDIT-${kind}\n`
        expect(merge3(doc, doc, doc, kind)).toMatchObject({ clean: true, merged: doc })
        expect(merge3(doc, doc, other, kind)).toMatchObject({ clean: true, merged: other })
        expect(merge3(doc, other, doc, kind)).toMatchObject({ clean: true, merged: other })
      })
    }
  }
})

describe("merge3 adversarial: brutal edge inputs", () => {
  it("handles empty / whitespace-only / no-trailing-newline without loss", () => {
    expect(merge3("", "a", "", "text")).toMatchObject({ clean: true, merged: "a" })
    expect(merge3("", "", "b", "text")).toMatchObject({ clean: true, merged: "b" })
    // no trailing newline, disjoint edits on different lines
    const r = merge3("a\nb\nc", "A\nb\nc", "a\nb\nC", "text")
    expect(r.clean).toBe(true)
    expect(r.merged).toBe("A\nb\nC")
  })

  it("preserves CRLF as ordinary content (no normalization surprises)", () => {
    const base = "a\r\nb\r\nc\r\n"
    const r = merge3(base, "A\r\nb\r\nc\r\n", "a\r\nb\r\nC\r\n", "text")
    expect(r.clean).toBe(true)
    expect(r.merged).toBe("A\r\nb\r\nC\r\n")
  })

  it("does not mis-merge around repeated boilerplate lines (diff3 anomaly zone)", () => {
    // Many identical "</div>" lines; each side edits a DISTINCT unique line between them.
    const base = "x\n</div>\ny\n</div>\nz\n</div>\n"
    const ours = "X\n</div>\ny\n</div>\nz\n</div>\n" // edits x
    const theirs = "x\n</div>\ny\n</div>\nZ\n</div>\n" // edits z
    const r = merge3(base, ours, theirs, "text")
    // Must not drop either edit. Either a clean merge with BOTH, or an honest conflict —
    // never a clean result missing one.
    if (r.clean && r.merged) {
      expect(r.merged).toContain("X")
      expect(r.merged).toContain("Z")
      expect(r.merged.match(/<\/div>/g)?.length).toBe(3) // no boilerplate lost or duplicated
    } else {
      expect(r.conflicts).toBeGreaterThan(0)
    }
  })

  it("conflicts (never corrupts) when both sides rewrite the same single line", () => {
    const r = merge3("only\n", "mine\n", "theirs\n", "text")
    expect(r.clean).toBe(false)
    expect(r.merged).toBeNull()
  })

  it("keeps a unicode/emoji edit intact on a clean merge (edits separated by an anchor)", () => {
    // diff3 needs an unchanged line BETWEEN the two edits to merge them.
    const r = merge3("a\nb\nc\n", "🙂\nb\nc\n", "a\nb\nZ\n", "text")
    expect(r.clean).toBe(true)
    expect(r.merged).toBe("🙂\nb\nZ\n")
  })

  it("CONSERVATIVE but SAFE: adjacent independent edits conflict, never lose data", () => {
    // Two edits on consecutive lines with no unchanged line between them: textbook diff3
    // surfaces a conflict rather than merging (git's hunk-based merge would combine them).
    // The point we GUARANTEE: both sides survive in the conflict — nothing is dropped.
    const r = merge3("a\nb\n", "X\nb\n", "a\nY\n", "text")
    expect(r.clean).toBe(false)
    const all = r.hunks
      .flatMap((h) => (h.t === "conflict" ? [h.ours, h.theirs] : [h.text]))
      .join("\n")
    expect(all).toContain("X")
    expect(all).toContain("Y")
  })
})
