/**
 * The output side of the LaTeX renderer: one stream that grows the HTML, the visible-text
 * projection and the segment map that ties them to the source, in lockstep.
 *
 * The projection has to agree with `pageText(html)` (anchor.ts), which is what comment
 * re-anchoring and quote edits read for HTML: every tag collapses to one space, entities
 * decode to their character, everything else is text. So the emitter counts the tags in
 * each piece of markup it writes and records that many single-space gaps, writes source
 * characters 1:1 as `text` segments, and records everything it makes up (section numbers,
 * citation labels, ligatures, expanded macros) as `entity` segments over the source span
 * the reader would point at. A quote that lands on made-up text then maps to the macro
 * that produced it, and a quote that lands on prose maps to the prose.
 */

import type { BibEntry } from "./bibtex"
import type { LatexDiagnostic, LatexNode, MacroDefinition, ParsedLatex } from "./latex-parse"

/** Structurally identical to anchor.ts `PageTextSegment`; declared here so this module
 *  stays a leaf. */
export interface LatexTextSegment {
  kind: "text" | "entity" | "gap"
  tStart: number
  tEnd: number
  rStart: number
  rEnd: number
}

const escapeChar = (ch: string): string => {
  switch (ch) {
    case "&":
      return "&amp;"
    case "<":
      return "&lt;"
    case ">":
      return "&gt;"
    case '"':
      return "&quot;"
    default:
      return ch
  }
}

export const escapeHtmlText = (s: string): string => s.replace(/[&<>"]/g, escapeChar)

const TAG_COUNT = /<[!/]?[a-zA-Z][^>]*>/g

/** Mirrors anchor.ts BLOCK_TEXT_ELEMENTS (a test pins the two equal): the tags whose
 *  boundary pageText turns into a space. Every other tag is a zero-width gap. */
export const BLOCK_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "br",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "html",
  "li",
  "listing",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "xmp",
])

const tagName = (tag: string): string => {
  const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)
  return m ? (m[1] as string).toLowerCase() : ""
}

export class Emitter {
  html = ""
  text = ""
  segments: LatexTextSegment[] = []
  /** The source offset the next made-up gap is attributed to when the caller has none. */
  private cursor = 0
  /** While set, every character written maps onto this span as an entity: the text came
   *  from somewhere else (a macro body, a bundled file, a label), so the span of the
   *  construct that produced it is the honest source position. */
  private synth: { rStart: number; rEnd: number } | null = null

  /** Markup. `at` is the source position it stands for. Any text between the tags
   *  (a separator space, a slot's rendered cells) is projected as entities over that
   *  span, which keeps the projection in step with `pageText` of the page whatever the
   *  caller writes. Only the five entities our own renderers write are decoded; the
   *  input is trusted markup, never user text. */
  markup(html: string, at?: number | [number, number]): void {
    if (!html) return
    const span: [number, number] = this.synth
      ? [this.synth.rStart, this.synth.rEnd]
      : at === undefined
        ? [this.cursor, this.cursor]
        : typeof at === "number"
          ? [at, at]
          : at
    let last = 0
    for (const m of html.matchAll(TAG_COUNT)) {
      const i = m.index ?? 0
      if (i > last) this.decodedEntity(html.slice(last, i), span[0], span[1])
      this.html += m[0]
      this.gap(span[0], span[1], BLOCK_TEXT_ELEMENTS.has(tagName(m[0])))
      last = i + m[0].length
    }
    if (last < html.length) this.decodedEntity(html.slice(last), span[0], span[1])
  }

  /** A block tag boundary is one space in the projection; an inline tag is a
   *  zero-width gap (recorded so an edit that crosses it is seen to cross markup). */
  private gap(rStart: number, rEnd: number, space: boolean): void {
    const tStart = this.text.length
    if (space) this.text += " "
    this.segments.push({ kind: "gap", tStart, tEnd: tStart + (space ? 1 : 0), rStart, rEnd })
    this.cursor = Math.max(this.cursor, rEnd)
  }

  /** Source characters, verbatim: `value === source.slice(rStart, rStart + value.length)`. */
  text_(value: string, rStart: number): void {
    if (!value) return
    if (this.synth) {
      this.entity(value, this.synth.rStart, this.synth.rEnd)
      return
    }
    this.html += escapeHtmlText(value)
    const tStart = this.text.length
    this.text += value
    this.segments.push({
      kind: "text",
      tStart,
      tEnd: tStart + value.length,
      rStart,
      rEnd: rStart + value.length,
    })
    this.cursor = rStart + value.length
  }

