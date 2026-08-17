// Presenting stored artifact content to an AI consumer: HTML → structured Markdown,
// a heading outline with stable slugs, raw section slices those slugs address, and
// exact-match edits. `anchor.ts` is about MATCHING text (comment quotes); this module
// is about READING and REVISING it — the shared piece is the entity decoder.
//
// Everything here is dependency-free and DOM-free (no jsdom/turndown — the api must
// run on the Workers tier). The vocabulary is bounded: artifact HTML is either our
// own markdown render (the `sanitizeHtml` whitelist in md.ts) or agent-authored
// reports using the same block tags, so a tokenizer over that tag set is small and
// testable — the same trade `pageText`/`reflow.ts` already make.

import { decodeEntities, pageText } from "./anchor"
import { isHtmlLike } from "./content-types"

export { isAuthoredFactType, isHtmlLike } from "./content-types"

/** One heading in a document's h1–h6 spine. `chars` is the section's raw-source size
 *  (heading included) — a cheap budget proxy for what reading that section costs. */
export interface OutlineSection {
  level: number
  text: string
  slug: string
  chars: number
}

/** One structural landmark of a page with no heading spine (a dashboard, card grid,
 *  or landing page): enough to orient an agent that then searches/windows into it.
 *  `text` is a short visible-text preview (so an unlabelled region is still
 *  recognizable); `chars` is the size of the region's full visible text. */
export interface LandmarkRegion {
  role: string
  label: string | null
  text: string
  chars: number
}

/** One exact-match replacement (the Edit-tool contract: unique match or error). */
export interface DocEdit {
  old_str: string
  new_str: string
  /** 1-based index of WHICH match to replace, for an `old_str` that is intentionally
   *  non-unique (a phrase repeated verbatim in several spots). Omit when `old_str`
   *  already matches exactly once — this only disambiguates a multi-match. */
  occurrence?: number
}

// ---------------------------------------------------------------------------------
// Slugs

/** GitHub-style heading slug: lowercase, keep letters/numbers/space/hyphen/underscore,
 *  spaces → hyphens. No length cap (headings must stay unambiguous — unlike the
 *  URL-oriented `ids.slugify`). Dedup across a document via `Slugger`. */
export const headingSlug = (text: string): string =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]+/gu, "")
    .trim()
    .replace(/[ _]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")

/** Per-document slug dedup: second "goals" becomes "goals-1", then "goals-2" … */
const slugger = () => {
  const seen = new Map<string, number>()
  return (text: string): string => {
    const base = headingSlug(text) || "section"
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}-${n}`
  }
}

// ---------------------------------------------------------------------------------
// HTML tokenizer (shared by the converter and the heading scanner)

interface Tag {
  name: string
  attrs: string
  closing: boolean
  selfClosing: boolean
  start: number
  end: number
}

// Comments, declarations (<!DOCTYPE …>), and element tags. Linear by construction
// (js/polynomial-redos): no inner loop may cross a "<", so a false start never re-scans
// what the next attempt will scan again. The comment alternative admits "<" only when it
// isn't opening another comment; the cost is that a (malformed) comment containing a
// literal "<!--" no longer swallows through it, and a tag whose quoted attribute value
// contains a raw "<" (legal but rare — spec says escape it) tokenizes at the inner "<".
const TOKEN = /<!--[^<]*(?:<(?!!--)[^<]*)*-->|<![^<>]*>|<\/?[a-zA-Z][^<>]*>/g

const parseTag = (raw: string, start: number): Tag | null => {
  // By hand, not by regex: the old /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*?)(\/?)>$/ left
  // the name/attrs boundary ambiguous — quadratic on a tag that never closes
  // (js/polynomial-redos). raw comes from TOKEN, but nothing here assumes it.
  if (raw[0] !== "<" || raw[raw.length - 1] !== ">") return null
  const closing = raw[1] === "/"
  const nameStart = closing ? 2 : 1
  if (!/[a-zA-Z]/.test(raw[nameStart] ?? "")) return null
  let i = nameStart + 1
  while (i < raw.length - 1 && /[a-zA-Z0-9-]/.test(raw[i] as string)) i++
  const selfClosing = raw[raw.length - 2] === "/" && raw.length - 2 >= i
  return {
    name: raw.slice(nameStart, i).toLowerCase(),
    attrs: raw.slice(i, selfClosing ? raw.length - 2 : raw.length - 1),
    closing,
    selfClosing,
    start,
    end: start + raw.length,
  }
}

const attrOf = (attrs: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs)
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null
}

// Subtrees an agent never wants: layout, behavior, vector art, fallbacks.
const DROP = new Set(["head", "style", "script", "noscript", "svg", "template", "iframe"])
// Void tags that never close (outside the ones we render specially).
const IGNORE_VOID = new Set(["meta", "link", "base", "input", "source", "track", "wbr", "col"])
// Block-level tags: meaningless inside a pipe-table cell (that syntax can't hold block
// content). A SINGLE dispatch-point check against this set — rather than a per-case
// guard sprinkled through the switch below — means a future block tag added to the
// switch can't reintroduce the table-corruption bug class this set exists to prevent:
// flushing the wrong buffer, or (worse) a mode-switching tag like `pre` capturing
// subsequent cell tokens into a fenced block pushed straight into the document's
// top-level output, splitting the table mid-render.
const BLOCK_ONLY = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "figure",
  "figcaption",
  "aside",
  "details",
  "summary",
  "dl",
  "dt",
  "dd",
  "hr",
  "blockquote",
  "ul",
  "ol",
  "li",
  "pre",
])

// ---------------------------------------------------------------------------------
// HTML → Markdown

const collapse = (s: string) => s.replace(/[ \t\r\n]+/g, " ")

/** Wrap inline-code content in enough backticks that its own backtick runs survive. */
const codeSpan = (s: string): string => {
  const runs = s.match(/`+/g)
  const fence = "`".repeat((runs ? Math.max(...runs.map((r) => r.length)) : 0) + 1)
  const pad = s.startsWith("`") || s.endsWith("`") || s === "" ? " " : ""
  return `${fence}${pad}${s}${pad}${fence}`
}

