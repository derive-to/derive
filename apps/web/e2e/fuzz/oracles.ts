import {
  deckOf,
  type HNode,
  nodeAtPath,
  parseHtml,
  type SourceChunk,
  type SourceSlide,
} from "./html-tree"
import type { DomSlideCapture } from "./probe"

/**
 * The fuzz oracles, as pure functions over (source before, source after, what the
 * edited page showed). No browser and no @derive/core here, so the sanity spec can
 * feed them hand-made corruptions and prove each one bites.
 *
 *  wysiwyg       the saved source, rendered, reads exactly like the edited page did
 *  minimal-diff  bytes outside what the person touched are identical; a moved block's
 *                own bytes are identical; nothing appears or disappears unasked
 *  artifacts     no editor-only markup (contenteditable, data-derive-editable, …)
 *                entered the source
 *  save          the save itself was refused, partial, or never sent
 *  markdown      (Markdown docs) the same questions asked of Markdown source: bytes
 *                outside the edited blocks — and, in a list or table, outside the
 *                edited items or rows — are identical and in order; a block appears
 *                only where the page split one, and disappears only where it was
 *                edited; no HTML but the editor's own spellings enters the prose
 *  leak          (checked live during the session) typing landed in a block the
 *                person did not click
 */

export type Oracle =
  | "wysiwyg"
  | "minimal-diff"
  | "artifacts"
  | "save"
  | "leak"
  | "arrange-model"
  | "harness"

export interface Failure {
  oracle: Oracle
  /** Stable, number-free description used to group failures across seeds. */
  signature: string
  message: string
  slide?: number
  excerpt?: string
}

export const normText = (s: string): string =>
  s
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Where two strings first/last differ, with a little context each side. */
export function diffWindow(a: string, b: string, context = 50) {
  let p = 0
  const max = Math.min(a.length, b.length)
  while (p < max && a[p] === b[p]) p++
  let s = 0
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return {
    prefix: p,
    suffix: s,
    a: a.slice(Math.max(0, p - context), a.length - s + context),
    b: b.slice(Math.max(0, p - context), b.length - s + context),
    aMid: a.slice(p, a.length - s),
    bMid: b.slice(p, b.length - s),
  }
}

function textSignature(expected: string, saved: string): string {
  const d = diffWindow(expected, saved)
  if (d.aMid.replace(/\s/g, "") === d.bMid.replace(/\s/g, "")) return "whitespace differs"
  if (!d.bMid) return "saved text is missing edited text"
  if (!d.aMid) return "saved text has extra text"
  if (d.bMid.includes(d.aMid)) return "saved text has extra text"
  if (d.aMid.includes(d.bMid)) return "saved text is missing edited text"
  return "saved text differs from edited text"
}

export function checkWysiwyg(expected: string[], rendered: string[]): Failure[] {
  const out: Failure[] = []
  if (expected.length !== rendered.length) {
    out.push({
      oracle: "wysiwyg",
      signature: "slide count differs between edited page and saved render",
      message: `edited page shows ${expected.length} slides, saved render has ${rendered.length}`,
    })
    return out
  }
  expected.forEach((want, i) => {
    const got = rendered[i] as string
    if (normText(want) === normText(got)) return
    const d = diffWindow(normText(want), normText(got))
    out.push({
      oracle: "wysiwyg",
      signature: textSignature(normText(want), normText(got)),
      message: `slide ${i + 1}: edited page shows "${clip(d.a, 160)}" but the saved source renders "${clip(d.b, 160)}"`,
      slide: i + 1,
      excerpt: `edited : ${d.a}\nsaved  : ${d.b}`,
    })
  })
  return out
}

/** Editor-only markup that must never reach stored source. Counted, so markup the
 *  author legitimately wrote before the session is not blamed on the editor. */
