/**
 * The doc map: one derived address for every part of a document.
 *
 * Derive already had five ways to READ a part of a document (heading sections, line
 * windows, `@N` landmark regions, the big-doc region map, the `$outline` fact) and no way
 * to say "change THAT" — every edit was anchored by a string that had to be unique across
 * the whole file, which is exactly what fails on long or repetitive markup. This module is
 * the spine those lenses were missing: one structure, computed from the bytes, whose refs
 * name parts for reading now and for writing next.
 *
 * DERIVED, NEVER STORED. The author's bytes stay the only truth; the map is recomputed
 * from them per version, like facts, outlines, previews and deck typing already are. The
 * alternative (store a block model, render HTML from it) would make a fully-styled page
 * either illegal or smuggled inside JSON, and would migrate every artifact ever published.
 * A map computed from the source cannot disagree with the source.
 *
 * THE TILING INVARIANT: nodes are sorted by position and their spans tile the file, so
 * concatenating every node's source reproduces the document byte-for-byte. That is what
 * makes "replace this node" safe — the parts always reassemble into the whole — and it is
 * asserted over every fixture in the tests. Whitespace between two elements belongs to the
 * FOLLOWING node, so every node carries the separation that positions it and a reorder can
 * never strand indentation on the node that used to precede it.
 *
 * Depth 1 in v1: no children. A slide's inner sections are not nodes. Nesting is easy to
 * add later and impossible to remove once agents depend on it.
 */

import { countSlideElements, isDeckDocument, sliceSlides } from "./decks"
import { flatSectionSpans, isHtmlLike, landmarkSpans } from "./doc-text"
import { attrValue, elementEnd, type HtmlTag, tags } from "./html-tags"

/** What a node IS. Reorderable types (slide, section) are the ones a structural op may
 *  move; the rest are addressable for reading and replacing only. */
export type DocNodeType =
  | "head"
  | "slide"
  | "section"
  | "region"
  | "style"
  | "script"
  | "chrome"
  | "tail"
  | "body"

export interface DocNode {
  /** The address: `slide:2`, `sec:pricing`, `@3`, `style:1`, `doc:head`… */
  ref: string
  type: DocNodeType
  /** Offset of the node's first byte. Internal — never serialized. */
  start: number
  /** Offset just past its last byte. Internal — never serialized. */
  end: number
  /** Heading text, landmark label, or a slide's first heading. Clipped. */
  title?: string
  /** A slide's stable `data-derive-slide` value. */
  identity?: number
  /** A section's heading level. */
  level?: number
  /** The element's authored `id`, which makes `#id` an alias for this node. */
  id?: string
}

export interface DocMap {
  kind: "deck" | "page" | "markdown"
  nodes: DocNode[]
}

/** Ceiling on nodes in the SERIALIZED map, matching the `$outline` fact's cap: enough for
 *  a 200-section monster, small enough to stay far under the fact size limit. The in-memory
 *  map keeps every node so ref resolution never depends on the cap. */
export const MAX_MAP_NODES = 200

/** Titles are a glance, not content — the landmark preview's cap, for one reason to change. */
const TITLE_MAX = 80

