// Stored-format facade for artifact reading. HTML-to-Markdown uses the shared core.
// Derive keeps its stored-format classification and LaTeX heading renderer.

import { htmlToMarkdown } from "@aniraga/open-artifact-protocol/source"
import { decodeEntities, pageText } from "./anchor"
import { isHtmlLike, isLatexLike } from "./content-types"
import { latexHeadings } from "./latex-render"

export {
  DECK_CONTENT_TYPE,
  isAuthoredFactType,
  isHtmlLike,
  isLatexLike,
  isMarkdownLike,
} from "./content-types"

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

export {
  applyEdits,
  type DocEdit,
  EditError,
  htmlToMarkdown,
} from "@aniraga/open-artifact-protocol/source"

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

/** Per-document slug dedup: second "goals" becomes "goals-1", then "goals-2" … Exported
 *  for the LaTeX renderer, whose section ids must match the outline built here. */
export const headingSlugger = () => {
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

// ---------------------------------------------------------------------------------
// HTML → Markdown

const collapse = (s: string) => s.replace(/[ \t\r\n]+/g, " ")

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
  const slug = headingSlugger()
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
  } else if (isLatexLike(contentType)) {
    for (const h of texHeadings(source)) raw.push({ text: h.text, offset: h.start })
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
  if (isLatexLike(contentType)) {
    const hs = texHeadings(source)
    return hs.map((h, i) => ({
      level: h.level,
      text: h.text,
      slug: h.slug,
      start: h.start,
      end: texSectionEnd(source, hs, i),
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
  const slug = headingSlugger()
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

/** LaTeX sections in the markdown heading shape: `\section` and its relatives, with the
 *  ids the rendered page gives them, starting at the macro. The renderer numbers the
 *  heading text ("2.1 Predictor"); the spine keeps the number so a search label reads
 *  like the paper. */
const texHeadings = (src: string): MdHeading[] =>
  latexHeadings(src, headingSlugger()).map((h) => ({
    level: h.level,
    text: h.text,
    slug: h.slug,
    start: h.start,
  }))

/** A LaTeX section ends where the next heading of the same or a higher level starts, or
 *  at `\end{document}`, so the back matter never counts as the last section's prose. */
const texSectionEnd = (src: string, hs: MdHeading[], i: number): number => {
  const level = (hs[i] as MdHeading).level
  for (let j = i + 1; j < hs.length; j++) {
    const next = hs[j] as MdHeading
    if (next.level <= level) return next.start
  }
  const end = src.lastIndexOf("\\end{document}")
  return end > (hs[i] as MdHeading).start ? end : src.length
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
 *  else (markdown, LaTeX, plain text) already IS the readable form and passes through. */
export const toMarkdown = (source: string, contentType: string): string =>
  isHtmlLike(contentType) ? htmlToMarkdown(source) : source

// A base64 data: URI tokenizes at roughly 1 token/char — a single modest screenshot
// can cost 100k+ tokens to read back through an agent-facing surface. Only ever
// applied to the markdown/agent-readable form (never the exact HTML source, which
// `edits` matches byte-for-byte against); anything over ~200 base64 chars (~150
// bytes) is worth collapsing.
const DATA_URI_RE = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g
const DATA_URI_AT_RE = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/y
const elidedDataUri = (match: string, mime: string, b64: string): string =>
  b64.length > 200
    ? `data:${mime};base64,[elided — ${Math.round((b64.length * 3) / 4 / 1024)}KB inline image. Re-upload via POST /v1/assets and swap in its url to make this doc cheap to read]`
    : match
export const elideDataUris = (s: string): string => s.replace(DATA_URI_RE, elidedDataUri)

/**
 * The first `maxChars` of {@link elideDataUris}, without scanning source that cannot
 * contribute to that prefix. Search indexes at most 256 KiB of one source, while an
 * artifact can be tens of MiB. Running the global replacement before slicing made a
 * small far-tail edit rescan the complete document just to reproduce the same prefix.
 *
 * A data URI that STARTS inside the output window is still consumed in full. Its
 * replacement reports the original byte size, so stopping halfway through it would
 * change the indexed text. Everything after the output window is irrelevant.
 */
export const elideDataUrisToLimit = (s: string, maxChars: number): string => {
  const limit = Math.max(0, Math.floor(maxChars))
  if (!limit || !s) return ""
  let cursor = 0
  let out = ""
  while (cursor < s.length && out.length < limit) {
    const remaining = limit - out.length
    const candidate = s.indexOf("data:", cursor)
    if (candidate < 0 || candidate - cursor >= remaining) {
      out += s.slice(cursor, cursor + remaining)
      break
    }
    out += s.slice(cursor, candidate)
    DATA_URI_AT_RE.lastIndex = candidate
    const match = DATA_URI_AT_RE.exec(s)
    if (!match) {
      // Match the final slice exactly when a malformed literal crosses the output
      // boundary. Appending all five characters here could exceed `maxChars` and make
      // the bounded search projection differ from full elision followed by slicing.
      const literal = "data:".slice(0, limit - out.length)
      out += literal
      cursor = candidate + literal.length
      continue
    }
    const replacement = elidedDataUri(match[0], match[1] as string, match[2] as string)
    out += replacement.slice(0, limit - out.length)
    cursor = DATA_URI_AT_RE.lastIndex
  }
  return out
}

/** Outline for any text source (h1–h6 for HTML, ATX `#`–`######` for markdown,
 *  `\section` and its relatives for LaTeX). */
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