export const ARTIFACT_PATTERNS: [string, RegExp][] = [
  ["contenteditable", /\scontenteditable\b/gi],
  ["spellcheck", /\sspellcheck\b/gi],
  ["tabindex", /\stabindex\b/gi],
  ["data-derive-editable", /data-derive-editable/g],
  ["data-derive-fmt", /data-derive-fmt/g],
  ["data-derive-href", /data-derive-href/g],
  ["data-derive-hold", /data-derive-hold/g],
  ["data-derive-runtime-*", /data-derive-runtime/g],
  ["data-derive-readonly", /data-derive-readonly/g],
  ["data-derive-mention", /data-derive-mention/g],
  ["data-derive-id", /data-derive-id\b/g],
  ["data-interaction-state", /data-interaction-state/g],
  ["editor class (derive-edit*/derive-edited)", /\bderive-edit(?:ed|-[a-z-]+|able)?\b/g],
  ["editor class (derive-block-*/derive-structure-*)", /\bderive-(?:block|structure)-[a-z-]+/g],
  ["editor class (derive-el-*/derive-hl)", /\bderive-(?:el-[a-z]+|hl)\b/g],
  ["editor class (derive-resize-*)", /\bderive-resize-[a-z-]+/g],
  ["zero-width placeholder", /\u200b|\u200c|\u200d|\ufeff|&#8203;|&#x200b;|&ZeroWidthSpace;/gi],
]

export function checkArtifacts(before: string, after: string): Failure[] {
  const out: Failure[] = []
  for (const [name, re] of ARTIFACT_PATTERNS) {
    const was = before.match(re)?.length ?? 0
    const now = after.match(re)?.length ?? 0
    if (now > was) {
      const at = after.search(re)
      out.push({
        oracle: "artifacts",
        signature: `editor markup in source: ${name}`,
        message: `${name}: ${was} occurrence(s) before the save, ${now} after`,
        excerpt: after.slice(Math.max(0, at - 120), at + 120),
      })
    }
  }
  return out
}

function bytesDiff(
  kind: string,
  before: string,
  after: string,
  where: string,
  slide?: number,
): Failure {
  const d = diffWindow(before, after, 80)
  return {
    oracle: "minimal-diff",
    signature: kind,
    message: `${where}: ${kind}`,
    slide,
    excerpt: `before: ${d.a}\nafter : ${d.b}`,
  }
}

const gapsOf = (src: string, slide: SourceSlide) => {
  const gaps: string[] = []
  let at = slide.node.openEnd
  for (const c of slide.chunks) {
    gaps.push(src.slice(at, c.start))
    at = c.end
  }
  gaps.push(src.slice(at, closeStart(src, slide)))
  return gaps
}
const closeStart = (src: string, slide: SourceSlide) => {
  const i = src.lastIndexOf("</", slide.end)
  return i >= slide.node.openEnd ? i : slide.end
}

/**
 * Minimal diff for an inline edit save. `dom` is the edited page's capture: which
 * slides and chunks changed (relative to the session snapshot), the chunk order it
 * shows, and per chunk the paths of the elements whose own content changed.
 */
export function checkEditDiff(before: string, after: string, dom: DomSlideCapture[]): Failure[] {
  const out: Failure[] = []
  const b = deckOf(before)
  const a = deckOf(after)
  if (b.slides.length !== a.slides.length || b.slides.length !== dom.length) {
    out.push({
      oracle: "minimal-diff",
      signature: "slide count changed by an inline edit",
      message: `before ${b.slides.length} slides, after ${a.slides.length}, edited page ${dom.length}`,
    })
    return out
  }
  const first = (d: typeof b) => d.slides[0] as SourceSlide
  const last = (d: typeof b) => d.slides[d.slides.length - 1] as SourceSlide
  if (before.slice(0, first(b).start) !== after.slice(0, first(a).start))
    out.push(
      bytesDiff(
        "bytes before the first slide changed",
        before.slice(0, first(b).start),
        after.slice(0, first(a).start),
        "document head",
      ),
    )
  if (before.slice(last(b).end) !== after.slice(last(a).end))
    out.push(
      bytesDiff(
        "bytes after the last slide changed",
        before.slice(last(b).end),
        after.slice(last(a).end),
        "document tail",
      ),
    )
  for (let i = 1; i < b.slides.length; i++) {
    const gb = before.slice(
      (b.slides[i - 1] as SourceSlide).end,
      (b.slides[i] as SourceSlide).start,
    )
    const ga = after.slice((a.slides[i - 1] as SourceSlide).end, (a.slides[i] as SourceSlide).start)
    if (gb !== ga)
      out.push(
        bytesDiff("bytes between slides changed", gb, ga, `between slides ${i} and ${i + 1}`),
      )
  }

  b.slides.forEach((sb, i) => {
    const sa = a.slides[i] as SourceSlide
    const cap = dom[i] as DomSlideCapture
    const bytesB = before.slice(sb.start, sb.end)
    const bytesA = after.slice(sa.start, sa.end)
    if (!cap.touched) {
      if (bytesB !== bytesA)
        out.push(bytesDiff("untouched slide changed", bytesB, bytesA, `slide ${i + 1}`, i + 1))
      return
    }
    const openB = before.slice(sb.start, sb.node.openEnd)
    const openA = after.slice(sa.start, sa.node.openEnd)
    if (openB !== openA)
      out.push(bytesDiff("slide's own tag changed", openB, openA, `slide ${i + 1}`, i + 1))
    const seqA = sa.chunks.map((c) => c.key)
    if (seqA.join("|") !== cap.chunks.join("|")) {
      out.push({
        oracle: "minimal-diff",
        signature:
          seqA.length === cap.chunks.length
            ? "saved block order differs from the edited page"
            : "saved blocks differ from the edited page (added/removed)",
        message: `slide ${i + 1}: page shows [${cap.chunks.join(", ")}], source has [${seqA.join(", ")}]`,
        slide: i + 1,
      })
    }
    const orderSame = sb.chunks.map((c) => c.key).join("|") === seqA.join("|")
    const gb = gapsOf(before, sb)
    const ga = gapsOf(after, sa)
    if (orderSame && gb.join("\u0000") !== ga.join("\u0000"))
      out.push(
        bytesDiff(
          "whitespace between blocks changed",
          gb.join("¦"),
          ga.join("¦"),
          `slide ${i + 1}`,
          i + 1,
        ),
      )
    else if (ga.some((g) => g.trim()))
      out.push(
        bytesDiff("text between blocks", gb.join("¦"), ga.join("¦"), `slide ${i + 1}`, i + 1),
      )

    const byKey = new Map(sb.chunks.map((c) => [c.key, c]))
    const origPos = new Map(sb.chunks.map((c, k) => [c.key, k]))
    sa.chunks.forEach((ca, k) => {
      const cb = byKey.get(ca.key)
      if (!cb) return // reported by the sequence check
      const cbBytes = before.slice(cb.start, cb.end)
      const caBytes = after.slice(ca.start, ca.end)
      const paths = cap.changed[ca.key]
      if (!paths) {
        if (cbBytes !== caBytes) {
          const moved = origPos.get(ca.key) !== k
          out.push(
            bytesDiff(
              moved ? "moved block's bytes changed" : "untouched block changed",
              cbBytes,
              caBytes,
              `slide ${i + 1} ${ca.key}`,
              i + 1,
            ),
          )
        }
        return
      }
      if (cbBytes === caBytes) return
      const allowed = allowedRange(before, cb, paths)
      const d = diffWindow(cbBytes, caBytes)
      const from = d.prefix
      const to = cbBytes.length - d.suffix
      if (!allowed) {
        out.push({
          oracle: "harness",
          signature: "changed element path not found in source",
          message: `slide ${i + 1} ${ca.key}: paths ${JSON.stringify(paths)} did not resolve`,
          slide: i + 1,
        })
        return
      }
      if (from < allowed.from || to > allowed.to) {
        const f = bytesDiff(
          "edit reached bytes outside the edited element",
          cbBytes,
          caBytes,
          `slide ${i + 1} ${ca.key}`,
          i + 1,
        )
        f.message += ` (changed ${from}–${to} of the block, edited elements span ${allowed.from}–${allowed.to})`
        out.push(f)
      }
    })
  })
  return out
}

/** Union byte range (relative to the chunk) of the changed elements' ORIGINAL source. */
function allowedRange(
  src: string,
  chunk: SourceChunk,
  paths: number[][],
): { from: number; to: number } | null {
  let from = Number.POSITIVE_INFINITY
  let to = Number.NEGATIVE_INFINITY
  for (const p of paths) {
    const n = nodeAtPath(chunk.node, p)
    if (!n) return null
    // The element's content may change; its own tag may not unless it was replaced
    // wholesale, which a deeper path would not express — allow the element's span.
    from = Math.min(from, n.start - chunk.start)
    to = Math.max(to, n.end - chunk.start)
  }
  void src
  return { from, to }
}

export interface ArrangeEntry {
  /** Index of the slide in the pre-save source. */
  from: number
  dup: boolean
}

/** Stored bytes of a duplicated slide may differ from its source only in the ids the
 *  server re-stamps so structural edits on the copy stay unambiguous. */
const stripIds = (s: string) =>
  s
    .replace(/(data-derive-(?:region|node|owner|slide))="[^"]*"/g, '$1="*"')
    // The copy is not the deck's current slide, so it may drop the "on" state class.
    .replace(
      /^(<section\b[^>]*?\bclass=")([^"]*)"/,
      (_, open: string, cls: string) =>
        `${open}${cls
          .split(/\s+/)
          .filter((c) => c !== "on")
          .join(" ")}"`,
    )

