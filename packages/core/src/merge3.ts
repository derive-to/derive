import { marked } from "marked"

/**
 * Three-way (diff3) merge for a single artifact's text. Given the common
 * ancestor `base` and two descendants `ours` / `theirs`, regions exactly one
 * side changed are applied automatically; only regions BOTH sides changed (to
 * different things) become conflicts. A clean merge is byte-reproducible with no
 * model call — the deterministic core the AI/UX layers build on.
 *
 * This is a git-style HUNK-BASED 3-way merge: compute each side's changed base
 * ranges (via LCS), then apply changes only one side made and conflict only where
 * both changed OVERLAPPING base coordinates — so independent edits combine even on
 * adjacent lines. The guarantee we lean on is the strong one: a clean merge never
 * silently drops a change a side made, even when one side's change bridges across
 * the other's (asserted by the adversarial fuzz). HTML and decks are NOT line-spliced
 * in v1
 * (interleaving disjoint line edits routinely yields malformed DOM); they fall
 * back to a whole-blob conflict until a structure-aware merge lands.
 */

export type MergeKind = "markdown" | "html" | "deck" | "text"

/** One region of a 3-way merge: text already resolved into the output, or a
 *  conflict carrying all three sides for a human/agent to reconcile. */
export type MergeHunk =
  | { t: "clean"; text: string }
  | { t: "conflict"; base: string; ours: string; theirs: string }

export interface MergeResult {
  /** True when no region conflicted — `merged` is then the final document. */
  clean: boolean
  /** The merged document when clean; null when any region conflicts. */
  merged: string | null
  /** The merge decomposed into clean + conflict regions, in document order. */
  hunks: MergeHunk[]
  /** Number of conflicting regions (0 ⇔ clean). */
  conflicts: number
}

/**
 * Pick the merge granularity for a single-file content type. Bundles are merged
 * per file at a higher layer, each file dispatched back through merge3 by its own
 * type, so there is no "bundle" kind here.
 */
export const mergeKindFor = (contentType: string): MergeKind => {
  // Bundle file types carry a charset param (e.g. "text/css; charset=utf-8"); match
  // on the bare type so a bundled .md/.html merges as markdown/html, not plain text.
  const t = contentType.split(";")[0]?.trim() ?? ""
  return t === "text/markdown"
    ? "markdown"
    : t === "text/x-dock-deck"
      ? "deck"
      : t === "text/html"
        ? "html"
        : "text"
}

// Above these, skip the O(n*m) diff entirely and emit one whole-blob conflict —
// a minified or pathologically large file would otherwise burn CPU/memory on an
// edge isolate. The caller (or an agent) then chooses a side.
const MAX_MERGE_BYTES = 512 * 1024
const MAX_MERGE_UNITS = 5000

// The units diff3 aligns on. Markdown aligns on BLOCKS via marked's lexer: the
// concatenation of every token's `.raw` reproduces the source verbatim, so block
// reassembly never reflows or drops whitespace. Everything else aligns on lines.
const tokenize = (text: string, kind: MergeKind): string[] =>
  kind === "markdown" ? marked.lexer(text).map((t) => t.raw) : text.split("\n")

// Markdown block `.raw` values already carry their own separators; lines rejoin
// with newlines.
const separator = (kind: MergeKind): string => (kind === "markdown" ? "" : "\n")

const sameUnits = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** LCS-matched index pairs between two unit arrays, increasing in both indices.
 *  O(n*m) DP, bounded by the caller's size guard (mirrors diff.ts). */
const lcsPairs = (a: string[], b: string[]): Array<[number, number]> => {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] ?? []
    const below = dp[i + 1] ?? []
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      i++
    } else {
      j++
    }
  }
  return pairs
}

type RawHunk =
  | { t: "clean"; toks: string[] }
  | { t: "conflict"; base: string[]; ours: string[]; theirs: string[] }

/** Base-line index → side-line index for the lines a side left UNCHANGED (LCS-matched). */
const baseToSide = (a: string[], x: string[]): Map<number, number> => {
  const m = new Map<number, number>()
  for (const [ai, xi] of lcsPairs(a, x)) m.set(ai, xi)
  return m
}

/** The base ranges [aStart, aEnd) a side changed vs base (a zero-width range is an
 *  insertion point). Independent changes stay SEPARATE ranges so they can both apply —
 *  this is what lets adjacent-but-disjoint edits merge instead of conflicting. */
