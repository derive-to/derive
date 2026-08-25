/**
 * A linear walk over a document's REAL tags: the shared primitive under the deck slicer
 * and the doc map, so both agree byte-for-byte about where an element starts and ends.
 *
 * Its own module rather than living in either consumer, because decks (which slices
 * slides) and doc-map (which slices everything, slides included) would otherwise import
 * each other. A cycle resolves at runtime but makes load order load-bearing, and this
 * walker is small enough to own a file.
 *
 * "Real" means what a browser would read as markup, which is why this is not a regex:
 * comment bodies and the raw-text bodies of <script>/<style> are skipped, so a
 * `</section>` inside a JS string is text rather than a close tag, and quoted attribute
 * values are honored, so a `>` inside `title="a > b"` does not end the tag early.
 */

export interface HtmlTag {
  /** Lowercased tag name. */
  name: string
  /** True for `</name>`. */
  closing: boolean
  /** True for `<name … />`. */
  selfClosing: boolean
  /** Raw attribute text between the name and the closing `>`. */
  attrs: string
  /** Offset of the opening `<`. */
  start: number
  /** Offset just past the tag's `>`. */
  end: number
}

const isHtmlSpace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f"

/** Elements whose opening tag is the whole element in HTML. Browsers never wait
 *  for a matching close tag for these, even when the optional `/` is omitted. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
])

/** HTML accepts the legacy `--!>` comment terminator in addition to `-->`.
 *  Returning the first valid closer keeps every scanner on the browser's side of
 *  the visible/hidden boundary without a backtracking regular expression. */
const commentCloseEnd = (html: string, from: number): number => {
  let cursor = from
  for (;;) {
    const dashes = html.indexOf("--", cursor)
    if (dashes < 0) return -1
    if (html.startsWith("-->", dashes)) return dashes + 3
    if (html.startsWith("--!>", dashes)) return dashes + 4
    cursor = dashes + 2
  }
}

/** Find a real raw-text closing tag. `\b` is not sufficient here: a hyphen is a
 *  word boundary, so `</script-widget>` would otherwise close `<script>`. */
const rawTextCloseStart = (lower: string, name: string, from: number): number => {
  const needle = `</${name}`
  let cursor = from
  for (;;) {
    const close = lower.indexOf(needle, cursor)
    if (close < 0) return -1
    const boundary = lower[close + needle.length] ?? ""
    if (!boundary || boundary === ">" || boundary === "/" || isHtmlSpace(boundary)) return close
    cursor = close + needle.length
  }
}

/** Every tag in `html`, in document order. */
export const tags = (html: string): HtmlTag[] => {
  const out: HtmlTag[] = []
  const lower = html.toLowerCase()
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf("<", i)
    if (lt === -1) break
    if (html.startsWith("<!--", lt)) {
      const close = commentCloseEnd(html, lt + 4)
      if (close === -1) break // unterminated: a browser comments out the rest
      i = close
      continue
    }
    const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 64))
    if (!m?.[1]) {
      i = lt + 1
      continue
    }
    // Find this tag's `>`, honoring quoted attribute values.
    let j = lt + m[0].length
    let quote = ""
    for (; j < html.length; j++) {
      const ch = html[j] as string
      if (quote) {
        if (ch === quote) quote = ""
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === ">") break
    }
    if (j >= html.length) break // unterminated tag: nothing structural left to trust
    const name = m[1].toLowerCase()
    const closing = m[0][1] === "/"
    const attrs = html.slice(lt + m[0].length, j)
    out.push({
      name,
      closing,
      selfClosing: attrs.trimEnd().endsWith("/"),
      attrs,
      start: lt,
      end: j + 1,
    })
    i = j + 1
    // Raw-text elements: their content is text, so skip straight past the close tag.
    if (!closing && (name === "script" || name === "style")) {
      const close = rawTextCloseStart(lower, name, i)
      if (close < 0) break
      i = close
    }
  }
  return out
}

/** The class attribute's tokens. CSS classes are whitespace-separated, and that
 *  separation matters: `slide` is a class, `slide-inner` is a different class that
 *  merely starts with the same word. */
export const classTokens = (attrs: string): string[] => {
  const m = attrs.match(/class\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
  const v = m?.[1] ?? m?.[2]
  return v ? v.trim().split(/\s+/) : []
}

/** An attribute's value from raw attribute text, or null. */
export const attrValue = (attrs: string, name: string): string | null => {
  return attrValues(attrs, name)[0] ?? null
}

/** Every authored value for one attribute. Structural editing callers use this to
 *  reject duplicate identity attributes instead of silently trusting the first one
 *  while leaving a conflicting second value in the source. */
export const attrValues = (attrs: string, name: string): string[] => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "gi")
  const values: string[] = []
  for (let m = re.exec(attrs); m; m = re.exec(attrs)) values.push(m[1] ?? m[2] ?? m[3] ?? "")
  return values
}

/** Whether raw attribute text contains an attribute, including boolean attributes
 *  such as `hidden` that intentionally have no equals sign or value. */
export const hasAttr = (attrs: string, name: string): boolean => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|=|/|$)`, "i").test(attrs)
}

/** The offset just past the element opened by `tags[i]`, tracking same-name nesting, or
 *  -1 when it never closes. A self-closing tag ends at its own `>`. */
export const elementEnd = (all: HtmlTag[], i: number): number => {
  const open = all[i] as HtmlTag
  if (open.selfClosing || VOID_ELEMENTS.has(open.name)) return open.end
  let depth = 1
  for (let k = i + 1; k < all.length; k++) {
    const tag = all[k] as HtmlTag
    if (tag.name !== open.name || tag.selfClosing) continue
    depth += tag.closing ? -1 : 1
    if (depth === 0) return tag.end
  }
  return -1
}