export function checkArrange(
  before: string,
  after: string,
  model: ArrangeEntry[],
  beforeTexts: string[],
  renderedAfter: string[],
): Failure[] {
  const out: Failure[] = []
  const b = deckOf(before)
  const a = deckOf(after)
  out.push(
    ...checkWysiwyg(
      model.map((m) => beforeTexts[m.from] ?? ""),
      renderedAfter,
    ),
  )
  if (a.slides.length !== model.length) {
    out.push({
      oracle: "minimal-diff",
      signature: "slide count after arrange differs from the arrangement",
      message: `arranged ${model.length} slides, source has ${a.slides.length}`,
    })
    return out
  }
  const first = (d: typeof b) => d.slides[0] as SourceSlide
  const last = (d: typeof b) => d.slides[d.slides.length - 1] as SourceSlide
  if (before.slice(0, first(b).start) !== after.slice(0, first(a).start))
    out.push(
      bytesDiff(
        "bytes before the first slide changed",
        before.slice(0, first(b).start),
        after.slice(0, first(a).start),
        "document head",
      ),
    )
  if (before.slice(last(b).end) !== after.slice(last(a).end))
    out.push(
      bytesDiff(
        "bytes after the last slide changed",
        before.slice(last(b).end),
        after.slice(last(a).end),
        "document tail",
      ),
    )
  for (let i = 1; i < a.slides.length; i++) {
    const gap = after.slice(
      (a.slides[i - 1] as SourceSlide).end,
      (a.slides[i] as SourceSlide).start,
    )
    if (gap.trim())
      out.push(
        bytesDiff("non-whitespace between slides", "", gap, `between slides ${i} and ${i + 1}`),
      )
  }
  model.forEach((m, i) => {
    const sb = b.slides[m.from] as SourceSlide
    const sa = a.slides[i] as SourceSlide
    const bytesB = before.slice(sb.start, sb.end)
    const bytesA = after.slice(sa.start, sa.end)
    if (m.dup) {
      if (stripIds(bytesB) !== stripIds(bytesA))
        out.push(
          bytesDiff(
            "duplicated slide differs from its source",
            bytesB,
            bytesA,
            `slide ${i + 1}`,
            i + 1,
          ),
        )
    } else if (bytesB !== bytesA) {
      out.push(
        bytesDiff(
          m.from === i ? "unmoved slide's bytes changed" : "moved slide's bytes changed",
          bytesB,
          bytesA,
          `slide ${i + 1} (was ${m.from + 1})`,
          i + 1,
        ),
      )
    }
  })
  // A copy must not reuse the structural ids of its source (later structural edits
  // would find the region "authored twice").
  const regions = a.slides.map((s) => s.region).filter((r): r is string => !!r)
  const dupRegions = regions.filter((r, i) => regions.indexOf(r) !== i)
  const preexisting = new Set(
    b.slides.map((s) => s.region).filter((r, i, all) => r && all.indexOf(r) !== i),
  )
  const fresh = dupRegions.filter((r) => !preexisting.has(r))
  if (fresh.length)
    out.push({
      oracle: "minimal-diff",
      signature: "duplicated slide reuses its source's region id",
      message: `region ids appear twice after the save: ${[...new Set(fresh)].join(", ")}`,
    })
  return out
}

