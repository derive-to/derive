/**
 * Exact-source editing for Markdown: the rendered editor's `ops` (source-edit.ts) applied
 * to Markdown source.
 *
 * The editor's page stamps `data-derive-src="N"` on every element drawn from a Markdown
 * construct, N being its index in a pre-order walk of marked's tokens (the root `<main>`
 * is 0). The walk records each construct's byte range, its content range, and the source
 * bytes of every character it renders (an entity is one character over many bytes; a soft
 * break is one newline over the next line's `> ` or indent). What can't be mapped exactly
 * is served read-only.
 *
 * A save rewrites only the content range of each element an op names. Its text is aligned
 * against the original, so untouched characters keep their bytes; typed text is written as
 * typed (Markdown is source), escaped only where it would break the element's own
 * structure. Editor formatting becomes `**`/`*`, `[…](href)` and a hard break, or HTML
 * where Markdown can't say it. A block kept twice (Enter) is written twice, separated as
 * its container separates blocks.
 */

import { Marked, Parser, Renderer, type Token, type Tokens } from "marked"
import { decodedEntitiesIn, decodeEntities } from "./anchor"
import { EditError } from "./doc-text"
import { newShortId } from "./ids"
import {
  escapeHtml,
  isSpecialFence,
  type RenderMarkdownOptions,
  renderDocShell,
  renderSpecialFence,
  stampSanitizer,
} from "./md"
import { MERMAID_HEAD } from "./mermaid"
import {
  hashSource,
  parseSourceOps,
  SourceConflictError,
  type SourceOp,
  type SourceToken,
  sourceSha,
  staleSourceIds,
} from "./source-edit"

type Kind =
  | "root"
  | "p"
  | "h"
  | "bq"
  | "list"
  | "li"
  | "tb"
  | "table"
  | "thead"
  | "tbody"
  | "tr"
  | "cell"
  | "pre"
  | "code"
  | "hr"
  | "strong"
  | "em"
  | "del"
  | "a"
  | "codespan"
  | "img"
  | "br"
  | "raw"

/** One rendered character run: `r` is what the page shows, the source bytes are [s, e).
 *  An atomic unit (an entity, an escape, a surrogate pair) is kept whole or not at all. */
interface Unit {
  s: number
  e: number
  r: string
  atomic: boolean
}

interface MdNode {
  /** Stamp id; -1 for what is never stamped (a tight item's text, an HTML block). */
  n: number
  kind: Kind
  start: number
  end: number
  cStart: number
  cEnd: number
  /** The continuation-line prefix where this node sits (`> ` inside a quote…). */
  linePrefix: string
  /** The continuation-line prefix inside its content. */
  prefix: string
  /** Content: text units and child nodes (inline), or child nodes (blocks). */
  seq: (Unit | MdNode)[]
  /** Whether an op may rewrite its content (mapped and verified). */
  editable: boolean
  /** Its content starts a line (a paragraph, a list item's text). */
  lineStart: boolean
  ctx: { cell?: boolean; link?: boolean; atx?: boolean; code?: "span" | "block" }
  /** Its text as rendered, filled in while rendering. */
  rendered?: string
  /** A fenced code block's fence. */
  fence?: string
}

const isUnit = (x: Unit | MdNode): x is Unit => "r" in x
const INLINE_KINDS = new Set<Kind>(["strong", "em", "del", "a", "codespan", "img", "br"])
const EMPHASIS = new Set<Kind>(["strong", "em", "del"])
const INLINE_CONTAINERS = new Set<Kind>([
  "p",
  "h",
  "tb",
  "cell",
  "strong",
  "em",
  "del",
  "a",
  "codespan",
  "code",
])
/** Inline HTML the model maps: the editor's own spellings where Markdown has none. */
const HTML_KINDS = new Map<string, Kind>([
  ["strong", "strong"],
  ["b", "strong"],
  ["em", "em"],
  ["i", "em"],
  ["del", "del"],
  ["s", "del"],
  ["br", "br"],
])

/** Normalized text (what the parser saw) with each character's source offset. */
interface Mapped {
  text: string
  at: number[]
}
const sliceMapped = (m: Mapped, a: number, b: number): Mapped => ({
  text: m.text.slice(a, b),
  at: m.at.slice(a, b + 1),
})

/** Map a container's text (its lines without the container's own prefix) onto the source
 *  lines it came from: each text line must end its source line. */
const alignLines = (text: string, src: Mapped): Mapped | null => {
  const lines = src.text.split("\n")
  const want = text.split("\n")
  if (want.length > lines.length) return null
  const at: number[] = []
  let off = 0
  for (let i = 0; i < want.length; i++) {
    const line = lines[i] as string
    const t = want[i] as string
    if (!line.endsWith(t)) return null
    const base = off + line.length - t.length
    for (let k = 0; k < t.length; k++) at.push(src.at[base + k] as number)
    at.push(src.at[i < want.length - 1 ? off + line.length : base + t.length] as number)
    off += line.length + 1
  }
  return { text, at }
}

/** A raw slice's length without its trailing blank lines and final newline. */
const trimmedLength = (raw: string): number => {
  let e = raw.length
  for (;;) {
    const nl = raw.lastIndexOf("\n", e - 1)
    if (nl < 0 || raw.slice(nl + 1, e).trim() !== "") return e
    e = nl
  }
}

/** Where a token's raw text (less trailing blank lines) is next in `text`, with only blank
 *  lines before it; -1 if it isn't. */
const locate = (text: string, raw: string, cur: number): number => {
  const at = text.indexOf(raw.slice(0, trimmedLength(raw)), cur)
  return at < 0 || text.slice(cur, at).trim() !== "" ? -1 : at
}

/** A table row's cells: content ranges (trimmed) within the line, split at unescaped pipes. */
const rowCells = (line: string): { s: number; e: number }[] => {
  const trim = (s: number, e: number) => {
    while (s < e && /[ \t]/.test(line[s] as string)) s++
    while (e > s && /[ \t]/.test(line[e - 1] as string)) e--
    return { s, e }
  }
  let { s: a, e: b } = trim(0, line.length)
  if (line[a] === "|") a++
  if (b > a && line[b - 1] === "|" && line[b - 2] !== "\\") b--
  const out: { s: number; e: number }[] = []
  for (let i = a, s = a; i <= b; i++)
    if (i === b || (line[i] === "|" && line[i - 1] !== "\\")) {
      out.push(trim(s, i))
      s = i + 1
    }
  return out
}

interface Model {
  source: string
  nodes: MdNode[]
  root: MdNode
  /** The node each token was drawn as, for the renderer. */
  nodeOf: Map<object, MdNode>
}

