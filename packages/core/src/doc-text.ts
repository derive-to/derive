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

import { decodeEntities } from "./anchor"

/** One heading in a document's h1–h3 spine. `chars` is the size of the section's
 *  MARKDOWN conversion (heading included) — what a read of that section costs. */
export interface OutlineSection {
  level: number
  text: string
  slug: string
  chars: number
}

/** One exact-match replacement (the Edit-tool contract: unique match or error). */
export interface DocEdit {
  old_str: string
  new_str: string
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

// Comments, declarations (<!DOCTYPE …>), and element tags.
const TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>/g

const parseTag = (raw: string, start: number): Tag | null => {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*?)(\/?)>$/.exec(raw)
  if (!m) return null
  return {
    name: (m[2] as string).toLowerCase(),
    attrs: m[3] as string,
    closing: m[1] === "/",
    selfClosing: m[4] === "/",
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

    switch (tag.name) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        // A heading has no meaning inside a table cell (pipe-table syntax can't hold
        // one) — ignore the tag; its text still flows into the cell as plain text via
        // the normal emitText/append path.
        if (inCell()) break
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
        if (inCell()) break // no block content inside a pipe-table cell
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

const HEADING = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi

const headingSpans = (html: string): HeadingSpan[] => {
  const slug = slugger()
  const spans: HeadingSpan[] = []
  // Headings inside dropped subtrees (a <template> …) would be false spine entries;
  // artifact docs don't nest headings there, and a stray one only adds a dead slug.
  HEADING.lastIndex = 0
  for (let m = HEADING.exec(html); m; m = HEADING.exec(html)) {
    const text = collapse(decodeEntities((m[2] as string).replace(/<[^>]+>/g, " "))).trim()
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

/** The h1–h3 spine of an HTML document. Empty array = unsectionable (no headings). */
export function docOutline(html: string): OutlineSection[] {
  const spans = headingSpans(html)
  return spans.map((s, i) => ({
    level: s.level,
    text: s.text,
    slug: s.slug,
    chars: htmlToMarkdown(html.slice(s.start, sectionEnd(html, spans, i))).length,
  }))
}

/** Raw-HTML slice for `slug`: from its heading tag to the next heading of the same or
 *  higher level (or </body>). Byte-identical substring of the source, so a section an
 *  agent reads with format:"html" is exactly the text publish `edits` will match. */
export function sectionSlice(html: string, slug: string): string | null {
  const spans = headingSpans(html)
  const i = spans.findIndex((s) => s.slug === slug)
  if (i < 0) return null
  return html.slice((spans[i] as HeadingSpan).start, sectionEnd(html, spans, i))
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
      const h = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line)
      if (h) {
        const text = (h[2] as string).trim()
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

const isHtmlLike = (contentType: string): boolean => {
  const ct = contentType.split(";")[0]?.trim()
  return ct === "text/html" || ct === "text/x-derive-deck"
}

/** The agent-readable form of stored source: HTML converts to Markdown, everything
 *  else (markdown, plain text) already IS the readable form and passes through. */
export const toMarkdown = (source: string, contentType: string): string =>
  isHtmlLike(contentType) ? htmlToMarkdown(source) : source

/** Outline for any text source (h1–h3 for HTML, ATX `#`–`###` for markdown). */
export const outlineOf = (source: string, contentType: string): OutlineSection[] => {
  if (isHtmlLike(contentType)) return docOutline(source)
  const hs = mdHeadings(source)
  return hs.map((h, i) => ({
    level: h.level,
    text: h.text,
    slug: h.slug,
    chars: mdSectionEnd(source, hs, i) - h.start,
  }))
}

/** The SOURCE slice a section slug addresses (raw HTML or raw markdown). */
export const sectionOf = (source: string, contentType: string, slug: string): string | null => {
  if (isHtmlLike(contentType)) return sectionSlice(source, slug)
  const hs = mdHeadings(source)
  const i = hs.findIndex((h) => h.slug === slug)
  if (i < 0) return null
  return source.slice((hs[i] as MdHeading).start, mdSectionEnd(source, hs, i)).replace(/\n+$/, "\n")
}

// ---------------------------------------------------------------------------------
// Exact-match edits (the Edit-tool contract)

export class EditError extends Error {}

const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) count++
  return count
}

/**
 * Apply `edits` to `src` in order, each seeing the previous edit's result. Every
 * `old_str` must match EXACTLY ONCE or the whole batch is rejected (nothing partial
 * ever lands) with an error naming the failing edit — the agent adds surrounding
 * context and retries. Same contract as the coding Edit tool, so agents already
 * know how to recover.
 */
export function applyEdits(src: string, edits: DocEdit[]): string {
  if (!edits.length)
    throw new EditError("`edits` is empty — provide at least one {old_str, new_str}.")
  let result = src
  for (const [i, e] of edits.entries()) {
    const label = `Edit ${i + 1} of ${edits.length}`
    if (!e.old_str) throw new EditError(`${label} failed: old_str is empty.`)
    const n = countOccurrences(result, e.old_str)
    if (n === 0)
      throw new EditError(
        `${label} failed: old_str not found in the current source. Re-read the artifact ` +
          `(format:"html" for HTML content) and copy the text exactly.`,
      )
    if (n > 1)
      throw new EditError(
        `${label} failed: old_str matched ${n} times — include more surrounding context so it is unique.`,
      )
    result = result.replace(e.old_str, () => e.new_str)
  }
  return result
}
