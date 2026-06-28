// Shared fuzz scaffolding for the merge3 test suites: a deterministic PRNG (so any
// failure reproduces from its seed) and an adversarial document mutator. Lives in
// its own module so the adversarial and reassembly-contract suites share one copy
// instead of each carrying their own. Not exported from the package index — test
// support only.

/** mulberry32: deterministic, seedable PRNG. */
export const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Adversarial line atoms: empty, whitespace, unicode, markdown/html structure, markers. */
export const ATOMS = [
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

export const randomDoc = (rand: () => number, n: number): string[] =>
  Array.from({ length: n }, () => ATOMS[Math.floor(rand() * ATOMS.length)] as string)

/** Apply 0-3 random edits (edit / delete / insert, each tagged uniquely) to a doc. */
export const mutate = (rand: () => number, src: string[], tag: string): string[] => {
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