// ---------------------------------------------------------------------------------
// Markdown

/** A top-level Markdown block: a run of non-blank lines (a fenced code block may hold
 *  blank lines). Deliberately naive and independent of the renderer's parser — the doc
 *  fixture keeps one blank line between blocks, so its blocks map 1:1 onto the
 *  rendered page's top-level elements (the sanity spec checks that). */
export function mdBlocks(src: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let at = 0
  let open: { start: number; end: number } | null = null
  let fence: string | null = null
  while (at < src.length) {
    const nl = src.indexOf("\n", at)
    const end = nl < 0 ? src.length : nl
    const line = src.slice(at, end)
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = null
      if (open) open.end = end
    } else if (!line.trim()) open = null
    else {
      if (!open) {
        open = { start: at, end }
        out.push(open)
      } else open.end = end
      if (f) fence = f
    }
    at = end + 1
  }
  return out
}

/** Lines of a block, with their offsets. */
const linesOf = (src: string, b: { start: number; end: number }) => {
  const out: { start: number; end: number }[] = []
  let at = b.start
  while (at <= b.end) {
    const nl = src.indexOf("\n", at)
    const end = nl < 0 || nl > b.end ? b.end : nl
    out.push({ start: at, end })
    at = end + 1
  }
  return out
}

/** A list's or table's units as source text: a list item from its marker line through
 *  its continuation lines (a hard break, a wrapped line), a table row per line with
 *  the delimiter row skipped. In the doc fixture the i-th unit is the i-th <li> (depth
 *  first) or <tr>. */
