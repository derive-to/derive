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
  /** True when the browser ends this opening element at its own `>`. */
  selfClosing: boolean
  /** Parsing namespace selected by the browser for this element. */
  namespace: "html" | "svg" | "math"
  /** Open elements this close token pops, including malformed descendants. */
  closedOpenStarts: readonly number[]
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

/** Elements whose bodies keep apparent tags as text until their own close token. */
export const RAW_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
])
export const RCDATA_ELEMENTS = new Set(["title", "textarea"])

const HEAD_CONTENT = new Set([
  "base",
  "basefont",
  "bgsound",
  "link",
  "meta",
  "noframes",
  "noscript",
  "script",
  "style",
  "template",
  "title",
])

const P_CLOSING_STARTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "dialog",
  "div",
  "dl",
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
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "search",
  "section",
  "table",
  "ul",
])

/** Whether `tag` is the browser tokenizer boundary that implicitly closes `open`.
 *  These are the optional-end-tag families that matter to source projection: an
 *  invisible element must not swallow later siblings merely because the author
 *  used valid omitted closing tags. */
const implicitlyCloses = (open: HtmlTag, tag: HtmlTag): boolean => {
  if (open.name === "head")
    return (
      (!tag.closing && !HEAD_CONTENT.has(tag.name)) ||
      (tag.closing && (tag.name === "body" || tag.name === "html"))
    )
  if (open.name === "li")
    return (
      (!tag.closing && tag.name === "li") ||
      (tag.closing && (tag.name === "ul" || tag.name === "ol" || tag.name === "menu"))
    )
  if (open.name === "dt" || open.name === "dd")
    return (
      (!tag.closing && (tag.name === "dt" || tag.name === "dd")) ||
      (tag.closing && tag.name === "dl")
    )
  if (open.name === "rt" || open.name === "rp")
    return !tag.closing && (tag.name === "rt" || tag.name === "rp")
  if (open.name === "option")
    return (
      (!tag.closing && (tag.name === "option" || tag.name === "optgroup")) ||
      (tag.closing && (tag.name === "select" || tag.name === "datalist" || tag.name === "optgroup"))
    )
  if (open.name === "optgroup")
    return (!tag.closing && tag.name === "optgroup") || (tag.closing && tag.name === "select")
  if (open.name === "colgroup")
    return (
      (!tag.closing && ["tbody", "thead", "tfoot", "tr"].includes(tag.name)) ||
      (tag.closing && tag.name === "table")
    )
  if (open.name === "thead")
    return (
      (!tag.closing && (tag.name === "tbody" || tag.name === "tfoot")) ||
      (tag.closing && tag.name === "table")
    )
  if (open.name === "tbody")
    return (
      (!tag.closing && (tag.name === "tbody" || tag.name === "tfoot")) ||
      (tag.closing && tag.name === "table")
    )
  if (open.name === "tfoot") return tag.closing && tag.name === "table"
  if (open.name === "tr")
    return (
      (!tag.closing && tag.name === "tr") ||
      (tag.closing && ["table", "tbody", "thead", "tfoot"].includes(tag.name))
    )
  if (open.name === "td" || open.name === "th")
    return (
      (!tag.closing && (tag.name === "td" || tag.name === "th")) ||
      (tag.closing && ["tr", "table", "tbody", "thead", "tfoot"].includes(tag.name))
    )
  if (open.name === "p")
    return (
      (!tag.closing && P_CLOSING_STARTS.has(tag.name)) ||
      (tag.closing &&
        [
          "address",
          "article",
          "aside",
          "blockquote",
          "div",
          "footer",
          "form",
          "header",
          "main",
          "nav",
          "section",
        ].includes(tag.name))
    )
  return false
}

const optionalScopeContainers = (name: string): ReadonlySet<string> | null => {
  if (name === "li") return new Set(["ul", "ol", "menu"])
  if (name === "dt" || name === "dd") return new Set(["dl"])
  if (name === "rt" || name === "rp") return new Set(["ruby"])
  if (name === "option" || name === "optgroup") return new Set(["select", "datalist"])
  if (["colgroup", "thead", "tbody", "tfoot", "tr", "td", "th"].includes(name))
    return new Set(["table"])
  return null
}

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
  type Namespace = "html" | "svg" | "math"
  const open: { name: string; namespace: Namespace; attrs: string; start: number }[] = []

  const namespaceFor = (name: string): Namespace => {
    const parent = open.at(-1)
    let namespace: Namespace = parent?.namespace ?? "html"
    if (parent?.namespace === "svg" && ["foreignobject", "desc", "title"].includes(parent.name))
      namespace = "html"
    else if (
      parent?.namespace === "math" &&
      ["mi", "mo", "mn", "ms", "mtext"].includes(parent.name) &&
      !["mglyph", "malignmark"].includes(name)
    )
      namespace = "html"
    else if (parent?.namespace === "math" && parent.name === "annotation-xml") {
      const encoding = attrValue(parent.attrs, "encoding")?.toLowerCase()
      if (encoding === "text/html" || encoding === "application/xhtml+xml") namespace = "html"
    }
    if (namespace === "html" && name === "svg") return "svg"
    if (namespace === "html" && name === "math") return "math"
    return namespace
  }

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
    const syntacticSlash = attrs.trimEnd().endsWith("/")
    const namespace = namespaceFor(name)
    const matching = closing ? open.findLastIndex((tag) => tag.name === name) : -1
    const closedOpenStarts = matching >= 0 ? open.slice(matching).map((tag) => tag.start) : []
    // In HTML, a trailing slash closes only void or foreign-content elements;
    // `<section/>` is still an open section. Expose browser-effective structure
    // so every downstream slicer and source mapper agrees with the DOM.
    const selfClosing =
      !closing && (namespace === "html" ? VOID_ELEMENTS.has(name) : syntacticSlash)
    out.push({
      name,
      closing,
      selfClosing,
      namespace,
      closedOpenStarts,
      attrs,
      start: lt,
      end: j + 1,
    })
    if (closing) {
      if (matching >= 0) open.length = matching
    } else if (!selfClosing) open.push({ name, namespace, attrs, start: lt })
    i = j + 1
    // Raw-text elements: their content is text, so skip straight past the close tag.
    if (!closing && (RAW_TEXT_ELEMENTS.has(name) || RCDATA_ELEMENTS.has(name))) {
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
  if (open.selfClosing) return open.end
  let depth = 1
  let optionalScopeDepth = 0
  const scopeContainers = optionalScopeContainers(open.name)
  for (let k = i + 1; k < all.length; k++) {
    const tag = all[k] as HtmlTag
    if (open.namespace !== "html" && tag.closedOpenStarts.includes(open.start))
      return tag.name === open.name ? tag.end : tag.start
    if (scopeContainers?.has(tag.name)) {
      if (!tag.closing && !tag.selfClosing) optionalScopeDepth++
      else if (tag.closing && optionalScopeDepth > 0) {
        optionalScopeDepth--
        continue
      }
    }
    if (optionalScopeDepth > 0) continue
    if (depth === 1 && implicitlyCloses(open, tag)) return tag.start
    if (tag.name !== open.name || tag.selfClosing) continue
    depth += tag.closing ? -1 : 1
    if (depth === 0) return tag.end
  }
  return -1
}
