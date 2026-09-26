/**
 * A small offset-keeping HTML tree for the fuzz oracles. Deliberately independent of
 * @derive/core: the oracles judge the editing pipeline, so they must not share its
 * parser. It handles what the deck fixture and saved edits contain (comments, void
 * and raw-text elements, quoted attributes, implied </p>); the sanity spec checks it
 * agrees with the browser's DOM on every slide of the fixture.
 */

export interface HNode {
  tag: string
  start: number
  /** Offset just past the opening tag's `>`. */
  openEnd: number
  /** Offset just past the closing tag (or where an unclosed element was cut off). */
  end: number
  attrs: string
  children: HNode[]
  parent: HNode | null
}

const VOID = new Set([
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
const RAW = new Set(["script", "style", "textarea", "title"])
/** Start tags that implicitly close an open <p> (the HTML parser's rule, abridged). */
const P_CLOSERS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "dl",
  "fieldset",
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
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
])

export function parseHtml(src: string): HNode {
  const root: HNode = {
    tag: "#root",
    start: 0,
    openEnd: 0,
    end: src.length,
    attrs: "",
    children: [],
    parent: null,
  }
  const lower = src.toLowerCase()
  let cur = root
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf("<", i)
    if (lt < 0) break
    if (src.startsWith("<!--", lt)) {
      const e = src.indexOf("-->", lt + 4)
      i = e < 0 ? src.length : e + 3
      continue
    }
    if (src[lt + 1] === "!" || src[lt + 1] === "?") {
      const e = src.indexOf(">", lt)
      i = e < 0 ? src.length : e + 1
      continue
    }
    if (src[lt + 1] === "/") {
      const m = /^<\/([a-zA-Z][\w-]*)\s*>/.exec(src.slice(lt, lt + 80))
      if (!m) {
        i = lt + 1
        continue
      }
      const tag = (m[1] as string).toLowerCase()
      let n: HNode = cur
      while (n !== root && n.tag !== tag) n = n.parent as HNode
      if (n !== root) {
        for (let c = cur; c !== n; c = c.parent as HNode) c.end = lt
        n.end = lt + m[0].length
        cur = n.parent as HNode
      }
      i = lt + m[0].length
      continue
    }
    const m = /^<([a-zA-Z][\w-]*)/.exec(src.slice(lt, lt + 80))
    if (!m) {
      i = lt + 1
      continue
    }
    let j = lt + m[0].length
    let quote: string | null = null
    for (; j < src.length; j++) {
      const ch = src[j]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === ">") break
    }
    const tag = (m[1] as string).toLowerCase()
    const openEnd = Math.min(src.length, j + 1)
    if (cur.tag === "p" && P_CLOSERS.has(tag)) {
      cur.end = lt
      cur = cur.parent as HNode
    }
    const node: HNode = {
      tag,
      start: lt,
      openEnd,
      end: openEnd,
      attrs: src.slice(lt + m[0].length, j),
      children: [],
      parent: cur,
    }
    cur.children.push(node)
    if (VOID.has(tag) || src[j - 1] === "/") {
      i = openEnd
      continue
    }
    if (RAW.has(tag)) {
      const close = lower.indexOf(`</${tag}`, openEnd)
      const ce = close < 0 ? -1 : src.indexOf(">", close)
      node.end = ce < 0 ? src.length : ce + 1
      i = node.end
      continue
    }
    cur = node
    i = openEnd
  }
  for (let c: HNode | null = cur; c && c !== root; c = c.parent) c.end = src.length
  return root
}

export function attr(node: HNode, name: string): string | null {
  const re = new RegExp(
    `(?:^|\\s)${name}(?:\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>"']+)))?(?=\\s|/|$)`,
    "i",
  )
  const m = re.exec(node.attrs)
  if (!m) return null
  return m[2] ?? m[3] ?? m[4] ?? ""
}

/** Class tokens that identify an element to a person — editor classes filtered out,
 *  matching what the in-frame probe does with the live DOM. */
export const classKey = (classes: string): string =>
  classes
    .split(/\s+/)
    .filter((c) => c && !c.startsWith("derive-"))
    .sort()
    .join(".")

/** A chunk is one child element of a slide: a structural node (keyed by its id) or an
 *  un-owned sibling like a footer (keyed by tag + classes + occurrence). */
export function chunkKeys(nodes: { tag: string; nodeId: string | null; classes: string }[]) {
  const seen = new Map<string, number>()
  return nodes.map((n) => {
    if (n.nodeId) return `node:${n.nodeId}`
    const base = `${n.tag}.${classKey(n.classes)}`
    const k = seen.get(base) ?? 0
    seen.set(base, k + 1)
    return `${base}#${k}`
  })
}

export interface SourceSlide {
  node: HNode
  region: string | null
  start: number
  end: number
  chunks: SourceChunk[]
}
export interface SourceChunk {
  key: string
  node: HNode
  start: number
  end: number
}

export interface SourceDeck {
  src: string
  slides: SourceSlide[]
}

const slideOf = (c: HNode): SourceSlide => {
  const keys = chunkKeys(
    c.children.map((k) => ({
      tag: k.tag,
      nodeId: attr(k, "data-derive-node"),
      classes: attr(k, "class") ?? "",
    })),
  )
  return {
    node: c,
    region: attr(c, "data-derive-region"),
    start: c.start,
    end: c.end,
    chunks: c.children.map((k, i) => ({
      key: keys[i] as string,
      node: k,
      start: k.start,
      end: k.end,
    })),
  }
}

const firstTag = (n: HNode, tag: string): HNode | null => {
  for (const c of n.children) {
    if (c.tag === tag) return c
    const hit = firstTag(c, tag)
    if (hit) return hit
  }
  return null
}

/** Top-level slides (elements carrying data-derive-slide) in document order. A page
 *  with none (an article) is one slide: its <main>, else its <body> — the same root
 *  the in-frame probe reads. */
export function deckOf(src: string): SourceDeck {
  const root = parseHtml(src)
  const slides: SourceSlide[] = []
  const walk = (n: HNode) => {
    for (const c of n.children) {
      if (attr(c, "data-derive-slide") !== null) slides.push(slideOf(c))
      else walk(c)
    }
  }
  walk(root)
  if (!slides.length) {
    const doc = firstTag(root, "main") ?? firstTag(root, "body")
    if (doc) slides.push(slideOf(doc))
  }
  return { src, slides }
}

export function nodeAtPath(node: HNode, path: number[]): HNode | null {
  let n: HNode | undefined = node
  for (const i of path) {
    n = n?.children[i]
    if (!n) return null
  }
  return n ?? null
}

/** Tag outline of a subtree, for the parser-vs-browser self check. */
export function outline(node: HNode): string {
  return `${node.tag}(${node.children.map(outline).join(",")})`
}