/** Fence long enough that the block's own backtick runs survive. */
const fenceFor = (s: string): string => {
  const runs = s.match(/`{3,}/g)
  return "`".repeat(Math.max(3, ...(runs ? runs.map((r) => r.length + 1) : [3])))
}

const langOf = (attrs: string): string => {
  const cls = attrOf(attrs, "class") ?? ""
  const m = /(?:^|\s)(?:language|lang)-([\w+-]+)/.exec(cls)
  return m ? (m[1] as string) : ""
}

/**
 * Structure-preserving HTML → Markdown for the artifact vocabulary: headings, lists
 * (nested, ordered counters), tables (pipe, alignment), fenced code (language tag,
 * entities decoded, newlines preserved), blockquotes, links, images, emphasis, hr.
 * Unknown tags are transparent (tag dropped, text kept); DROP subtrees vanish whole.
 * Real newlines throughout — a minified one-line document comes out multi-line.
 */
export function htmlToMarkdown(html: string): string {
  const out: string[] = []
  let inline = ""
  let quoteDepth = 0
  const listStack: { ordered: boolean; index: number }[] = []
  let headingLevel = 0
  let itemPrefix = "" // pending "- " / "3. " for the innermost open <li>

  // pre / inline-code state
  let pre: { lang: string; buf: string } | null = null
  const codeStarts: number[] = [] // inline `<code>` open offsets into `inline`
  const linkHrefs: (string | null)[] = []

  // table state
  let table: { rows: string[][]; aligns: string[]; row: string[] | null; cell: boolean } | null =
    null

  const blockPrefix = () => {
    const quote = "> ".repeat(quoteDepth)
    if (!listStack.length) return quote
    const indent = "  ".repeat(listStack.length - 1)
    const lead = itemPrefix || "  ".repeat(1) // continuation inside an li aligns under it
    return quote + indent + lead
  }

  // A table cell is a flat inline run (pipe-table syntax can't hold block content),
  // so every "current buffer" operation — appending text, wrapping <code> — must
  // target the active cell instead of the top-level `inline` string whenever one is
  // open. Without this, a <code> (or any inline tag) inside a <td> silently loses
  // its wrapping (the open/close pair reads/writes the wrong buffer, leaking stale
  // fragments after the table), and a stray block tag (<p>, <div>, a heading) inside
  // a cell — real HTML the sanitizer permits — would flush the WRONG buffer straight
  // into the document's top-level `out` array, corrupting the table structure.
  const activeCell = (): string[] | null => (table?.cell && table.row?.length ? table.row : null)
  const inCell = () => activeCell() !== null

  const bufGet = (): string => {
    const cell = activeCell()
    return cell ? (cell[cell.length - 1] as string) : inline
  }
  const bufSet = (s: string) => {
    const cell = activeCell()
    if (cell) cell[cell.length - 1] = s
    else inline = s
  }

  const flush = () => {
    // Block structure (paragraphs, headings, lists, quotes) has no meaning inside a
    // pipe-table cell — skip the out-array push/reset; the cell's accumulated text
    // stays put and inline runs (its own tags) keep going through `append`.
    if (inCell()) return
    const text = inline.replace(/[ \t]+/g, " ").trim()
    inline = ""
    codeStarts.length = 0
    if (!text) return
    // <br> hard breaks arrive as \n in the buffer; keep them, trim each line.
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l, i, a) => l || (i > 0 && i < a.length - 1))
    const prefix = blockPrefix()
    const cont = itemPrefix ? "> ".repeat(quoteDepth) + "  ".repeat(listStack.length) : prefix
    out.push(lines.map((l, i) => (i === 0 ? prefix : cont) + l).join("\n"))
    itemPrefix = ""
  }

  const append = (s: string) => {
    const cell = activeCell()
    if (cell) cell[cell.length - 1] += s
    else inline += s
  }

  const dropStack: string[] = []
  TOKEN.lastIndex = 0
  let last = 0
  let m = TOKEN.exec(html)
  const emitText = (raw: string) => {
    if (dropStack.length || !raw) return
    if (pre) {
      pre.buf += decodeEntities(raw)
    } else if (raw.trim() || /[ \t\r\n]/.test(raw)) {
      const text = decodeEntities(collapse(raw))
      if (text !== " " || inline || table?.cell) append(text)
    }
  }

  while (true) {
    const chunkEnd = m ? m.index : html.length
    emitText(html.slice(last, chunkEnd))
    if (!m) break
    last = TOKEN.lastIndex
    const raw = m[0]
    m = TOKEN.exec(html)
    if (raw.startsWith("<!")) continue
    const tag = parseTag(raw, chunkEnd)
    if (!tag) continue

    // Dropped subtrees: track depth of the SAME tag so nesting can't leak content.
    if (dropStack.length) {
      if (tag.name === dropStack[dropStack.length - 1]) {
        if (tag.closing) dropStack.pop()
        else if (!tag.selfClosing) dropStack.push(tag.name)
      }
      continue
    }
    if (DROP.has(tag.name)) {
      if (!tag.closing && !tag.selfClosing) dropStack.push(tag.name)
      continue
    }
    if (IGNORE_VOID.has(tag.name)) continue

    // Whole-block <pre> capture (tags inside are highlight spans — text only).
    if (pre) {
      if (tag.name === "pre" && tag.closing) {
        const body = pre.buf.replace(/^\n/, "").replace(/\n[ \t]*$/, "")
        const fence = fenceFor(body)
        out.push(`${blockPrefix()}${fence}${pre.lang}\n${body}\n${fence}`)
        itemPrefix = ""
        pre = null
      } else if (tag.name === "code" && !tag.closing && !pre.lang) {
        pre.lang = langOf(tag.attrs)
      } else if (tag.name === "br") {
        pre.buf += "\n"
      }
      continue
    }

    // A block-level tag has no meaning inside a table cell (pipe-table syntax can't
    // hold one): ignore its structural effect entirely — its own text still reaches
    // the cell as plain text via the normal emitText/append path. One check up front
    // instead of a guard duplicated per switch case (see BLOCK_ONLY's comment).
    if (inCell() && BLOCK_ONLY.has(tag.name)) continue

    switch (tag.name) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        if (!tag.closing) {
          flush()
          headingLevel = Number(tag.name[1])
        } else {
          const text = inline.replace(/[ \t]+/g, " ").trim()
          inline = ""
          if (text) out.push(`${"> ".repeat(quoteDepth)}${"#".repeat(headingLevel)} ${text}`)
          headingLevel = 0
        }
        break
      }
      case "p":
      case "div":
      case "section":
      case "article":
      case "header":
      case "footer":
      case "main":
      case "figure":
      case "figcaption":
      case "aside":
      case "details":
      case "summary":
      case "dl":
      case "dt":
      case "dd":
        flush()
        break
      case "br":
        append("\n")
        break
      case "hr":
        flush()
        out.push(`${blockPrefix()}---`)
        itemPrefix = ""
        break
      case "blockquote":
        flush()
        quoteDepth = Math.max(0, quoteDepth + (tag.closing ? -1 : 1))
        break
      case "ul":
      case "ol":
        flush()
        if (!tag.closing) listStack.push({ ordered: tag.name === "ol", index: 0 })
        else listStack.pop()
        break
      case "li": {
        flush()
        if (!tag.closing) {
          const top = listStack[listStack.length - 1]
          itemPrefix = top?.ordered ? `${++top.index}. ` : "- "
        }
        break
      }
      case "pre":
        if (!tag.closing) {
          flush()
          pre = { lang: langOf(tag.attrs), buf: "" }
        }
        break
      case "code": {
        if (!tag.closing) {
          codeStarts.push(bufGet().length)
        } else {
          const start = codeStarts.pop()
          if (start !== undefined) {
            const buf = bufGet()
            const body = buf.slice(start)
            bufSet(buf.slice(0, start) + codeSpan(body.trim()))
          }
        }
        break
      }
      case "strong":
      case "b":
        append("**")
        break
      case "em":
      case "i":
        append("*")
        break
      case "del":
      case "s":
      case "strike":
        append("~~")
        break
      case "a": {
        if (!tag.closing) {
          const href = attrOf(tag.attrs, "href")
          const usable = href && !href.startsWith("javascript:") ? href : null
          linkHrefs.push(usable)
          if (usable) append("[")
        } else {
          const href = linkHrefs.pop()
          if (href) append(`](${href})`)
        }
        break
      }
      case "img": {
        const src = attrOf(tag.attrs, "src") ?? ""
        const alt = attrOf(tag.attrs, "alt") ?? ""
        if (src) append(`![${alt}](${src})`)
        break
      }
      // Tables ------------------------------------------------------------------
      case "table":
        if (!tag.closing) {
          flush()
          table = { rows: [], aligns: [], row: null, cell: false }
        } else if (table) {
          const rows = table.rows.filter((r) => r.length)
          if (rows.length) {
            const width = Math.max(...rows.map((r) => r.length))
            const norm = rows.map((r) => [...r, ...Array(width - r.length).fill("")])
            const clean = (c: string) => collapse(c).trim().replace(/\|/g, "\\|")
            const line = (r: string[]) => `| ${r.map(clean).join(" | ")} |`
            const aligns = table.aligns
            const sep = `| ${Array.from({ length: width }, (_, i) => aligns[i] ?? "---").join(" | ")} |`
            const p = blockPrefix()
            out.push(
              [line(norm[0] as string[]), sep, ...norm.slice(1).map(line)]
                .map((l) => p + l)
                .join("\n"),
            )
            itemPrefix = ""
          }
          table = null
        }
        break
      case "tr":
        if (table) {
          if (!tag.closing) table.row = []
          else if (table.row) {
            table.rows.push(table.row)
            table.row = null
          }
        }
        break
      case "th":
      case "td":
        if (table?.row) {
          if (!tag.closing) {
            table.row.push("")
            table.cell = true
            if (table.rows.length === 0) {
              const align = (attrOf(tag.attrs, "align") ?? "").toLowerCase()
              table.aligns.push(
                align === "center"
                  ? ":---:"
                  : align === "right"
                    ? "---:"
                    : align === "left"
                      ? ":---"
                      : "---",
              )
            }
          } else {
            table.cell = false
          }
        }
        break
      default:
        // Unknown tags (span, mark, sup, sub, thead, tbody, …) are transparent.
        break
    }
  }
  flush()
  return out.join("\n\n").trim()
}