/** Walk the parser's tokens once, giving every construct its exact ranges. */
const buildModel = (source: string, tokens: Token[]): Model => {
  const nodeOf = new Map<object, MdNode>()
  const norm = source.replace(/\r\n|\r/g, "\n")
  const topAt: number[] = []
  for (let i = 0, j = 0; i <= norm.length; i++, j++) {
    topAt.push(j)
    if (norm[i] === "\n" && source[j] === "\r" && source[j + 1] === "\n") j++
  }
  const node = (
    kind: Kind,
    start: number,
    end: number,
    parent: MdNode | null,
    tok?: object,
  ): MdNode => {
    const n: MdNode = {
      n: -1,
      kind,
      start,
      end,
      cStart: start,
      cEnd: end,
      linePrefix: parent?.prefix ?? "",
      prefix: parent?.prefix ?? "",
      seq: [],
      editable: false,
      lineStart: false,
      ctx: { ...parent?.ctx },
    }
    parent?.seq.push(n)
    if (tok) nodeOf.set(tok, n)
    return n
  }

  /** Text as units: characters, surrogate pairs and (unless `raw`) entities. */
  const units = (m: Mapped, from: number, to: number, out: (Unit | MdNode)[], raw: boolean) => {
    const entities = new Map(
      raw
        ? []
        : decodedEntitiesIn(m.text, from, to)
            .filter((x) => m.text[x.end - 1] === ";")
            .map((x) => [x.start, x]),
    )
    for (let i = from; i < to; ) {
      const ent = entities.get(i)
      const c = m.text.charCodeAt(i)
      const end = ent?.end ?? i + (c >= 0xd800 && c < 0xdc00 && i + 1 < to ? 2 : 1)
      const r = ent?.text ?? m.text.slice(i, end)
      out.push({ s: m.at[i] as number, e: m.at[end] as number, r, atomic: end - i > 1 })
      i = end
    }
  }

  /** Map an inline container's tokens; what can't be mapped leaves it read-only. */
  const mapInline = (n: MdNode, list: Token[], m: Mapped) => {
    n.editable = inline(list, m, n)
    if (!n.editable) n.seq = []
  }

  /** Map inline tokens over `m` into `into`. False when something can't be mapped. */
  const inline = (list: Token[], m: Mapped, into: MdNode): boolean => {
    let cur = 0
    let target = into
    const open: { node: MdNode; tag: string; parent: MdNode }[] = []
    for (const tok of list) {
      const raw = tok.raw
      if (m.text.slice(cur, cur + raw.length) !== raw) return false
      const s = cur
      const e = s + raw.length
      const a = m.at[s] as number
      const b = m.at[e] as number
      if (tok.type === "text") units(m, s, e, target.seq, false)
      else if (tok.type === "escape") target.seq.push({ s: a, e: b, r: tok.text, atomic: true })
      else if (
        tok.type === "strong" ||
        tok.type === "em" ||
        tok.type === "del" ||
        tok.type === "link"
      ) {
        const link = tok.type === "link"
        const child = node(link ? "a" : (tok.type as Kind), a, b, target, tok)
        if (link) child.ctx.link = true
        // Its words sit between equal delimiters, or in a link's brackets.
        const text = tok.text as string
        const i = link ? 1 : (raw.length - text.length) / 2
        const j = i + text.length
        const words = link ? raw[0] === "[" && raw[j] === "]" : i > 0 && Number.isInteger(i)
        if (words && raw.slice(i, j) === text) {
          child.cStart = m.at[s + i] as number
          child.cEnd = m.at[s + j] as number
          mapInline(child, tok.tokens ?? [], sliceMapped(m, s + i, s + j))
        }
      } else if (tok.type === "codespan") {
        const child = node("codespan", a, b, target, tok)
        child.ctx.code = "span"
        const f = /^`+/.exec(raw)?.[0].length ?? 0
        if (
          f &&
          raw.length >= 2 * f &&
          raw.endsWith("`".repeat(f)) &&
          raw.slice(f, -f) === tok.text
        ) {
          child.cStart = m.at[s + f] as number
          child.cEnd = m.at[e - f] as number
          units(m, s + f, e - f, child.seq, true)
          child.editable = true
        }
      } else if (tok.type === "image" || tok.type === "br")
        node(tok.type === "br" ? "br" : "img", a, b, target, tok)
      else if (tok.type === "html") {
        // Emphasis tags opened and closed here, and `<br>`; any other tag is read-only.
        const tag = /^<(\/?)([a-z]+)\s*(\/?)>$/i.exec(raw)
        const name = tag?.[2]?.toLowerCase() ?? ""
        const kind = HTML_KINDS.get(name)
        if (!tag || !kind) return false
        if (kind === "br") {
          if (tag[1]) return false
          node("br", a, b, target, tok)
        } else if (!tag[1] && !tag[3]) {
          const child = node(kind, a, b, target, tok)
          child.cStart = b
          child.editable = true
          open.push({ node: child, tag: name, parent: target })
          target = child
        } else {
          const top = open.pop()
          if (!top || top.tag !== name || !tag[1]) return false
          top.node.cEnd = a
          top.node.end = b
          target = top.parent
        }
      } else return false
      cur = e
    }
    return !open.length && cur === m.text.length
  }

  /** Map block tokens over `m` as the children of `parent`. */
  const blocks = (list: Token[], m: Mapped, parent: MdNode): boolean => {
    let cur = 0
    for (const tok of list) {
      if (tok.type === "space") continue
      const raw = tok.raw
      // Without its trailing blank lines: a loose item's last block carries the blank line
      // after the item, which the item's own text stops before.
      const len = trimmedLength(raw)
      const at = locate(m.text, raw, cur)
      if (at < 0) return false
      cur = at + len
      const range = sliceMapped(m, at, cur)
      const start = range.at[0] as number
      const end = range.at[len] as number
      if (tok.type === "paragraph" || tok.type === "heading" || tok.type === "text") {
        const kind = tok.type === "paragraph" ? "p" : tok.type === "heading" ? "h" : "tb"
        const n = node(kind, start, end, parent, tok)
        const { text, tokens: inner } = tok as Tokens.Paragraph
        const atx = kind === "h" && /^ {0,3}#/.test(raw)
        const hashes = atx ? (/^ {0,3}#{1,6}[ \t]*/.exec(raw)?.[0].length ?? 0) : 0
        const off = kind === "h" ? raw.indexOf(text, hashes) : raw.startsWith(text) ? 0 : -1
        n.ctx.atx = atx
        n.lineStart = !atx
        if (off < 0 || !inner) continue
        const content = sliceMapped(m, at + off, at + off + text.length)
        n.cStart = content.at[0] as number
        n.cEnd = content.at[text.length] as number
        mapInline(n, inner, content)
      } else if (tok.type === "blockquote") {
        const n = node("bq", start, end, parent, tok)
        n.prefix += (/^ {0,3}> ?/.exec(raw)?.[0] ?? "> ").trimStart()
        const { text, tokens: kids } = tok as Tokens.Blockquote
        const inner = alignLines(text, range)
        n.editable = !!inner && blocks(kids, inner, n)
      } else if (tok.type === "list") {
        const n = node("list", start, end, parent, tok)
        n.editable = true
        let icur = 0
        for (const item of (tok as Tokens.List).items) {
          const iat = locate(range.text, item.raw, icur)
          if (iat < 0) {
            n.editable = false
            break
          }
          const ilen = trimmedLength(item.raw)
          icur = iat + ilen
          const ir = sliceMapped(range, iat, icur)
          const li = node("li", ir.at[0] as number, ir.at[ilen] as number, n, item)
          if (item.task) continue
          const first = ir.text.split("\n", 1)[0] as string
          const textFirst = item.text.split("\n", 1)[0] as string
          const indent = textFirst
            ? first.length - textFirst.length
            : (/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]*/.exec(first)?.[0].length ?? first.length)
          li.prefix += " ".repeat(Math.max(0, indent))
          const inner = alignLines(item.text.replace(/\n+$/, ""), ir)
          if (!inner) continue
          li.cStart = inner.at[0] as number
          li.editable = blocks(item.tokens, inner, li)
        }
      } else if (tok.type === "table") {
        const t = tok as Tokens.Table
        const n = node("table", start, end, parent, tok)
        const lines = range.text.split("\n")
        if (lines.length < 2 || lines.length - 2 !== t.rows.length) continue
        // Its parts keep their places (serializeParts); the cells hold the words.
        n.editable = true
        const lineAt: number[] = []
        for (let i = 0, off = 0; i < lines.length; off += (lines[i++] as string).length + 1)
          lineAt.push(off)
        const row = (li: number, part: MdNode, cells: Tokens.TableCell[]) => {
          const line = lines[li] as string
          const s = lineAt[li] as number
          const tr = node("tr", range.at[s] as number, range.at[s + line.length] as number, part)
          const found = rowCells(line)
          if (found.length !== cells.length) return
          tr.editable = true
          found.forEach((c, k) => {
            const cellTok = cells[k] as Tokens.TableCell
            const at = (i: number) => range.at[s + i] as number
            const cell = node("cell", at(c.s), at(c.e), tr, cellTok)
            cell.ctx.cell = true
            // The cell's text with `\|` read as `|`, each character on its source bytes.
            const cm: Mapped = { text: "", at: [] }
            for (let i = c.s; i < c.e; i++) {
              cm.at.push(at(i))
              if (line[i] === "\\" && line[i + 1] === "|" && i + 1 < c.e) i++
              cm.text += line[i]
            }
            cm.at.push(cell.end)
            if (cm.text === cellTok.text) mapInline(cell, cellTok.tokens, cm)
          })
        }
        const thead = node("thead", start, range.at[(lines[0] as string).length] as number, n)
        thead.editable = true
        row(0, thead, t.header)
        if (t.rows.length) {
          const tbody = node("tbody", range.at[lineAt[2] as number] as number, end, n)
          tbody.editable = true
          t.rows.forEach((cells, r) => {
            row(r + 2, tbody, cells)
          })
        }
      } else if (tok.type === "code") {
        const n = node("pre", start, end, parent, tok)
        const { text, lang } = tok as Tokens.Code
        const fence = /^ {0,3}(`{3,}|~{3,})/.exec(raw)
        const nl = raw.indexOf("\n")
        const bodyAt = nl < 0 ? len : nl + 1
        if (!fence || isSpecialFence(lang) || (nl < 0 && text)) continue
        if (raw.slice(bodyAt, bodyAt + text.length) !== text) continue
        const body = sliceMapped(m, at + bodyAt, at + bodyAt + text.length)
        const code = node("code", body.at[0] as number, body.at[text.length] as number, n)
        code.ctx.code = "block"
        code.fence = fence[1]
        units(body, 0, text.length, code.seq, true)
        // The renderer ends the block's text with a newline no source byte stands for.
        code.seq.push({ s: code.cEnd, e: code.cEnd, r: "\n", atomic: true })
        n.cStart = code.cStart
        n.cEnd = code.cEnd
        n.editable = true
        code.editable = true
        // An HTML block or a link definition has no element of ours: it is kept in place.
      } else node(tok.type === "hr" ? "hr" : "raw", start, end, parent, tok)
    }
    return m.text.slice(cur).trim() === ""
  }

  const root = node("root", 0, source.length, null)
  root.editable = blocks(tokens, { text: norm, at: topAt }, root)
  // Ids in walk order, over what the walk kept.
  const nodes: MdNode[] = []
  const number = (x: MdNode) => {
    if (x.kind !== "tb" && x.kind !== "raw") x.n = nodes.push(x) - 1
    for (const c of x.seq) if (!isUnit(c)) number(c)
  }
  number(root)
  return { source, nodes, root, nodeOf }
}

// ── Rendering ───────────────────────────────────────────────────────────────────────

/** Visible text of rendered HTML, for comparison only. Tags are stripped until none
 *  remain, so a nested `<<b>b>` can't leave a partial tag behind. */
const textOf = (html: string): string => {
  let out = html.replace(/\n$/, "")
  for (let prev = ""; prev !== out; ) {
    prev = out
    out = out.replace(/<[^>]*>/g, "")
  }
  return decodeEntities(out)
}
const predicted = (n: MdNode): string =>
  n.seq
    .map((x) => (isUnit(x) ? x.r : (x.rendered ?? predicted(x))))
    .join("")
    .replaceAll("\u00a0", " ")

/** Render tokens as the reader's page does, with every modeled construct stamped. An
 *  inline container whose rendered text isn't what the model predicts is read-only. */
const renderStamped = (
  model: Model,
  tokens: Token[],
  opts: RenderMarkdownOptions,
): { body: string; mermaid: boolean } => {
  const attr = `data-derive-s${newShortId()}${newShortId()}`
  let mermaid = false
  const nodeOf = (t: object) => model.nodeOf.get(t)
  const stamp = (html: string, n: MdNode | undefined, ro = false): string => {
    if (n && n.rendered === undefined) n.rendered = textOf(html)
    const value = `${n && n.n >= 0 ? n.n : ""}${ro ? "r" : ""}`
    if (!value) return html
    return html.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9]*)/, `$1 ${attr}="${value}"`)
  }
  const verify = (html: string, n: MdNode) => {
    n.rendered = textOf(html)
    if (n.editable && predicted(n) !== n.rendered) n.editable = false
  }
  const container = (html: string, t: object): string => {
    const n = nodeOf(t)
    if (!n) return html
    verify(html, n)
    return stamp(html, n, !n.editable)
  }
  const empty = (html: string, t: object): string => {
    const n = nodeOf(t)
    if (n) n.rendered = ""
    return stamp(html, n)
  }
  class Stamping extends Renderer {
    override paragraph(t: Tokens.Paragraph) {
      return container(super.paragraph(t), t)
    }
    override heading(t: Tokens.Heading) {
      return container(super.heading(t), t)
    }
    override tablecell(t: Tokens.TableCell) {
      return container(super.tablecell(t), t)
    }
    override strong(t: Tokens.Strong) {
      return container(super.strong(t), t)
    }
    override em(t: Tokens.Em) {
      return container(super.em(t), t)
    }
    override del(t: Tokens.Del) {
      return container(super.del(t), t)
    }
    override link(t: Tokens.Link) {
      return container(super.link(t), t)
    }
    override codespan(t: Tokens.Codespan) {
      return container(super.codespan(t), t)
    }
    override br(t: Tokens.Br) {
      return empty(super.br(t), t)
    }
    override image(t: Tokens.Image) {
      return empty(super.image(t), t)
    }
    override hr(t: Tokens.Hr) {
      return stamp(super.hr(t), nodeOf(t))
    }
    override text(t: Tokens.Text | Tokens.Escape) {
      // A tight item's text: unstamped, but it decides whether the item is editable.
      const html = super.text(t)
      const n = nodeOf(t)
      if (n?.kind === "tb") verify(html, n)
      return html
    }
    override blockquote(t: Tokens.Blockquote) {
      const n = nodeOf(t)
      return stamp(super.blockquote(t), n, !n?.editable)
    }
    override list(t: Tokens.List) {
      const n = nodeOf(t)
      return stamp(super.list(t), n, !n?.editable)
    }
    override listitem(t: Tokens.ListItem) {
      const n = nodeOf(t)
      const tb = n?.seq.find((x): x is MdNode => !isUnit(x) && x.kind === "tb")
      return stamp(super.listitem(t), n, !n?.editable || !!(tb && !tb.editable))
    }
    override table(t: Tokens.Table) {
      const n = nodeOf(t)
      const [thead, tbody] = (n?.seq ?? []) as (MdNode | undefined)[]
      const row = (cells: Tokens.TableCell[], tr: Unit | MdNode | undefined) =>
        stamp(`<tr>\n${cells.map((c) => this.tablecell(c)).join("")}</tr>\n`, tr as MdNode)
      const head = row(t.header, thead?.seq[0])
      const body = t.rows.map((cells, r) => row(cells, tbody?.seq[r])).join("")
      return stamp(
        `<table>\n${stamp("<thead>\n", thead)}${head}</thead>\n${body ? `${stamp("<tbody>", tbody)}${body}</tbody>` : ""}</table>\n`,
        n,
        !n?.editable,
      )
    }
    override code(t: Tokens.Code) {
      const n = nodeOf(t)
      const special = renderSpecialFence(t, opts, () => {
        mermaid = true
      })
      if (special !== false) return stamp(special, n, true)
      const html = super.code(t)
      const code = n?.seq[0] as MdNode | undefined
      if (!code) return stamp(html, n, true)
      verify(html, code)
      return stamp(html.replace(/<code\b/, stamp("<code", code, !code.editable)), n)
    }
    override html(t: Tokens.HTML | Tokens.Tag) {
      const n = nodeOf(t)
      // Authored HTML blocks are shown as written, never edited inline.
      if ("block" in t && t.block) {
        if (n) n.rendered = textOf(t.text)
        return stamp(t.text, undefined, true)
      }
      const html = stamp(t.text, n)
      // An emphasis tag's words are the tokens after it: read them from the model.
      if (n) n.rendered = n.kind === "br" ? "" : undefined
      return html
    }
  }
  const html = Parser.parse(tokens, { gfm: true, renderer: new Stamping() })
  const body = stampSanitizer(attr)
    .process(html)
    .replace(
      new RegExp(` ${attr}="(\\d*)(r?)"`, "g"),
      (_m, n: string, r: string) =>
        `${n ? ` data-derive-src="${n}"` : ""}${r ? " data-derive-readonly" : ""}`,
    )
  return { body, mermaid }
}

/** The model with its editable flags settled (they depend on the rendered text). */
const modelOf = (source: string, opts: RenderMarkdownOptions = {}) => {
  const tokens = new Marked({ gfm: true }).lexer(source)
  const model = buildModel(source, tokens)
  return { ...model, ...renderStamped(model, tokens, opts) }
}

const hashOf = (source: string, n: MdNode | undefined) =>
  n ? hashSource(source.slice(n.start, n.end)) : Promise.resolve("")

/**
 * The editor's view of a stored Markdown document: the reader's page, with
 * `data-derive-src` on every modeled element, `data-derive-readonly` on what can't be
 * edited in place, and the base identity (`data-derive-src-version`/`-sha`) on the root.
 */
export const renderMarkdownForEditor = async (
  source: string,
  title: string | null,
  base: { version: number },
  opts: RenderMarkdownOptions = {},
): Promise<string> => {
  const { body, mermaid } = modelOf(source, opts)
  const sha = await sourceSha(source)
  return renderDocShell(body, title, mermaid ? MERMAID_HEAD : "")
    .replace(
      '<html lang="en">',
      `<html lang="en" data-derive-src-version="${base.version}" data-derive-src-sha="${escapeHtml(sha)}">`,
    )
    .replace("<main data-derive-ready>", '<main data-derive-ready data-derive-src="0">')
}

/** The hash of every id's source bytes, as `sourceMap` gives them for HTML. */
export const markdownSourceMap = async (
  source: string,
): Promise<{ sha: string; hashes: string[] }> => {
  const { nodes } = modelOf(source)
  const [sha, hashes] = await Promise.all([
    sourceSha(source),
    Promise.all(nodes.map((n) => hashOf(source, n))),
  ])
  return { sha, hashes }
}

// ── Serializing ─────────────────────────────────────────────────────────────────────

type KeepToken = Extract<SourceToken, { keep: number }>
type TagToken = Extract<SourceToken, { tag: string }>

/** A run of the output: original bytes (`si` = its index in the node's content), typed
 *  text, or a construct. `nl` marks a run that ends a line. */
interface Piece {
  s: string
  kind: "orig" | "ins" | "node"
  si?: number
  nl?: boolean
}

/** What starts a block at a line's start. An ordered marker's digits are group 1: its
 *  `.`/`)` is what gets escaped. */
const BLOCK_START =
  /^(?:#{1,6}(?=[ \t]|$)|>|[-+*](?=[ \t]|$)|(\d{1,9})[.)](?=[ \t]|$)|`{3,}|~{3,}|([-*_])(?:[ \t]*\2){2,}[ \t]*$)/
const SETEXT = /^(?:=+|-+)[ \t]*$/

/** A save's context. `html`: emphasis is spelled `<strong>`/`<em>`, the fallback where
 *  Markdown's delimiters wouldn't read back as the page showed them. */
interface Serializer {
  model: Model
  html: boolean
}

const fail = (message: string): never => {
  throw new EditError(message)
}
const READ_ONLY = "That part of the document can't be edited inline. Use the source editor."

const reindent = (bytes: string, from: string, to: string): string => {
  if (from === to || !bytes.includes("\n")) return bytes
  return bytes
    .split("\n")
    .map((line, i) => {
      if (i === 0) return line
      if (line.startsWith(from)) return to + line.slice(from.length)
      if (line === from.trimEnd()) return to.trimEnd()
      return line
    })
    .join("\n")
}

/** Typed text as Markdown source: as typed, except what would break the element it
 *  was typed into. */
const typed = (text: string, n: MdNode): string => {
  let t = text.replace(/\u00a0/g, " ")
  if (n.ctx.code === "block") return t.replace(/\n/g, `\n${n.prefix}`)
  t = t.replace(/\n/g, " ")
  // A backslash is escaped with the character it would otherwise escape, so a typed
  // `\` can't swallow the escape that keeps the cell or the link text intact.
  if (n.ctx.cell) t = t.replace(/[\\|]/g, "\\$&")
  if (n.ctx.link && !n.ctx.code) t = t.replace(/[\\[\]]/g, "\\$&")
  return t
}

const isSpace = (c: string) => c === " " || c === "\n" || c === "\t" || c === "\u00a0"

/** Longest common subsequence alignment of `a` onto `b`: for each b index, the matched a
 *  index or -1. Trims the common ends first, so a typical edit costs its own size. */
const align = (a: string[], b: string[], eq: (x: string, y: string) => boolean): number[] => {
  const out = new Array<number>(b.length).fill(-1)
  let p = 0
  while (p < a.length && p < b.length && eq(a[p] as string, b[p] as string)) {
    out[p] = p
    p++
  }
  let q = 0
  while (
    q < a.length - p &&
    q < b.length - p &&
    eq(a[a.length - 1 - q] as string, b[b.length - 1 - q] as string)
  ) {
    out[b.length - 1 - q] = a.length - 1 - q
    q++
  }
  const n = a.length - p - q
  const m = b.length - p - q
  if (n === 0 || m === 0) return out
  if (n * m > 4_000_000)
    fail("That edit rewrote too much of one block to save inline. Use the source editor.")
  const dp = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * (m + 1) + j] = eq(a[p + i] as string, b[p + j] as string)
        ? (dp[(i + 1) * (m + 1) + j + 1] as number) + 1
        : Math.max(dp[(i + 1) * (m + 1) + j] as number, dp[i * (m + 1) + j + 1] as number)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (eq(a[p + i] as string, b[p + j] as string)) {
      out[p + j] = p + i
      i++
      j++
    } else if ((dp[(i + 1) * (m + 1) + j] as number) >= (dp[i * (m + 1) + j + 1] as number)) i++
    else j++
  }
  return out
}