const unitsOf = (src: string, b: { start: number; end: number }, table: boolean): string[] => {
  const lines = linesOf(src, b).map((l) => src.slice(l.start, l.end))
  if (table) return lines.filter((_, i) => i !== 1)
  const out: string[] = []
  for (const line of lines)
    if (/^\s*(?:[-+*]|\d{1,9}[.)])(?:\s|$)/.test(line) || !out.length) out.push(line)
    else out[out.length - 1] += `\n${line}`
  return out
}

/**
 * Which units (list items, table rows) of a list or table block an edited element may
 * touch: the unit that holds each edited element. `null` means the whole block (the
 * edit reached the list or table element itself, or the block is prose).
 */
function allowedUnits(chunk: HNode, paths: number[][]): Set<number> | null {
  const kind = chunk.tag === "ul" || chunk.tag === "ol" ? "li" : chunk.tag === "table" ? "tr" : null
  if (!kind) return null
  const units: HNode[] = []
  const walk = (n: HNode) => {
    for (const c of n.children) {
      if (c.tag === kind) units.push(c)
      walk(c)
    }
  }
  walk(chunk)
  const out = new Set<number>()
  for (const p of paths) {
    let n = nodeAtPath(chunk, p)
    while (n && n !== chunk && n.tag !== kind) n = n.parent
    if (!n || n === chunk) return null
    const i = units.indexOf(n)
    if (i < 0) return null
    out.add(i)
  }
  return out
}