const clip = (s: string): string =>
  s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1).trimEnd()}…` : s

/** The first heading's text inside a slide, so a deck's map reads like its outline. */
const slideTitle = (source: string): string | undefined => {
  const m = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(source)
  if (!m?.[1]) return undefined
  const text = m[1]
    .replace(/<[^<>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return text ? clip(text) : undefined
}

/** Top-level <style>/<script> elements that sit OUTSIDE every content node. Addressing the
 *  style block is what turns "make the whole deck warmer" into one replace instead of forty
 *  scattered edits. */
const assetBlocks = (
  all: HtmlTag[],
  inside: (start: number) => boolean,
): { type: DocNodeType; start: number; end: number }[] => {
  const out: { type: DocNodeType; start: number; end: number }[] = []
  for (let i = 0; i < all.length; i++) {
    const tag = all[i] as HtmlTag
    if (tag.closing || (tag.name !== "style" && tag.name !== "script")) continue
    if (inside(tag.start)) continue
    const end = elementEnd(all, i)
    if (end === -1) continue // unterminated: leave it to the surrounding node
    out.push({ type: tag.name === "style" ? "style" : "script", start: tag.start, end })
  }
  return out
}

/**
 * Map a document's structure. Never throws for an ordinary document: a page with no
 * headings, no landmarks and no slides maps to a single `doc:body` node, so `read node:`
 * is universal. It DOES propagate the slide slicer's refusals on a deck whose structure is
 * genuinely ambiguous (a slide nested in a slide, a slide that never closes) — guessing
 * there would put every later op on a wrong footing.
 */
export const docMap = (source: string, contentType: string): DocMap => {
  const html = isHtmlLike(contentType)
  // Slides are the content units when the document is a deck STRUCTURALLY, whether or not
  // it announces itself over the protocol.
  //
  // Keying this on `isDeckDocument` alone (which requires the announce) split the surface
  // in half on real published decks: a deck written before the protocol existed slices
  // into 23 slides for `slide_ops`, while the map called it a page and offered 71 heading
  // sections and no slide refs at all. Read and write have to agree about what a document
  // is made of, or an agent reading the map never learns it can rearrange.
  //
  // The two thresholds are the ones already in use, not new judgment: an announced deck
  // needs 2 slides (isDeckDocument), an unannounced one needs 3 (the same bar the publish
  // advisory uses before it calls a page a deck attempt), so an ordinary page that happens
  // to use a `slide` class twice stays a page.
  const slideStructured = html && (isDeckDocument(source) || countSlideElements(source) >= 3)
  const kind: DocMap["kind"] = html ? (slideStructured ? "deck" : "page") : "markdown"

  // 1. Content anchors: what the document is made of.
  const anchors: DocNode[] = []
  if (kind === "deck") {
    // A deck's slides ARE its content; headings inside them are slide titles, not sections.
    for (const s of sliceSlides(source)) {
      const src = source.slice(s.start, s.end)
      const openEnd = src.indexOf(">")
      const attrs = openEnd > 0 ? src.slice(0, openEnd) : ""
      anchors.push({
        ref: `slide:${s.position}`,
        type: "slide",
        start: s.start,
        end: s.end,
        ...(s.id !== null ? { identity: s.id } : {}),
        ...(slideTitle(src) ? { title: slideTitle(src) } : {}),
        ...(attrValue(attrs, "id") ? { id: attrValue(attrs, "id") as string } : {}),
      })
    }
  } else {
    const secs = flatSectionSpans(source, contentType)
    for (const s of secs) {
      const openEnd = source.slice(s.start, s.start + 400).indexOf(">")
      const attrs = html && openEnd > 0 ? source.slice(s.start, s.start + openEnd) : ""
      anchors.push({
        ref: `sec:${s.slug}`,
        type: "section",
        start: s.start,
        end: s.end,
        title: clip(s.text),
        level: s.level,
        ...(attrs && attrValue(attrs, "id") ? { id: attrValue(attrs, "id") as string } : {}),
      })
    }
    // No heading spine: fall back to the landmark regions the big-doc read already uses,
    // so a designed page with no headings is still addressable.
    if (!anchors.length && html) {
      let n = 0
      for (const r of landmarkSpans(source)) {
        n++
        const label = attrValue(r.attrs, "aria-label") ?? attrValue(r.attrs, "id")
        anchors.push({
          ref: `@${n}`,
          type: "region",
          start: r.start,
          end: r.end,
          ...(label ? { title: clip(label) } : {}),
          ...(attrValue(r.attrs, "id") ? { id: attrValue(r.attrs, "id") as string } : {}),
        })
      }
    }
  }

  // Nothing structural at all: ONE node covering the document, so every artifact has an
  // address and `read node:` never has a hole in it.
  if (!anchors.length)
    return { kind, nodes: [{ ref: "doc:body", type: "body", start: 0, end: source.length }] }

  // 2. Style/script blocks outside the content, addressable in their own right.
  const inAnchor = (pos: number) => anchors.some((a) => pos >= a.start && pos < a.end)
  const blocks = html ? assetBlocks(tags(source), inAnchor) : []
  let styles = 0
  let scripts = 0
  const blockNodes: DocNode[] = blocks.map((b) => ({
    ref: b.type === "style" ? `style:${++styles}` : `script:${++scripts}`,
    type: b.type,
    start: b.start,
    end: b.end,
  }))

  // 3. Tile. Everything between known spans becomes a node too, so the parts always
  //    reassemble into the whole file.
  const known = [...anchors, ...blockNodes].sort((a, b) => a.start - b.start)
  const nodes: DocNode[] = []
  let cursor = 0
  let chrome = 0
  for (const node of known) {
    if (node.start < cursor) continue // defensive: overlapping spans keep the first
    if (node.start > cursor) {
      const gap = source.slice(cursor, node.start)
      if (!nodes.length) {
        // The preamble: doctype, <head>, the opening <body> tag.
        nodes.push({ ref: "doc:head", type: "head", start: cursor, end: node.start })
      } else if (gap.trim() === "") {
        // Whitespace belongs to the FOLLOWING node, so a node's span starts at its own
        // first byte and a reorder can never strand indentation.
        node.start = cursor
      } else {
        // Anything else between two nodes: the closing `</head><body>` seam, a nav bar
        // parked between slides. Represented as its own node rather than folded into a
        // neighbour, because folding it would silently relocate it on a reorder.
        nodes.push({ ref: `chrome:${++chrome}`, type: "chrome", start: cursor, end: node.start })
      }
    }
    nodes.push(node)
    cursor = node.end
  }
  if (cursor < source.length)
    nodes.push({ ref: "doc:tail", type: "tail", start: cursor, end: source.length })
  return { kind, nodes }
}

/** The node a ref names, or null.
 *
 *  `#id` is an alias for whichever node carries that authored id, and is refused when two
 *  nodes claim it: an ambiguous address must fail loudly, never pick one. */