const changeHunks = (a: string[], x: string[]): Array<[number, number]> => {
  const hunks: Array<[number, number]> = []
  let ai = 0
  let xi = 0
  for (const [ma, mx] of [...lcsPairs(a, x), [a.length, x.length] as [number, number]]) {
    if (ma > ai || mx > xi) hunks.push([ai, ma])
    ai = ma + 1
    xi = mx + 1
  }
  return hunks
}

/** A side's content for base range [bs, be) — INCLUDING lines it kept inside the range,
 *  so a side's slice is never missing content even when the other side's change bridges
 *  across it (this is the no-data-loss guarantee for the hunk-based merge). */
const sliceForBaseRange = (
  x: string[],
  matched: Map<number, number>,
  bs: number,
  be: number,
  baseLen: number,
): string[] => {
  let xStart = 0
  for (let k = bs - 1; k >= 0; k--) {
    const xi = matched.get(k)
    if (xi !== undefined) {
      xStart = xi + 1
      break
    }
  }
  let xEnd = x.length
  for (let k = be; k < baseLen; k++) {
    const xi = matched.get(k)
    if (xi !== undefined) {
      xEnd = xi
      break
    }
  }
  return x.slice(xStart, xEnd)
}

/**
 * The diff3 core (git-style, hunk-based). Compute each side's changed base ranges,
 * then walk base merging them: a range only ONE side changed is taken from that side;
 * ranges both sides changed at OVERLAPPING base coordinates conflict (unless both made
 * the identical change). Independent edits on adjacent lines stay separate and both
 * apply — unlike the textbook stable-anchor diff3, which conflicts them. Generic over
 * the unit array, so lines, markdown blocks, and words all reuse it.
 */
const diff3 = (base: string[], ours: string[], theirs: string[]): RawHunk[] => {
  const matchedO = baseToSide(base, ours)
  const matchedT = baseToSide(base, theirs)
  const oh = changeHunks(base, ours)
  const th = changeHunks(base, theirs)
  const ourSlice = (bs: number, be: number) =>
    sliceForBaseRange(ours, matchedO, bs, be, base.length)
  const theirSlice = (bs: number, be: number) =>
    sliceForBaseRange(theirs, matchedT, bs, be, base.length)

  const hunks: RawHunk[] = []
  let clean: string[] = []
  const flush = () => {
    if (clean.length) {
      hunks.push({ t: "clean", toks: clean })
      clean = []
    }
  }

  let p = 0
  let oi = 0
  let ti = 0
  while (oi < oh.length || ti < th.length) {
    const start = Math.min(
      oh[oi]?.[0] ?? Number.POSITIVE_INFINITY,
      th[ti]?.[0] ?? Number.POSITIVE_INFINITY,
    )
    // unchanged base before the next change region
    for (let k = p; k < start; k++) {
      const ln = base[k]
      if (ln !== undefined) clean.push(ln)
    }
    // cluster: the change(s) at `start`, expanded while the other side strictly overlaps
    let clEnd = start
    let sawO = false
    let sawT = false
    for (;;) {
      let grew = false
      const o = oh[oi]
      if (o && (o[0] === start || o[0] < clEnd)) {
        clEnd = Math.max(clEnd, o[1])
        sawO = true
        oi++
        grew = true
      }
      const t = th[ti]
      if (t && (t[0] === start || t[0] < clEnd)) {
        clEnd = Math.max(clEnd, t[1])
        sawT = true
        ti++
        grew = true
      }
      if (!grew) break
    }
    if (sawO && sawT) {
      const o = ourSlice(start, clEnd)
      const t = theirSlice(start, clEnd)
      if (sameUnits(o, t)) {
        clean.push(...o) // both sides made the identical change
      } else {
        flush()
        hunks.push({ t: "conflict", base: base.slice(start, clEnd), ours: o, theirs: t })
      }
    } else if (sawO) {
      clean.push(...ourSlice(start, clEnd))
    } else {
      clean.push(...theirSlice(start, clEnd))
    }
    p = clEnd
  }
  for (let k = p; k < base.length; k++) {
    const ln = base[k]
    if (ln !== undefined) clean.push(ln)
  }
  flush()
  return hunks
}

const cleanResult = (text: string): MergeResult => ({
  clean: true,
  merged: text,
  hunks: [{ t: "clean", text }],
  conflicts: 0,
})