/** Every entry of `before` not in `free` must appear in `after`, unchanged and in order,
 *  and whatever else `after` holds must sit where a free entry was. Returns where each
 *  kept entry landed (-1 for a free one) and the first entry that broke the rule. */
function keptInOrder(
  before: string[],
  after: string[],
  free: Set<number>,
): { at: number[]; broke: number } {
  const at = before.map(() => -1)
  let j = 0
  let pending = false
  for (let i = 0; i < before.length; i++) {
    if (free.has(i)) {
      pending = true
      continue
    }
    const k = after.indexOf(before[i] as string, j)
    if (k < 0 || (k > j && !pending)) return { at, broke: i }
    at[i] = k
    j = k + 1
    pending = false
  }
  return { at, broke: j < after.length && !pending ? before.length : -1 }
}

/**
 * Minimal diff for an inline edit on a Markdown doc. `renderedBefore` is the served
 * render of `before` (its <main> children are the page's top-level blocks), used only
 * to find which list item or table row an edited element path names.
 *
 * An edited block may be rewritten, split by Enter (the page shows the new block too),
 * or vanish (its words were all deleted: Markdown has no empty paragraph). Every block
 * nobody touched keeps its bytes, its order and the blank lines around it; inside an
 * edited list or table, every item or row nobody touched does too.
 */
export function checkMarkdownDiff(
  before: string,
  after: string,
  cap: DomSlideCapture,
  renderedBefore: string,
): Failure[] {
  const out: Failure[] = []
  const bb = mdBlocks(before)
  const ba = mdBlocks(after)
  if (cap.originalChunks.length !== bb.length) {
    out.push({
      oracle: "harness",
      signature: "markdown blocks do not map 1:1 onto the rendered page",
      message: `source has ${bb.length} blocks, the page showed ${cap.originalChunks.length}`,
    })
    return out
  }
  const touched = new Set(
    bb.map((_, i) => i).filter((i) => cap.changed[cap.originalChunks[i] as string]),
  )
  const expected = bb.length + cap.chunks.length - cap.originalChunks.length
  if (ba.length > expected || ba.length < expected - touched.size) {
    const d = diffWindow(before, after, 80)
    out.push({
      oracle: "minimal-diff",
      signature:
        ba.length > expected
          ? "an edit split a Markdown block (new block in the source)"
          : "an edit merged or removed a Markdown block",
      message: `source had ${bb.length} blocks, now ${ba.length}; the page shows ${cap.chunks.length} (loaded ${cap.originalChunks.length})`,
      excerpt: `before: ${d.a}\nafter : ${d.b}`,
    })
    return out
  }
  const bytes = (src: string, bs: { start: number; end: number }[]) =>
    bs.map((b) => src.slice(b.start, b.end))
  const kept = keptInOrder(bytes(before, bb), bytes(after, ba), touched)
  if (kept.broke >= 0) {
    const i = Math.min(kept.broke, bb.length - 1)
    const b = bb[i] as { start: number; end: number }
    out.push(
      bytesDiff(
        "untouched Markdown block changed",
        before.slice(b.start, b.end),
        after.slice(ba[i]?.start ?? after.length, ba[i]?.end ?? after.length),
        `block ${i + 1} (${cap.originalChunks[i]})`,
      ),
    )
    return out
  }
  // The blank lines between two untouched neighbours, and at either end, stay.
  const gap = (src: string, bs: { start: number; end: number }[], k: number) =>
    src.slice(k < 0 ? 0 : (bs[k] as { end: number }).end, bs[k + 1]?.start ?? src.length)
  for (let i = -1; i < bb.length; i++) {
    const a = i < 0 ? -1 : (kept.at[i] as number)
    const b = i + 1 < bb.length ? (kept.at[i + 1] as number) : ba.length
    if ((i >= 0 && a < 0) || (i + 1 < bb.length && b < 0) || b !== a + 1) continue
    if (gap(before, bb, i) !== gap(after, ba, a))
      out.push(
        bytesDiff(
          "blank lines between Markdown blocks changed",
          gap(before, bb, i),
          gap(after, ba, a),
          `after block ${i + 1}`,
        ),
      )
  }

  const main = (() => {
    const find = (n: HNode): HNode | null => {
      for (const c of n.children) {
        if (c.tag === "main") return c
        const hit = find(c)
        if (hit) return hit
      }
      return null
    }
    return find(parseHtml(renderedBefore))
  })()
  // Inside an edited list or table: the items and rows nobody touched.
  for (const i of touched) {
    const chunk = main?.children[i]
    const units = chunk
      ? allowedUnits(chunk, cap.changed[cap.originalChunks[i] as string] ?? [])
      : null
    if (!chunk || !units) continue
    const table = chunk.tag === "table"
    const b = bb[i] as { start: number; end: number }
    const ub = unitsOf(before, b, table)
    // The after blocks this one became: between where its untouched neighbours landed.
    let lo = -1
    for (let k = i - 1; k >= 0 && lo < 0; k--) lo = kept.at[k] ?? -1
    let hi = ba.length
    for (let k = i + 1; k < bb.length && hi === ba.length; k++)
      if ((kept.at[k] ?? -1) >= 0) hi = kept.at[k] as number
    // Of those, the one holding most of its untouched items or rows.
    const keep = ub.filter((_, k) => !units.has(k))
    let ua: string[] = []
    let most = 0
    for (const a of ba.slice(lo + 1, hi)) {
      const got = unitsOf(after, a, table)
      const n = keep.filter((u) => got.includes(u)).length
      if (n > most) [ua, most] = [got, n]
    }
    if (!most && !keep.length) continue
    const brokeUnit = keptInOrder(ub, ua, new Set(units)).broke
    if (brokeUnit >= 0)
      out.push(
        bytesDiff(
          table ? "an edit reached another table row" : "an edit reached another list item",
          ub[Math.min(brokeUnit, ub.length - 1)] ?? "",
          ua[Math.min(brokeUnit, ua.length - 1)] ?? "",
          `block ${i + 1} (${cap.originalChunks[i]}) ${table ? "row" : "item"} ${brokeUnit + 1}`,
        ),
      )
  }
  return out
}