// ---------------------------------------------------------------------------------
// Heading spans → outline + raw section slices (HTML side)

interface HeadingSpan {
  level: number
  text: string
  slug: string
  start: number // offset of the heading's opening "<hN"
}

const HEADING = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
// A DROP subtree with its full content — same tag set htmlToMarkdown drops whole.
// Used to mask out `<script>`/`<template>`/… content before scanning for headings,
// since the regex scan below has no tokenizer state and would otherwise happily
// match an `<h2>` sitting inside a script string or an unrendered template.
const DROP_SUBTREE = new RegExp(`<(${[...DROP].join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi")

const headingSpans = (html: string): HeadingSpan[] => {
  const slug = slugger()
  const spans: HeadingSpan[] = []
  // Ranges to exclude: a heading whose match starts inside one of these never became
  // part of the rendered document, so it must not become an outline entry (whose
  // sectionSlice would then start mid-subtree — see the DROP_SUBTREE comment above).
  const dropRanges: [number, number][] = []
  DROP_SUBTREE.lastIndex = 0
  for (let dm = DROP_SUBTREE.exec(html); dm; dm = DROP_SUBTREE.exec(html))
    dropRanges.push([dm.index, dm.index + dm[0].length])
  const inDropRange = (pos: number) => dropRanges.some(([s, e]) => pos >= s && pos < e)

  HEADING.lastIndex = 0
  for (let m = HEADING.exec(html); m; m = HEADING.exec(html)) {
    if (inDropRange(m.index)) continue
    // [^<>] not [^>]: a strip that can scan across the next "<" is quadratic on a run
    // of open brackets (js/polynomial-redos). A tag containing a raw "<" is malformed
    // anyway — failing to strip it beats scanning the rest of the heading for it.
    const text = collapse(decodeEntities((m[2] as string).replace(/<[^<>]+>/g, " "))).trim()
    if (!text) continue
    spans.push({ level: Number(m[1]), text, slug: slug(text), start: m.index })
  }
  return spans
}

const sectionEnd = (html: string, spans: HeadingSpan[], i: number): number => {
  const level = (spans[i] as HeadingSpan).level
  for (let j = i + 1; j < spans.length; j++) {
    const next = spans[j] as HeadingSpan
    if (next.level <= level) return next.start
  }
  const body = html.lastIndexOf("</body>")
  return body > (spans[i] as HeadingSpan).start ? body : html.length
}

// Structural landmarks that orient a page with no heading spine. A landmark nested
// inside another is folded into its parent, so the map stays shallow. The role is the
// element's implicit ARIA landmark role (what an accessibility tree would report) so
// the map reads like the aria snapshots agents already know; an explicit `role`
// attribute overrides it. header/footer map to banner/contentinfo, correct at the top
// level (the only level surfaced here).
const IMPLICIT_ROLE: Record<string, string> = {
  main: "main",
  nav: "navigation",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  section: "region",
  article: "article",
  form: "form",
}
/** The lowercase landmark tag names, exported so the marked-render overlay script
 *  (marks-script.ts) numbers the SAME top-level elements this module's landmarkMap
 *  does — one list, not two that could drift. */
export const LANDMARK_TAGS: string[] = Object.keys(IMPLICIT_ROLE)
const LANDMARK = new Set(LANDMARK_TAGS)

// Top-level landmark spans, balanced-matched by tag name (so nested same-name tags
// don't close a parent early). Drop-subtree content is masked out first, exactly like
// the heading scan, so a landmark tag inside a <template>/<script> is never surfaced.
/** Top-level landmark element spans, exported so the doc map addresses the SAME regions
 *  `landmarkMap` previews and `landmarkSlice` returns. */
export const landmarkSpans = (
  html: string,
): { name: string; attrs: string; start: number; end: number }[] => {
  const drop: [number, number][] = []
  DROP_SUBTREE.lastIndex = 0
  for (let dm = DROP_SUBTREE.exec(html); dm; dm = DROP_SUBTREE.exec(html))
    drop.push([dm.index, dm.index + dm[0].length])
  const inDrop = (p: number) => drop.some(([s, e]) => p >= s && p < e)

  const out: { name: string; attrs: string; start: number; end: number }[] = []
  const stack: { name: string; attrs: string; start: number }[] = []
  TOKEN.lastIndex = 0
  for (let m = TOKEN.exec(html); m; m = TOKEN.exec(html)) {
    if (inDrop(m.index)) continue
    const tag = parseTag(m[0] as string, m.index)
    if (!tag || !LANDMARK.has(tag.name) || tag.selfClosing) continue
    if (!tag.closing) {
      stack.push({ name: tag.name, attrs: tag.attrs, start: tag.start })
      continue
    }
    // A close tag pops the nearest matching open, discarding any unclosed tags above
    // it. A top-level landmark (opened at stack bottom) becomes a map entry.
    for (let i = stack.length - 1; i >= 0; i--) {
      if ((stack[i] as { name: string }).name !== tag.name) continue
      const open = stack[i] as { name: string; attrs: string; start: number }
      stack.length = i
      if (i === 0) out.push({ name: open.name, attrs: open.attrs, start: open.start, end: tag.end })
      break
    }
  }
  return out
}

/** The structural map of an HTML page with no headings — a fallback so a designed,
 *  headless page (dashboard, card grid) still orients an agent, who then searches or
 *  windows into a region. Empty when there is no landmark structure either. */
const LANDMARK_PREVIEW = 80
export function landmarkMap(html: string): LandmarkRegion[] {
  return landmarkSpans(html).map((s) => {
    const visible = pageText(html.slice(s.start, s.end))
    const preview = collapse(visible).trim()
    return {
      role: attrOf(s.attrs, "role") ?? IMPLICIT_ROLE[s.name] ?? s.name,
      label: attrOf(s.attrs, "aria-label") ?? attrOf(s.attrs, "id"),
      text: preview.length > LANDMARK_PREVIEW ? `${preview.slice(0, LANDMARK_PREVIEW)}…` : preview,
      chars: visible.length,
    }
  })
}

/** The raw-HTML slice of the Nth (1-based) top-level landmark region — what a headless
 *  page's region map addresses. Null when there is no Nth region. */
export function landmarkSlice(html: string, n: number): string | null {
  const span = landmarkSpans(html)[n - 1]
  return span ? html.slice(span.start, span.end) : null
}

/** A named position in a document — a heading, or (for HTML) a labelled landmark —
 *  with its 1-based line number. Lets a search annotate each match with the section it
 *  falls in ("§ Revenue"), so a hit deep in a doc is self-locating. */
export interface SectionMarker {
  text: string
  line: number
}

// Every labelled landmark element by open-tag position — nested included, unlike the
// top-level-only `landmarkSpans` the map uses. Search wants the FINEST enclosing
// section (a card inside <main>), so it needs the inner labels too. Drop-subtree
// masking mirrors headingSpans so a landmark inside <script>/<template> is ignored.
const labelledLandmarks = (html: string): { label: string; start: number }[] => {
  const drop: [number, number][] = []
  DROP_SUBTREE.lastIndex = 0
  for (let dm = DROP_SUBTREE.exec(html); dm; dm = DROP_SUBTREE.exec(html))
    drop.push([dm.index, dm.index + dm[0].length])
  const inDrop = (p: number) => drop.some(([s, e]) => p >= s && p < e)
  const out: { label: string; start: number }[] = []
  TOKEN.lastIndex = 0
  for (let m = TOKEN.exec(html); m; m = TOKEN.exec(html)) {
    if (inDrop(m.index)) continue
    const tag = parseTag(m[0] as string, m.index)
    if (!tag || tag.closing || !LANDMARK.has(tag.name)) continue
    const label = attrOf(tag.attrs, "aria-label") ?? attrOf(tag.attrs, "id")
    if (label) out.push({ label, start: tag.start })
  }
  return out
}

/** Section markers for `source`, sorted by position: ATX headings for markdown; h1–h6
 *  plus labelled landmarks (nested included) for HTML. Line numbers are computed in one
 *  newline pass, so they line up with the raw source an agent greps and windows. */
export const sectionMarkers = (source: string, contentType: string): SectionMarker[] => {
  const raw: { text: string; offset: number }[] = []
  if (isHtmlLike(contentType)) {
    for (const s of headingSpans(source)) raw.push({ text: s.text, offset: s.start })
    for (const s of labelledLandmarks(source)) raw.push({ text: s.label, offset: s.start })
  } else {
    for (const h of mdHeadings(source)) raw.push({ text: h.text, offset: h.start })
  }
  raw.sort((a, b) => a.offset - b.offset)
  let line = 1
  let pos = 0
  return raw.map((m) => {
    while (pos < m.offset && pos < source.length) {
      if (source[pos] === "\n") line++
      pos++
    }
    return { text: m.text, line }
  })
}

/** The marker a given 1-based line falls under: the last marker at or above it, or null
 *  when the line precedes every marker. */
export const enclosingMarker = (markers: SectionMarker[], line: number): string | null => {
  let found: string | null = null
  for (const m of markers) {
    if (m.line > line) break
    found = m.text
  }
  return found
}

/** The h1–h6 spine of an HTML document. Empty array = unsectionable (no headings). */
export function docOutline(html: string): OutlineSection[] {
  // `chars` is the section's raw-source span (offset math, O(1) per heading) — the
  // same cheap measure the markdown outline uses, not a per-section htmlToMarkdown
  // reconversion (which made the outline of a heading-heavy doc O(headings × size)).
  return sectionSpans(html, "text/html").map((s) => ({
    level: s.level,
    text: s.text,
    slug: s.slug,
    chars: s.end - s.start,
  }))
}

/** One section's exact span: heading tag to the next heading of the same or higher level.
 *  THE definition of a section — `sectionOf`, `outlineOf` and the doc map all read it, so
 *  a section slug means the same bytes on every surface. */
export interface SectionSpan {
  level: number
  text: string
  slug: string
  /** Offset of the heading tag (HTML) or the line start (markdown). */
  start: number
  /** Offset just past the section's last byte. */
  end: number
}

/** FLAT section spans: each heading to the NEXT heading of any level.
 *
 *  The nesting `sectionSpans` describes (heading to the next same-or-higher level) is the
 *  right reading semantic and the wrong slicing one: an h2 containing an h3 CONTAINS its
 *  span, and a markdown doc under one h1 is a single section covering everything. Spans
 *  that contain each other cannot tile a document, and tiling is what makes a structural
 *  replace safe. So the doc map slices flat, and nesting stays recoverable by composition:
 *  a section plus every following node of deeper level is exactly its nested span (asserted
 *  in doc-map's parity tests). Both flavours read the SAME headings and the same slugs, so
 *  what a section IS can never drift between them. */
export const flatSectionSpans = (source: string, contentType: string): SectionSpan[] => {
  const nested = sectionSpans(source, contentType)
  if (!nested.length) return []
  // The document's own end for the last section: HTML stops at </body> so the closing
  // tags become the map's tail, exactly as the nesting slicer does.
  const bodyAt = isHtmlLike(contentType) ? source.lastIndexOf("</body>") : -1
  const lastStart = (nested[nested.length - 1] as SectionSpan).start
  const docEnd = bodyAt > lastStart ? bodyAt : source.length
  return nested.map((h, i) => ({
    ...h,
    end: i + 1 < nested.length ? (nested[i + 1] as SectionSpan).start : docEnd,
  }))
}

/** Section spans for any text source, in document order. */
export const sectionSpans = (source: string, contentType: string): SectionSpan[] => {
  if (isHtmlLike(contentType)) {
    const hs = headingSpans(source)
    return hs.map((h, i) => ({
      level: h.level,
      text: h.text,
      slug: h.slug,
      start: h.start,
      end: sectionEnd(source, hs, i),
    }))
  }
  const hs = mdHeadings(source)
  return hs.map((h, i) => ({
    level: h.level,
    text: h.text,
    slug: h.slug,
    start: h.start,
    end: mdSectionEnd(source, hs, i),
  }))
}

/** Raw-HTML slice for `slug`: from its heading tag to the next heading of the same or
 *  higher level (or </body>). Byte-identical substring of the source, so a section an
 *  agent reads with format:"html" is exactly the text publish `edits` will match. */
export function sectionSlice(html: string, slug: string): string | null {
  const span = sectionSpans(html, "text/html").find((s) => s.slug === slug)
  return span ? html.slice(span.start, span.end) : null
}

// ---------------------------------------------------------------------------------
// Markdown twins (source IS what agents read and edit — slice the source itself)

interface MdHeading {
  level: number
  text: string
  slug: string
  start: number // offset of the line start
}

const mdHeadings = (src: string): MdHeading[] => {
  const slug = slugger()
  const out: MdHeading[] = []
  let fence: string | null = null
  let offset = 0
  for (const line of src.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)
    if (f) {
      const run = f[1] as string
      if (!fence) fence = run.slice(0, 1).repeat(3)
      else if (run.startsWith(fence)) fence = null
    } else if (!fence) {
      const h = /^(#{1,6})\s+/.exec(line)
      if (h) {
        // Trailing trim by hand (whitespace, then closing #s, then whitespace): the old
        // /^(#{1,6})\s+(.+?)\s*#*\s*$/ wrapped a lazy dot in three overlapping \s loops —
        // quadratic on a heading line ending in a run of spaces (js/polynomial-redos).
        const rest = line.slice((h[0] as string).length)
        let end = rest.length
        while (end > 0 && /\s/.test(rest[end - 1] as string)) end--
        while (end > 0 && rest[end - 1] === "#") end--
        while (end > 0 && /\s/.test(rest[end - 1] as string)) end--
        // An all-hash title ("# ###") keeps one hash, exactly as the lazy dot did.
        const text = (end > 0 ? rest.slice(0, end) : rest.slice(0, 1)).trim()
        if (text)
          out.push({ level: (h[1] as string).length, text, slug: slug(text), start: offset })
      }
    }
    offset += line.length + 1
  }
  return out
}

const mdSectionEnd = (src: string, hs: MdHeading[], i: number): number => {
  const level = (hs[i] as MdHeading).level
  for (let j = i + 1; j < hs.length; j++) {
    const next = hs[j] as MdHeading
    if (next.level <= level) return next.start
  }
  return src.length
}

// ---------------------------------------------------------------------------------
// Content-type facade — what the servers call

/** Content types this module treats as HTML-in, Markdown-out (converted by
 *  htmlToMarkdown/docOutline/sectionSlice) rather than passed through as-is.
 *  Exported so callers deciding how to present a `format` (e.g. whether "text"
 *  needs pageText-style stripping) stay in sync with what actually gets converted —
 *  a local `=== "text/html"` check would silently drift on decks. */
/** The agent-readable form of stored source: HTML converts to Markdown, everything
 *  else (markdown, plain text) already IS the readable form and passes through. */
export const toMarkdown = (source: string, contentType: string): string =>
  isHtmlLike(contentType) ? htmlToMarkdown(source) : source

// A base64 data: URI tokenizes at roughly 1 token/char — a single modest screenshot
// can cost 100k+ tokens to read back through an agent-facing surface. Only ever
// applied to the markdown/agent-readable form (never the exact HTML source, which
// `edits` matches byte-for-byte against); anything over ~200 base64 chars (~150
// bytes) is worth collapsing.
const DATA_URI_RE = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g
export const elideDataUris = (s: string): string =>
  s.replace(DATA_URI_RE, (m, mime: string, b64: string) =>
    b64.length > 200
      ? `data:${mime};base64,[elided — ${Math.round((b64.length * 3) / 4 / 1024)}KB inline image. Re-upload via POST /v1/assets and swap in its url to make this doc cheap to read]`
      : m,
  )

/** Outline for any text source (h1–h6 for HTML, ATX `#`–`######` for markdown). */
export const outlineOf = (source: string, contentType: string): OutlineSection[] => {
  if (isHtmlLike(contentType)) return docOutline(source)
  return sectionSpans(source, contentType).map((h) => ({
    level: h.level,
    text: h.text,
    slug: h.slug,
    chars: h.end - h.start,
  }))
}

/** The landmark map for an HTML page with no heading spine (empty for markdown, and
 *  for HTML that has headings — the outline covers those, this is the fallback). */
export const landmarksOf = (source: string, contentType: string): LandmarkRegion[] =>
  isHtmlLike(contentType) ? landmarkMap(source) : []

/** The SOURCE slice a section slug addresses (raw HTML or raw markdown). */
export const sectionOf = (source: string, contentType: string, slug: string): string | null => {
  if (isHtmlLike(contentType)) return sectionSlice(source, slug)
  const span = sectionSpans(source, contentType).find((h) => h.slug === slug)
  if (!span) return null
  return source.slice(span.start, span.end).replace(/\n+$/, "\n")
}

// ---------------------------------------------------------------------------------
// Exact-match edits (the Edit-tool contract)

export class EditError extends Error {}

// Non-overlapping occurrence positions — advances past the whole match, not by one
// char, so a self-overlapping needle ("aa" in "aaa") counts as the single
// non-overlapping match a real replace would make, not a spuriously "ambiguous" 2.
const occurrencePositions = (haystack: string, needle: string): number[] => {
  const out: number[] = []
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length))
    out.push(i)
  return out
}