  /** Characters the source does not spell this way (a ligature, a symbol macro, a section
   *  number): one entity segment per code point, all over the producing span. */
  entity(value: string, rStart: number, rEnd: number): void {
    if (!value) return
    const span = this.synth ?? { rStart, rEnd }
    this.html += escapeHtmlText(value)
    for (const ch of value) {
      const tStart = this.text.length
      this.text += ch
      this.segments.push({
        kind: "entity",
        tStart,
        tEnd: tStart + ch.length,
        rStart: span.rStart,
        rEnd: span.rEnd,
      })
    }
    this.cursor = Math.max(this.cursor, span.rEnd)
  }

  /** A no-break space: `&nbsp;` in the markup, U+00A0 in the projection (what pageText
   *  decodes it to). */
  nbsp(rStart: number, rEnd: number): void {
    const span = this.synth ?? { rStart, rEnd }
    this.html += "&nbsp;"
    const tStart = this.text.length
    this.text += " "
    this.segments.push({
      kind: "entity",
      tStart,
      tEnd: tStart + 1,
      rStart: span.rStart,
      rEnd: span.rEnd,
    })
    this.cursor = Math.max(this.cursor, span.rEnd)
  }

  private decodedEntity(escaped: string, rStart: number, rEnd: number): void {
    const decoded = escaped
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
    this.html += escaped
    for (const ch of decoded) {
      const tStart = this.text.length
      this.text += ch
      this.segments.push({ kind: "entity", tStart, tEnd: tStart + ch.length, rStart, rEnd })
    }
    this.cursor = Math.max(this.cursor, rEnd)
  }

  /** Run `fn` with every character it writes attributed to [rStart, rEnd). Nested calls
   *  keep the outermost span, since that is the construct in the source the reader sees. */
  withSynthSpan(rStart: number, rEnd: number, fn: () => void): void {
    if (this.synth) {
      fn()
      return
    }
    this.synth = { rStart, rEnd }
    try {
      fn()
    } finally {
      this.synth = null
    }
  }

  get inSynth(): boolean {
    return this.synth !== null
  }

  /** The current HTML length, for callers that need to know whether anything was
   *  written between two points. */
  get length(): number {
    return this.html.length
  }

  /** Attribute the next positionless gap to `at`. */
  moveCursor(at: number): void {
    this.cursor = at
  }
}

export type ClassKind = "acm" | "cvpr" | "generic"

export interface ClassProfile {
  kind: ClassKind
  documentClass: string
  /** acmart `format` after aliasing (`siggraph` is `sigconf`), else null. */
  format: string | null
  /** Journal-style formats label floats `Fig. 1.`; proceedings use `Figure 1:`. */
  journal: boolean
  anonymous: boolean
  review: boolean
  /** Whether natbib compresses `[1, 2, 3]` to `[1-3]`. */
  compressCitations: boolean
  /** Which reference formatter approximates the class's `.bst`. */
  bibStyle: "acm" | "ieeenat" | "plain"
}

export interface LabelTarget {
  /** The text `\ref` prints (`2.1`, `3`, `(4)` for equations without the parens). */
  number: string
  /** What the label points at, for `\cref` wording and `\eqref` parentheses. */
  kind: "section" | "figure" | "table" | "equation" | "theorem" | "item" | "algorithm" | "other"
  /** The HTML id a `\ref` links to. */
  id: string
}

export interface LatexHeading {
  level: number
  text: string
  slug: string
  /** 1-based source line of the sectioning macro. */
  line: number
  /** Source offset of the macro. */
  start: number
  numbered: boolean
}

export interface LatexBindingRef {
  name: string
  kind: "table" | "figure"
  /** Source span of the `\derivetable` / `\derivefigure` macro. */
  start: number
  end: number
}

export interface DynamicTableLike {
  columns: { key: string; label?: string; align?: "left" | "center" | "right" }[]
  rows: Record<string, string | number | null>[]
}
export interface DynamicFigureLike {
  url: string | null
  caption?: string
  alt?: string
  width?: number
  height?: number
}
export type DynamicValueLike =
  | { kind: "table"; table: DynamicTableLike }
  | { kind: "figure"; figure: DynamicFigureLike }