/** Markdown with code (fenced or inline) blanked out, so tags shown as code don't count. */
const proseOf = (md: string) =>
  md.replace(/^(\s{0,3})(`{3,}|~{3,})[\s\S]*?^\s{0,3}\2[^\n]*$/gm, "").replace(/(`+)[^`]*?\1/g, "")
const TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g

/** No markup the editor didn't mean: the Markdown fuzz types no HTML (typed Markdown is
 *  source, so typed `<b>` would be live on purpose — see the inline-edit smoke), so an
 *  HTML tag that appears in the prose after a save came from the editor. */
export function checkMarkdownHtml(before: string, after: string): Failure[] {
  // The editor's own spellings where Markdown has none: a line break in a table cell
  // or a heading, and emphasis whose delimiters can't close where it sits (`**x.**y`).
  const tags = (md: string) =>
    (proseOf(md).match(TAG) ?? []).filter((t) => !/^<\/?(?:br|strong|em|del)\s*\/?>$/i.test(t))
  const was: string[] = tags(before)
  const now: string[] = tags(after)
  if (now.length <= was.length) return []
  const extra = now.filter((t) => !was.includes(t))
  const at = after.indexOf(extra[0] ?? now[now.length - 1] ?? "")
  return [
    {
      oracle: "artifacts",
      signature: "HTML entered the Markdown source as live markup",
      message: `${was.length} tag(s) in the prose before the save, ${now.length} after: ${extra.slice(0, 4).join(" ")}`,
      excerpt: after.slice(Math.max(0, at - 100), at + 100),
    },
  ]
}