// A line, whitespace-tolerant: trimmed and internal runs collapsed to one space —
// tabs-vs-spaces or a trailing-whitespace difference (the single most common miss)
// normalizes away, while real content differences still don't match.
const normalizeLine = (s: string): string => s.trim().replace(/\s+/g, " ")

// Tier 1 is a sliding window: O(haystack lines × needle lines) comparisons. Cheap for
// a typical small edit on any size document (needle is short), or a large needle on a
// typical small document — the risk is both being large at once. Cap the product
// rather than either dimension alone, so neither shape is penalized on its own.
// 500K comparisons is ~12ms by extrapolation from a measured 36M-comparison/~900ms case.
const TIER1_MAX_COMPARISONS = 500_000

// Same cap search results already apply per line (see LINE_CLIP in
// apps/api/src/lib/search.ts) — this file can't import that (packages/core has
// zero external deps), so it's a local constant, not a shared one.
const MISS_HINT_LINE_CLIP = 400

const isWordChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_]/.test(c)

// Whole-word substring search without a regex (avoids escaping arbitrary user text):
// `anchor` must not be glued to another word character on either side.
const includesWord = (line: string, word: string): boolean => {
  for (let idx = line.indexOf(word); idx !== -1; idx = line.indexOf(word, idx + 1))
    if (!isWordChar(line[idx - 1]) && !isWordChar(line[idx + word.length])) return true
  return false
}