const wholeConflict = (base: string, ours: string, theirs: string): MergeResult => ({
  clean: false,
  merged: null,
  hunks: [{ t: "conflict", base, ours, theirs }],
  conflicts: 1,
})

// Split prose into words AND the whitespace between them (kept as tokens), so a
// word-level diff3 rejoins byte-for-byte with "".
const splitWords = (text: string): string[] => text.split(/(\s+)/).filter((t) => t !== "")

// A block is "prose" we can safely word-merge only if it lexes to exactly one
// paragraph — never a heading, code fence, table, list item, or blockquote (whose
// inner structure a blind word merge would corrupt).
const isParagraph = (block: string): boolean => {
  const real = marked.lexer(block).filter((t) => t.type !== "space")
  return real.length === 1 && real[0]?.type === "paragraph"
}

// Refine a block-level markdown conflict: when it's a SINGLE paragraph edited
// differently on each side, retry at word granularity so two disjoint edits inside
// one paragraph still auto-merge. Anything coarser (multi-block, a delete, or a
// non-paragraph block) stays a conflict.
const refineProse = (h: RawHunk): RawHunk[] => {
  if (h.t !== "conflict") return [h]
  if (h.base.length !== 1 || h.ours.length !== 1 || h.theirs.length !== 1) return [h]
  const b = h.base[0] as string
  const o = h.ours[0] as string
  const t = h.theirs[0] as string
  if (!isParagraph(b) || !isParagraph(o) || !isParagraph(t)) return [h]
  const words = diff3(splitWords(b), splitWords(o), splitWords(t))
  if (words.some((w) => w.t === "conflict")) return [h] // overlapping words → keep the conflict
  const merged = words.flatMap((w) => (w.t === "clean" ? w.toks : [])).join("")
  // Safety net: a word merge that no longer lexes as a single paragraph (e.g. a merged
  // word turned it into a heading/list, or it split in two) is rejected to a conflict.
  if (!isParagraph(merged)) return [h]
  return [{ t: "clean", toks: [merged] }]
}

/**
 * Three-way merge `ours` and `theirs` over their common ancestor `base`. Returns
 * a clean merged document when the two sides' changes don't overlap, or the
 * conflicting regions when they do.
 */
export const merge3 = (
  base: string,
  ours: string,
  theirs: string,
  kind: MergeKind,
): MergeResult => {
  // Fast paths — no diff, byte-reproducible.
  if (ours === theirs) return cleanResult(ours) // both sides identical (incl. same edit)
  if (ours === base) return cleanResult(theirs) // only theirs changed
  if (theirs === base) return cleanResult(ours) // only ours changed

  // v1 never line-splices HTML/decks (it produces malformed DOM); oversized input
  // skips the quadratic diff. Both degrade to a single whole-blob conflict.
  const tooBig =
    base.length > MAX_MERGE_BYTES ||
    ours.length > MAX_MERGE_BYTES ||
    theirs.length > MAX_MERGE_BYTES
  if (kind === "html" || kind === "deck" || tooBig) return wholeConflict(base, ours, theirs)

  const bT = tokenize(base, kind)
  const oT = tokenize(ours, kind)
  const tT = tokenize(theirs, kind)
  if (bT.length > MAX_MERGE_UNITS || oT.length > MAX_MERGE_UNITS || tT.length > MAX_MERGE_UNITS)
    return wholeConflict(base, ours, theirs)

  const sep = separator(kind)
  // Markdown conflicts on a single paragraph both sides edited recurse to word level,
  // so two disjoint edits within one paragraph still auto-merge (prose is the common case).
  const blocks = diff3(bT, oT, tT)
  const raw = kind === "markdown" ? blocks.flatMap(refineProse) : blocks
  const hunks: MergeHunk[] = raw.map((h) =>
    h.t === "clean"
      ? { t: "clean", text: h.toks.join(sep) }
      : {
          t: "conflict",
          base: h.base.join(sep),
          ours: h.ours.join(sep),
          theirs: h.theirs.join(sep),
        },
  )
  const conflicts = raw.reduce((n, h) => n + (h.t === "conflict" ? 1 : 0), 0)
  const clean = conflicts === 0
  const merged = clean ? raw.flatMap((h) => (h.t === "clean" ? h.toks : [])).join(sep) : null
  return { clean, merged, hunks, conflicts }
}