export const resolveNode = (map: DocMap, ref: string): DocNode | null => {
  const wanted = ref.trim()
  if (!wanted) return null
  if (wanted.startsWith("#")) {
    const id = wanted.slice(1)
    const hits = map.nodes.filter((n) => n.id === id)
    return hits.length === 1 ? (hits[0] as DocNode) : null
  }
  return map.nodes.find((n) => n.ref === wanted) ?? null
}

/** Every ref in the map, for an error that tells you what you could have said. */
export const refsOf = (map: DocMap): string[] => map.nodes.map((n) => n.ref)

/** The map as it goes over the wire: refs, never byte offsets.
 *
 *  Offsets stay server-side deliberately. They are an implementation detail that would
 *  otherwise become a contract, and a caller doing its own offset arithmetic is a caller
 *  that breaks the moment the mapper gets smarter. */
export const mapJson = (
  map: DocMap,
  version: number,
): {
  version: number
  kind: string
  bytes: number
  nodes: Record<string, unknown>[]
  truncated?: boolean
  total?: number
} => {
  const shown = map.nodes.slice(0, MAX_MAP_NODES)
  return {
    version,
    kind: map.kind,
    // The whole document's size, so "how big is this part of it" is answerable from the
    // map alone. Free, and exact, because the nodes tile the file: their spans sum to it.
    bytes: map.nodes.reduce((n, x) => n + (x.end - x.start), 0),
    nodes: shown.map((n) => ({
      ref: n.ref,
      type: n.type,
      bytes: n.end - n.start,
      ...(n.title ? { title: n.title } : {}),
      ...(n.identity !== undefined ? { identity: n.identity } : {}),
      ...(n.level !== undefined ? { level: n.level } : {}),
      ...(n.id ? { id: n.id } : {}),
    })),
    ...(map.nodes.length > MAX_MAP_NODES ? { truncated: true, total: map.nodes.length } : {}),
  }
}
