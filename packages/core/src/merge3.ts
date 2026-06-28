import { marked } from "marked"

/**
 * Three-way (diff3) merge for a single artifact's text. Given the common
 * ancestor `base` and two descendants `ours` / `theirs`, regions exactly one
 * side changed are applied automatically; only regions BOTH sides changed (to
 * different things) become conflicts. A clean merge is byte-reproducible with no
 * model call — the deterministic core the AI/UX layers build on.
 *
 * This is the classic diff3 algorithm: align both sides to the base via LCS,
 * take one-sided changes, conflict on two-sided ones. Per Khanna-Kunal-Pierce
 * ("A Formal Investigation of Diff3"), the intuition that "edits to well-
 * separated regions never conflict" does NOT hold in general — so the guarantee
 * we rely on is the weaker, true one: a clean merge never silently drops a
 * change (asserted by the fuzz test). HTML and decks are NOT line-spliced in v1
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

/** The diff3 core over unit arrays: walk the base anchors both sides agree on;
 *  between anchors take the one side that changed, or conflict when both did. */
const diff3 = (base: string[], ours: string[], theirs: string[]): RawHunk[] => {
  const toOurs = new Map<number, number>()
  for (const [bi, oi] of lcsPairs(base, ours)) toOurs.set(bi, oi)
  const toTheirs = new Map<number, number>()
  for (const [bi, ti] of lcsPairs(base, theirs)) toTheirs.set(bi, ti)

  // Stable anchors: base units matched in BOTH sides, plus a sentinel past the
  // end so the trailing region is emitted.
  const anchors: Array<[number, number, number]> = []
  for (let bi = 0; bi < base.length; bi++) {
    const oi = toOurs.get(bi)
    const ti = toTheirs.get(bi)
    if (oi !== undefined && ti !== undefined) anchors.push([bi, oi, ti])
  }
  anchors.push([base.length, ours.length, theirs.length])

  const hunks: RawHunk[] = []
  let clean: string[] = []
  const flush = () => {
    if (clean.length) {
      hunks.push({ t: "clean", toks: clean })
      clean = []
    }
  }
  let bi = 0
  let oi = 0
  let ti = 0
  for (const [ba, oa, ta] of anchors) {
    const bSlice = base.slice(bi, ba)
    const oSlice = ours.slice(oi, oa)
    const tSlice = theirs.slice(ti, ta)
    if (bSlice.length || oSlice.length || tSlice.length) {
      if (sameUnits(oSlice, bSlice))
        clean.push(...tSlice) // ours unchanged here → take theirs
      else if (sameUnits(tSlice, bSlice))
        clean.push(...oSlice) // theirs unchanged here → take ours
      else if (sameUnits(oSlice, tSlice))
        clean.push(...oSlice) // both made the same change → take either
      else {
        flush()
        hunks.push({ t: "conflict", base: bSlice, ours: oSlice, theirs: tSlice })
      }
    }
    const anchorUnit = base[ba]
    if (ba < base.length && anchorUnit !== undefined) clean.push(anchorUnit)
    bi = ba + 1
    oi = oa + 1
    ti = ta + 1
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
  const raw = diff3(bT, oT, tT)
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