/** An inline container's new content: its original text aligned against the new, the
 *  unchanged characters written back as their original bytes. */
const inlinePieces = (z: Serializer, n: MdNode, tokens: SourceToken[]): Piece[] => {
  const src = z.model.source
  // One symbol per original rendered character, or child node, with its index in `seq`.
  const aSym: string[] = []
  const aSi: number[] = []
  n.seq.forEach((x, si) => {
    for (const c of isUnit(x) ? x.r.split("") : [`\u0000${x.n}`]) {
      aSym.push(c)
      aSi.push(si)
    }
  })
  const bSym: string[] = []
  const bTok: (SourceToken | null)[] = []
  for (const t of tokens)
    if ("text" in t)
      for (const c of t.text.split("")) {
        bSym.push(c)
        bTok.push(null)
      }
    else {
      bSym.push("keep" in t ? `\u0000${t.keep}` : "\u0000new")
      bTok.push(t)
    }
  const loose = n.ctx.code === undefined
  const match = align(
    aSym,
    bSym,
    (x, y) => x === y || (loose && x.length === 1 && y.length === 1 && isSpace(x) && isSpace(y)),
  )
  // An atomic unit stays only when every character of it matched, in one run.
  const hits = new Map<number, number[]>()
  match.forEach((ai, bi) => {
    if (ai >= 0) hits.set(aSi[ai] as number, [...(hits.get(aSi[ai] as number) ?? []), bi])
  })
  for (const [si, bis] of hits) {
    const u = n.seq[si] as Unit | MdNode
    if (!isUnit(u) || !u.atomic) continue
    if (bis.length !== u.r.length || bis.some((b, i) => i > 0 && b !== (bis[i - 1] as number) + 1))
      for (const b of bis) match[b] = -1
  }

  const pieces: Piece[] = []
  const emitted = new Set<number>()
  let ins = ""
  const flush = () => {
    if (ins) pieces.push({ s: typed(ins, n), kind: "ins" })
    ins = ""
  }
  bSym.forEach((sym, bi) => {
    const t = bTok[bi]
    const ai = match[bi] as number
    const si = ai >= 0 ? (aSi[ai] as number) : undefined
    if (!t) {
      if (si === undefined) ins += sym
      else if (!emitted.has(si)) {
        flush()
        emitted.add(si)
        const u = n.seq[si] as Unit
        pieces.push({ s: src.slice(u.s, u.e), kind: "orig", si, nl: u.r === "\n" })
      }
      return
    }
    flush()
    const out = emitToken(z, n, t)
    const brk =
      ("tag" in t && t.tag === "br") || ("keep" in t && z.model.nodes[t.keep]?.kind === "br")
    pieces.push({ s: out, kind: "node", si, nl: brk && /\n[^\n]*$/.test(out) })
  })
  flush()
  return pieces
}