// Diagnose a "not found" old_str: WHY didn't it match, not just that it didn't.
// Two tiers, cheapest and most common first — never used to auto-apply anything,
// purely a message so the agent fixes it in one round instead of a blind retry.
const nearestMissHint = (haystack: string, needle: string): string => {
  const hLines = haystack.split("\n")
  const nLines = needle.split("\n")
  const normN = nLines.map(normalizeLine)

  // Tier 1: the exact same lines exist, just with different whitespace — a sliding
  // window match on normalized lines, reported at its real (unnormalized) line no.
  if (hLines.length * normN.length <= TIER1_MAX_COMPARISONS) {
    for (let i = 0; i + normN.length <= hLines.length; i++) {
      let allMatch = true
      for (let j = 0; j < normN.length; j++) {
        if (normalizeLine(hLines[i + j] as string) !== normN[j]) {
          allMatch = false
          break
        }
      }
      if (allMatch)
        return (
          ` The text is there at line ${i + 1}, but whitespace differs (tabs vs spaces, or ` +
          `trailing spaces) — read format:"html" (or the doc's own format) and copy old_str exactly.`
        )
    }
  }

  // Tier 2: the FIRST WORD of old_str's first non-empty line exists somewhere, but
  // what follows doesn't match — the doc changed since this was written. Show what's
  // there now. Deliberately just one word, not a phrase: for a single-line old_str the
  // "first line" IS the whole needle (which by definition didn't match), so requiring
  // more than a coarse token would never fire — a first-word anchor still locates the
  // general spot even when everything after it changed. Matched as a whole word (not
  // a bare substring) so "The" doesn't spuriously anchor onto "Theater".
  const firstLine = nLines.find((l) => l.trim().length > 0)
  if (firstLine) {
    const anchor = firstLine.trim().split(/\s+/)[0] ?? ""
    const idx = anchor.length >= 3 ? hLines.findIndex((l) => includesWord(l, anchor)) : -1
    if (idx >= 0) {
      // Cap each shown line — a real, common shape (a minified/bundled single-line
      // HTML file) can put tens of thousands of chars on ONE "line", which would
      // otherwise blow this diagnostic's own token budget. Mirrors the same
      // line-length cap apps/api/src/lib/search.ts applies to search hits.
      const clipLine = (s: string): string =>
        s.length > MISS_HINT_LINE_CLIP ? `${s.slice(0, MISS_HINT_LINE_CLIP)}…` : s
      const around = hLines
        .slice(Math.max(0, idx - 1), idx + 2)
        .map(clipLine)
        .join("\n")
      return (
        ` A similar line exists at line ${idx + 1}, but the rest of old_str doesn't match what's ` +
        `there now:\n${around}\nRe-read the artifact for the current text.`
      )
    }
  }

  return ' Re-read the artifact (format:"html" for HTML content), or use `search` to find the right spot.'
}

