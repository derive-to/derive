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

/** Every tag in `html`, in document order. */
export const tags = (html: string): HtmlTag[] => {
  const out: HtmlTag[] = []
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf("<", i)
    if (lt === -1) break
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4)
      if (close === -1) break // unterminated: a browser comments out the rest
      i = close + 3
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
      const close = new RegExp(`</${name}\\b`, "i").exec(html.slice(i))
      if (!close) break
      i += close.index
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
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null
}

/** The offset just past the element opened by `tags[i]`, tracking same-name nesting, or
 *  -1 when it never closes. A self-closing tag ends at its own `>`. */
export const elementEnd = (all: HtmlTag[], i: number): number => {
  const open = all[i] as HtmlTag
  if (open.selfClosing) return open.end
  let depth = 1
  for (let k = i + 1; k < all.length; k++) {
    const tag = all[k] as HtmlTag
    if (tag.name !== open.name || tag.selfClosing) continue
    depth += tag.closing ? -1 : 1
    if (depth === 0) return tag.end
  }
  return -1
}