const joined = (pieces: Piece[]): string => pieces.map((p) => p.s).join("")

/** An inline container's new content, as Markdown. */
const serializeInline = (z: Serializer, n: MdNode, tokens: SourceToken[]): string => {
  const out = joined(finishInline(n, inlinePieces(z, n, tokens)))
  // An ATX heading drops a closing run of #s: keep a typed one as text.
  return n.ctx.atx && n.kind === "h" ? out.replace(/(^|[ \t])(#+[ \t]*)$/, "$1\\$2") : out
}

/** Emphasis around content: what sits at its edges and can't be emphasized (space, a
 *  line break, a line's prefix) moves outside the delimiters, and nothing is left of it
 *  when the content is gone. */
const wrapPieces = (pieces: Piece[], [open, close]: [string, string]): string => {
  const edge = (p: Piece) => !!p.nl || p.s.trim() === ""
  let a = 0
  while (a < pieces.length && edge(pieces[a] as Piece)) a++
  let b = pieces.length
  while (b > a && edge(pieces[b - 1] as Piece)) b--
  if (a === b) return joined(pieces)
  const core = pieces.slice(a, b).map((p) => ({ ...p }))
  let lead = ""
  let trail = ""
  const first = core[0] as Piece
  if (first.kind === "ins") {
    lead = /^\s*/.exec(first.s)?.[0] ?? ""
    first.s = first.s.slice(lead.length)
  }
  const last = core.at(-1) as Piece
  if (last.kind === "ins") {
    trail = /\s*$/.exec(last.s)?.[0] ?? ""
    last.s = last.s.slice(0, last.s.length - trail.length)
  }
  return `${joined(pieces.slice(0, a))}${lead}${open}${joined(core)}${close}${trail}${joined(pieces.slice(b))}`
}

/** How emphasis is delimited: as a tag when the save spells it as HTML, else a kept run's
 *  own delimiters, or `**`/`*` for a new one. */
const delimiters = (z: Serializer, kind: Kind, kept?: MdNode): [string, string] => {
  if (z.html) return [`<${kind}>`, `</${kind}>`]
  if (kept)
    return [
      z.model.source.slice(kept.start, kept.cStart),
      z.model.source.slice(kept.cEnd, kept.end),
    ]
  return kind === "strong" ? ["**", "**"] : ["*", "*"]
}

/** One non-text token inside an inline container, as Markdown. */
const emitToken = (z: Serializer, n: MdNode, t: SourceToken): string => {
  if ("comment" in t) return `<!--${t.comment}-->`
  if ("tag" in t) return emitTag(z, n, t)
  const k = z.model.nodes[(t as KeepToken).keep] as MdNode
  if (!INLINE_KINDS.has(k.kind))
    fail(
      "A paragraph can only hold words, links and formatting. Use the source editor to move blocks.",
    )
  const src = z.model.source
  const { children } = t as KeepToken
  // Spelled as HTML, kept emphasis is too: two runs that now touch (`**a****b**`) only
  // parse apart as tags.
  const bytes = children
    ? rewrite(z, k, children)
    : z.html && EMPHASIS.has(k.kind) && k.editable
      ? wrapPieces([{ s: src.slice(k.cStart, k.cEnd), kind: "orig" }], delimiters(z, k.kind))
      : src.slice(k.start, k.end)
  return reindent(bytes, k.linePrefix, n.prefix)
}

/** A kept construct with new content: its own delimiters (or a block's marker and
 *  suffix) around it. */
const rewrite = (z: Serializer, k: MdNode, children: SourceToken[]): string => {
  if (!k.editable) fail(READ_ONLY)
  if (EMPHASIS.has(k.kind))
    return wrapPieces(finishInline(k, inlinePieces(z, k, children)), delimiters(z, k.kind, k))
  const inner = serializeContent(z, k, children)
  if (k.kind === "codespan") return codespan(inner)
  // An emptied link leaves its space; an emptied paragraph is gone (Markdown has none).
  if (!inner.trim() && (k.kind === "a" || k.kind === "p")) return k.kind === "a" ? inner : ""
  return z.model.source.slice(k.start, k.cStart) + inner + z.model.source.slice(k.cEnd, k.end)
}

const codespan = (inner: string): string => {
  if (!inner) return ""
  const run = Math.max(0, ...(inner.match(/`+/g) ?? []).map((r) => r.length))
  const fence = "`".repeat(run + 1)
  // A space pads a fence from a backtick, and keeps a space at both ends that the
  // renderer would otherwise strip one of.
  const pad =
    inner.startsWith("`") ||
    inner.endsWith("`") ||
    (inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "")
      ? " "
      : ""
  return fence + pad + inner + pad + fence
}

const tagKind = (tag: TagToken["tag"]): Kind =>
  tag === "br" ? "br" : tag === "a" ? "a" : tag === "b" || tag === "strong" ? "strong" : "em"

/** Editor formatting as Markdown. */
const emitTag = (z: Serializer, n: MdNode, t: TagToken): string => {
  const children = t.children ?? []
  if (t.tag === "br") {
    if (n.ctx.code) return n.ctx.code === "block" ? `\n${n.prefix}` : " "
    // An ATX heading and a table cell are one line: only HTML can break them.
    return n.ctx.cell || n.ctx.atx ? "<br>" : `\\\n${n.prefix}`
  }
  const kind = tagKind(t.tag)
  // New content inside `n`: its context, none of its text. Code holds no formatting: its
  // words stay, as code.
  const host: MdNode = { ...n, seq: [], lineStart: false, ctx: { ...n.ctx } }
  if (n.ctx.code) return serializeInline(z, host, children)
  host.kind = kind
  if (kind === "a") {
    if (n.ctx.link) fail("That edit would put a link inside a link.")
    host.ctx.link = true
    const inner = serializeInline(z, host, children)
    const href = t.href ?? ""
    const dest = /[\s()<>]/.test(href) ? `<${href.replace(/[\\<>]/g, "\\$&")}>` : href
    return inner.trim() ? `[${inner}](${dest})` : inner
  }
  return wrapPieces(finishInline(host, inlinePieces(z, host, children)), delimiters(z, kind))
}

/** Settle an inline container's pieces: nothing typed may start a new block at a line
 *  start, a break needs text after it, and typed space at the edges of a block is dropped. */
const finishInline = (n: MdNode, pieces: Piece[]): Piece[] => {
  if (n.ctx.code) return pieces
  if (n.kind === "p" || n.kind === "tb" || n.kind === "cell" || n.kind === "h") {
    // Typed space at a block's edges is never shown, and a line break at either end
    // renders as a literal backslash: both go.
    const edge = (p: Piece | undefined) =>
      !!p && p.kind !== "orig" && (p.s.trim() === "" || (p.kind === "node" && !!p.nl))
    while (edge(pieces[0])) pieces.shift()
    while (edge(pieces.at(-1))) pieces.pop()
    const first = pieces[0]
    if (first?.kind === "ins") first.s = first.s.trimStart()
    const last = pieces.at(-1)
    if (last?.kind === "ins") last.s = last.s.trimEnd()
  }
  // Line starts: the content start (when it starts a line) and after every line end.
  const starts: number[] = n.lineStart ? [0] : []
  pieces.forEach((p, i) => {
    if (p.nl) starts.push(i + 1)
  })
  for (const k of starts) {
    if (k >= pieces.length) continue
    const first = pieces[k] as Piece
    const prev = pieces[k - 1]
    if (first.si !== undefined && (k === 0 ? first.si === 0 : prev?.si === first.si - 1)) continue
    // Leading space on a new line is never shown; four of it would start code.
    while (k < pieces.length && (pieces[k] as Piece).kind !== "node") {
      const p = pieces[k] as Piece
      const trimmed = p.s.replace(/^[ \t]+/, "")
      if (trimmed === p.s) break
      if (trimmed) {
        p.s = trimmed
        break
      }
      pieces.splice(k, 1)
    }
    let line = ""
    for (let i = k; i < pieces.length; i++) {
      const s = (pieces[i] as Piece).s
      const nl = s.indexOf("\n")
      line += nl < 0 ? s : s.slice(0, nl)
      if (nl >= 0 || (pieces[i] as Piece).nl) break
    }
    const m = BLOCK_START.exec(line)
    const at = m ? (m[1]?.length ?? 0) : k > 0 && SETEXT.test(line) ? 0 : -1
    if (at < 0) continue
    // Escape the marker character where it sits.
    for (let i = k, off = 0; i < pieces.length; i++) {
      const p = pieces[i] as Piece
      if (at < off + p.s.length) {
        if (p.kind !== "node") p.s = `${p.s.slice(0, at - off)}\\${p.s.slice(at - off)}`
        break
      }
      off += p.s.length
    }
  }
  return pieces
}

/** Formatting the browser wrapped around whole blocks (bold over a nested list) can't
 *  be written: the blocks come out of it, the words around them keep it. */
const liftBlocks = (z: Serializer, tokens: SourceToken[]): SourceToken[] => {
  const isBlock = (t: SourceToken) => {
    const k = "keep" in t ? z.model.nodes[t.keep] : undefined
    return !!k && !INLINE_KINDS.has(k.kind)
  }
  const holds = (t: SourceToken): boolean =>
    isBlock(t) || ("tag" in t && (t.children ?? []).some(holds))
  return tokens.flatMap((t): SourceToken[] => {
    if (!("tag" in t) || !holds(t)) return [t]
    const out: SourceToken[] = []
    let run: SourceToken[] = []
    const flush = () => {
      if (run.length) out.push({ ...t, children: run })
      run = []
    }
    for (const c of liftBlocks(z, t.children ?? []))
      if (isBlock(c)) {
        flush()
        out.push(c)
      } else run.push(c)
    flush()
    return out
  })
}

/** Blocks inside a container: kept blocks in their new order, each written with the
 *  separator it had from its original neighbour, or the container's own. */
const serializeBlocks = (z: Serializer, n: MdNode, tokens: SourceToken[]): string => {
  const src = z.model.source
  const kids = n.seq.filter((x): x is MdNode => !isUnit(x))
  type Item = { orig?: MdNode; node?: MdNode; bytes: string }
  const items: Item[] = []
  const firstEmit = new Set<MdNode>()
  const inlineGroup: SourceToken[] = []
  const words = (host: MdNode, kind: Kind, group: SourceToken[]) =>
    serializeInline(
      z,
      { ...host, kind, linePrefix: host.prefix, seq: [], lineStart: true, editable: true },
      group,
    )
  const flushInline = () => {
    const group = inlineGroup.splice(0)
    if (!group.length) return
    const tb = kids[0]
    if (n.kind === "li" && tb?.kind === "tb" && !items.length && !firstEmit.has(tb)) {
      firstEmit.add(tb)
      items.push({ orig: tb, node: tb, bytes: serializeInline(z, tb, group) })
      return
    }
    if (group.every((t) => "text" in t && t.text.trim() === "")) return
    // Words the browser put between blocks (typed past a list's last item): in a list
    // they continue the item before them, elsewhere they are a paragraph of their own.
    if (n.kind === "list") {
      const prev = items.at(-1)
      if (!prev?.node) return fail("Text can only be typed inside a list item.")
      const line = words(prev.node, "tb", group)
      if (line) prev.bytes += `\n${prev.node.prefix}${line}`
      return
    }
    if (n.kind === "tbody") fail("Text can only be typed inside a table cell.")
    items.push({ bytes: words(n, "p", group) })
  }
  for (const t of liftBlocks(z, tokens)) {
    const k = "keep" in t ? z.model.nodes[t.keep] : undefined
    if (!k || INLINE_KINDS.has(k.kind)) {
      inlineGroup.push(t)
      continue
    }
    flushInline()
    if (k.kind === "li" && n.kind !== "list") fail("A list item can only move within a list.")
    if (k.kind !== "li" && n.kind === "list") fail("A list can only hold list items.")
    if ((k.kind === "tr") !== (n.kind === "tbody"))
      fail("A table row can only move within its table.")
    const { children } = t as KeepToken
    const bytes = children ? rewrite(z, k, children) : src.slice(k.start, k.end)
    const orig = kids.includes(k) && !firstEmit.has(k) ? k : undefined
    if (orig) firstEmit.add(orig)
    items.push({ orig, node: k, bytes: reindent(bytes, k.linePrefix, n.prefix) })
  }
  flushInline()
  if (n.kind === "li" && kids[0]?.kind === "tb" && !firstEmit.has(kids[0])) {
    // Every word of the item's own text was deleted.
    items.unshift({ orig: kids[0], node: kids[0], bytes: "" })
  }
  // What has no element of ours (an HTML block, a link definition) stays where it was:
  // after the kept block that preceded it.
  kids.forEach((k, i) => {
    if (k.kind !== "raw") return
    let at = 0
    for (let j = i - 1; j >= 0 && !at; j--) at = items.findIndex((it) => it.orig === kids[j]) + 1
    items.splice(at, 0, { orig: k, bytes: src.slice(k.start, k.end) })
  })
  const sep = (i: number): string =>
    src.slice((kids[i] as MdNode).end, (kids[i + 1] as MdNode).start)
  // A tight item's text and its nested list sit on consecutive lines; a loose item's
  // paragraphs are blank-line separated, even when it had only one.
  const tight =
    n.kind === "list" ||
    n.kind === "tbody" ||
    (n.kind === "li" &&
      !kids.some((k) => k.kind === "p") &&
      !kids.some((_k, i) => i > 0 && /\n[ \t>]*\n/.test(sep(i - 1))))
  const fallback =
    n.kind === "list" && kids.length > 1
      ? sep(0)
      : tight
        ? `\n${n.prefix}`
        : `\n${n.prefix.trimEnd()}\n${n.prefix}`
  const live = items.filter((it) => it.bytes !== "" || it.orig?.kind === "tb")
  const out = live.map((it, i) => {
    const prev = live[i - 1]
    if (!prev) return it.bytes
    const pi = prev.orig ? kids.indexOf(prev.orig) : -1
    return (pi >= 0 && it.orig && kids.indexOf(it.orig) === pi + 1 ? sep(pi) : fallback) + it.bytes
  })
  const lead = kids[0] ? src.slice(n.cStart, kids[0].start) : ""
  const tail = kids.length ? src.slice((kids.at(-1) as MdNode).end, n.cEnd) : ""
  return lead + out.join("") + tail
}

/** A table part (a row, the head, the table itself, named whole when a split elsewhere
 *  changes its container): the same parts in the same order, each rewritten in place. */
const serializeParts = (z: Serializer, n: MdNode, tokens: SourceToken[]): string => {
  const src = z.model.source
  const parts = n.seq.filter((x): x is MdNode => !isUnit(x))
  const kept = tokens.filter((t) => !("text" in t && t.text.trim() === ""))
  if (
    kept.length !== parts.length ||
    kept.some((t, i) => !("keep" in t) || t.keep !== (parts[i] as MdNode).n)
  )
    fail(
      n.kind === "tr"
        ? "A Markdown table row keeps its cells: type inside a cell instead."
        : "A Markdown table keeps its rows: type inside a cell instead.",
    )
  let out = ""
  let cursor = n.cStart
  kept.forEach((t, i) => {
    const c = parts[i] as MdNode
    const { children } = t as KeepToken
    out += src.slice(cursor, c.cStart)
    out += children ? serializeContent(z, c, children) : src.slice(c.cStart, c.cEnd)
    cursor = c.cEnd
  })
  return out + src.slice(cursor, n.cEnd)
}

/** A node's new content (what replaces [cStart, cEnd)). */
const serializeContent = (z: Serializer, n: MdNode, tokens: SourceToken[]): string => {
  if (!n.editable) fail(READ_ONLY)
  if (n.kind === "pre") {
    const code = n.seq[0] as MdNode
    const only = tokens.length === 1 ? tokens[0] : undefined
    if (only && "keep" in only && only.keep === code.n)
      return only.children
        ? serializeContent(z, code, only.children)
        : z.model.source.slice(code.cStart, code.cEnd)
    return serializeContent(z, code, tokens)
  }
  if (n.kind === "code") {
    const body = serializeInline(z, n, tokens).replace(/\n$/, "")
    const fence = n.fence as string
    const closes = body.split("\n").some((l) => {
      const m = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/.exec(l)?.[1]
      return !!m && m[0] === fence[0] && m.length >= fence.length
    })
    if (closes) fail("A line in that code block would end it early. Use the source editor.")
    return body
  }
  if (INLINE_CONTAINERS.has(n.kind)) return serializeInline(z, n, tokens)
  if (n.kind === "tr" || n.kind === "table" || n.kind === "thead")
    return serializeParts(z, n, tokens)
  // The block containers: root, a quote, a list, an item, a table body.
  return serializeBlocks(z, n, tokens)
}

// ── Apply ───────────────────────────────────────────────────────────────────────────

export interface AppliedMarkdownOps {
  markdown: string
  /** Each op's content before and after, for the review summary. */
  changes: { before: string; after: string }[]
}

/** A reading: the text a reader sees, character by character with the formatting it
 *  carries (sorted marks), element boundaries (\u00b6), breaks and images. Whitespace
 *  collapses and vanishes at a block's edge, as on the page. */
const settle = (out: string[]): string => {
  const flat: string[] = []
  for (const t of out) {
    const prev = flat.at(-1)
    // Space at a line's edge (a block's, a break's) is never shown.
    if (t === " " && (prev === undefined || prev === " " || prev === "\u00b6" || prev === "\u23ce"))
      continue
    if ((t === "\u00b6" || t === "\u23ce") && prev === " ") flat.pop()
    if (t === "\u00b6" && flat.at(-1) === "\u00b6") continue
    // A break at a block's edge shows nothing (and the save drops it).
    if (t === "\u23ce" && (prev === undefined || prev === "\u00b6")) continue
    if (t === "\u00b6" && flat.at(-1) === "\u23ce") flat.pop()
    flat.push(t)
  }
  if (flat.at(-1) === " ") flat.pop()
  return flat.join("\u0002")
}
const MARK: Partial<Record<Kind, string>> = {
  strong: "s",
  em: "e",
  del: "d",
  a: "a",
  code: "c",
  codespan: "c",
}

/** How a model (or a save's intended model) reads. */
const readingOfModel = (n: MdNode): string => {
  const out: string[] = []
  const chars = (text: string, marks: string[]) => {
    const m = [...new Set(marks)].sort().join("")
    for (const ch of text) out.push(isSpace(ch) ? " " : `${ch}${m}`)
  }
  const walk = (x: MdNode, marks: string[]) => {
    const mark = MARK[x.kind]
    const m = mark ? [...marks, mark] : marks
    const block = !INLINE_KINDS.has(x.kind) && x.kind !== "tb"
    if (block) out.push("\u00b6")
    if (x.kind === "br") out.push("\u23ce")
    if (x.kind === "img") out.push("\ufffc")
    for (const c of x.seq)
      if (isUnit(c)) chars(c.r, m)
      else walk(c, m)
    if (!x.seq.length && x.rendered) chars(x.rendered, m)
    if (block) out.push("\u00b6")
  }
  walk(n, [])
  return settle(out)
}

/** A node as the save means it to read: the op's children in place of its content,
 *  each kept construct as it was (or with its own new children). */
const expectedNode = (model: Model, host: MdNode, tokens: SourceToken[]): MdNode => {
  const seq: (Unit | MdNode)[] = []
  for (const t of tokens) {
    if ("text" in t) {
      if (INLINE_CONTAINERS.has(host.kind) || host.kind === "li")
        seq.push({ s: 0, e: 0, r: t.text, atomic: false })
    } else if ("tag" in t) {
      // Code holds no formatting: its words stay plain code.
      const kind = host.ctx.code ? host.kind : tagKind(t.tag)
      const inner = expectedNode(model, { ...host, kind, seq: [] }, t.children ?? [])
      if (host.ctx.code) seq.push(...inner.seq)
      else seq.push(inner)
    } else if ("keep" in t) {
      const k = model.nodes[t.keep] as MdNode
      seq.push(t.children ? expectedNode(model, k, t.children) : k)
    }
  }
  // Its words are exactly these tokens (an emptied construct reads as nothing).
  return { ...host, seq, rendered: "" }
}

/**
 * Apply an editor save to stored Markdown. Atomic, as `applySourceOps`: a changed
 * referenced construct throws `SourceConflictError` (409), a malformed or unsupported
 * save `EditError` (400).
 */
export const applyMarkdownOps = async (
  source: string,
  raw: unknown,
): Promise<AppliedMarkdownOps> => {
  const ops = parseSourceOps(raw)
  for (const op of ops)
    if (op.op !== "content") fail("A Markdown document has no layout to change inline.")
  const model = modelOf(source)
  const place = (n: number) => `element ${n}`
  const conflicts = await staleSourceIds(ops, (n) => hashOf(source, model.nodes[n]), place)
  if (conflicts.length)
    throw new SourceConflictError(
      `${conflicts.length === 1 ? "A part of the document" : `${conflicts.length} parts of the document`} changed since this page was loaded. Reload to see the latest version, then redo ${conflicts.length === 1 ? "that edit" : "those edits"}.`,
      conflicts,
    )
  const targets = (ops as Extract<SourceOp, { op: "content" }>[])
    .map(({ src, children }) => ({ children, node: model.nodes[src] as MdNode }))
    .sort((a, b) => a.node.start - b.node.start)
  targets.forEach(({ node }, i) => {
    const prev = targets[i - 1]?.node
    if (prev && node.start < prev.end)
      fail(`${place(node.n)} is inside ${place(prev.n)}, which the same save also edits.`)
  })

  // An edit inside emphasis, a link or a code span rewrites the whole run: its delimiters
  // depend on its content (space moves out of `**`, a typed backtick needs a longer fence,
  // an emptied run goes).
  const whole = (node: MdNode) => INLINE_KINDS.has(node.kind)
  const range = (node: MdNode): [number, number] =>
    whole(node) ? [node.start, node.end] : [node.cStart, node.cEnd]
  const spell = (html: boolean) =>
    targets.map(({ node, children }) =>
      whole(node)
        ? rewrite({ model, html }, node, children)
        : serializeContent({ model, html }, node, children),
    )
  const assemble = (texts: string[]) => {
    let out = ""
    let cursor = 0
    const at: number[] = []
    targets.forEach(({ node }, k) => {
      const [from, to] = range(node)
      out += source.slice(cursor, from)
      at.push(out.length)
      out += texts[k] as string
      cursor = to
    })
    return { markdown: out + source.slice(cursor), at }
  }
  // Each op must read back as the page showed it. Emphasis delimiters are the one thing
  // that may not (a run meeting another, `**x.**y`): such an op spells its emphasis as
  // HTML when that reads back right. Typed Markdown reads differently on purpose; HTML
  // doesn't fix that, and the Markdown spelling stays.
  const reading = targets.map(({ node, children }) =>
    readingOfModel(expectedNode(model, node, children)),
  )
  const misread = (texts: string[], only?: number): number[] => {
    const { markdown, at } = assemble(texts)
    const next = modelOf(markdown)
    return targets.flatMap(({ node }, k) => {
      if (only !== undefined && k !== only) return []
      const start = at[k] as number
      const end = start + (texts[k] as string).length
      // The same construct where its new text landed (a block drops space at its edges).
      const got = next.nodes
        .filter((x) => x.kind === node.kind && x.cStart >= start && x.cEnd <= end)
        .sort((a, b) => a.cStart - b.cStart || b.cEnd - a.cEnd)[0]
      return got && readingOfModel(got) === reading[k] ? [] : [k]
    })
  }
  let texts = spell(false)
  const bad = misread(texts)
  const html = bad.length ? spell(true) : []
  for (const k of bad) {
    const trial = [...texts]
    trial[k] = html[k] as string
    if (!misread(trial, k).length) texts = trial
  }
  const markdown = assemble(texts).markdown
  if (markdown === source)
    fail("These ops leave the document exactly as it is, so there is nothing to save.")
  return {
    markdown,
    changes: targets.map(({ node }, k) => ({
      before: source.slice(...range(node)),
      after: texts[k] as string,
    })),
  }
}