export interface RenderOptions {
  /** Deduplicating heading slugger (doc-text.ts `headingSlugger()`), so section ids agree
   *  with the outline and section reads. */
  slug: (text: string) => string
  /** Current dynamic slot values of the version being served, by name. */
  dynamic?: ReadonlyMap<string, DynamicValueLike>
  /** Text of a bundled file by bundle-relative path (`sec/intro.tex`, `refs.bib`,
   *  `main.bbl`), or null when the bundle has no such file. Single files pass nothing. */
  resolve?: (path: string) => string | null
  /** A served URL for a bundle-relative image path, or null when it does not exist. */
  imageUrl?: (path: string) => string | null
  /** BibTeX sources when the caller already has them (single-file artifacts cannot
   *  resolve `\bibliography{refs}`; a future upload path can hand the text in). */
  bibtex?: string
}

/** The reference list of one document: the cited (and `\nocite`d) entries in the order
 *  the style prints them, with each key's 1-based number. */
export interface Bibliography {
  entries: BibEntry[]
  index: Map<string, number>
  byKey: Map<string, BibEntry>
}

export interface FloatState {
  kind: "figure" | "table" | "algorithm"
  number: string
  id: string
  /** What `\caption` prints before the text (`Figure 1: `, `(a) `). */
  captionLabel: string
  /** The `\Description{}` text of the float, used as image alt. */
  description: string | null
  /** Sub-float counter for `subfigure` / `\subfloat`. */
  sub: number
}

export interface RenderContext {
  src: string
  out: Emitter
  parsed: ParsedLatex
  profile: ClassProfile
  opts: RenderOptions
  pass: 1 | 2
  defs: Map<string, MacroDefinition>
  labels: Map<string, LabelTarget>
  headings: LatexHeading[]
  bindings: LatexBindingRef[]
  diagnostics: LatexDiagnostic[]
  counters: Record<string, number>
  /** The most recent numbered thing, so a following `\label` knows what it names. */
  labelTarget: LabelTarget | null
  float: FloatState | null
  /** Names of theorem-like environments declared with `\newtheorem`: name -> title. */
  theorems: Map<string, { title: string; counter: string }>
  /** `p` while a `<p>` is open, `implicit` inside a container that holds inline text
   *  without one (a list item, a theorem head); block constructs close either, inline
   *  text opens a `<p>` only from `none`. */
  paragraph: "none" | "p" | "implicit"
  /** Depth of inline-only containers (headings, captions, cells) where paragraphs are
   *  not opened. */
  inlineDepth: number
  /** Expansion guards for user macros. */
  expansionDepth: number
  expansionBytes: number
  /** Citation bookkeeping: keys in first-cited order (pass 1), and resolved labels. */
  cited: Map<string, number>
  nocite: Set<string>
  bibFiles: string[]
  bibItems: Map<string, { label: string | null; index: number; id: string }>
  /** Built between the passes from the `.bib` files pass 1 saw cited; null when the
   *  document has no bibliography. */
  bibliography: Bibliography | null
  /** One unknown-macro diagnostic per name, not per use. */
  unknownMacros: Set<string>
  /** Walk children as block content (paragraphs open and close as needed). */
  walk: (nodes: LatexNode[]) => void
  /** Walk children as inline content only (inside headings, captions, cells). */
  inline: (nodes: LatexNode[]) => void
  ensureParagraph: (at: number) => void
  closeParagraph: (at: number) => void
  /** Plain text of nodes (labels, ids, alt text): no markup, no projection. */
  textOf: (nodes: LatexNode[]) => string
  diag: (code: string, message: string, at: number) => void
  lineAt: (at: number) => number
}

/** Counter increment with per-kind resets (a new section resets subsections). */
export const step = (ctx: RenderContext, name: string): number => {
  const next = (ctx.counters[name] ?? 0) + 1
  ctx.counters[name] = next
  return next
}

export const numberOf = (ctx: RenderContext, name: string): number => ctx.counters[name] ?? 0

/** Attribute-safe text: escaped, and with the quotes that would end an attribute. */
export const attr = (s: string): string => escapeHtmlText(s).replace(/'/g, "&#39;")

/** Marks a region the in-page editor must not arm: math, tables, images, generated
 *  labels and numbers, the author block, the reference list. The frame reads the
 *  attribute; an HTML author can set it by hand. It never touches the text projection. */
export const READONLY_ATTR = ' data-derive-readonly="1"'