/**
 * Apply `edits` to `src` in order, each seeing the previous edit's result. Every
 * `old_str` must match EXACTLY ONCE — unless `occurrence` names which of several
 * identical matches to replace — or the whole batch is rejected (nothing partial
 * ever lands). A miss carries a diagnostic (why it didn't match, not just that it
 * didn't) so the agent fixes it in one round. Same contract as the coding Edit tool,
 * so agents already know how to recover.
 */
export function applyEdits(src: string, edits: DocEdit[]): string {
  if (!edits.length)
    throw new EditError("`edits` is empty — provide at least one {old_str, new_str}.")
  let result = src
  for (const [i, e] of edits.entries()) {
    const label = `Edit ${i + 1} of ${edits.length}`
    if (!e.old_str) throw new EditError(`${label} failed: old_str is empty.`)
    const positions = occurrencePositions(result, e.old_str)
    if (positions.length === 0)
      throw new EditError(
        `${label} failed: old_str not found in the current source.${nearestMissHint(result, e.old_str)}`,
      )
    if (positions.length === 1) {
      if (e.occurrence !== undefined && e.occurrence !== 1)
        throw new EditError(
          `${label} failed: occurrence ${e.occurrence} is out of range — old_str matched once (occurrence 1).`,
        )
      result = result.replace(e.old_str, () => e.new_str)
      continue
    }
    // Multiple matches: require `occurrence` to pick one rather than guessing.
    if (e.occurrence === undefined)
      throw new EditError(
        `${label} failed: old_str matched ${positions.length} times — add more surrounding context ` +
          `so it is unique, or pass \`occurrence\` (1..${positions.length}) to pick one.`,
      )
    if (!Number.isInteger(e.occurrence) || e.occurrence < 1 || e.occurrence > positions.length)
      throw new EditError(
        `${label} failed: occurrence ${e.occurrence} is out of range — old_str matched ` +
          `${positions.length} times (occurrence 1..${positions.length}).`,
      )
    const at = positions[e.occurrence - 1] as number
    result = result.slice(0, at) + e.new_str + result.slice(at + e.old_str.length)
  }
  return result
}
