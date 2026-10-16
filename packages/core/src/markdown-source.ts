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
import { newShortId } from "./ids"
import {
  escapeHtml,
  isSpecialFence,
  type RenderMarkdownOptions,
  renderDocShell,
  renderSpecialFence,
  stampSanitizer,
} from "./md"
import { lastOf } from "./memo"
import { MERMAID_HEAD } from "./mermaid"
import {
  applyMarkdownSourceOps,
  hashSource,
  hostMarker,
  markdownUnit as isUnit,
  type MarkdownSourceKind as Kind,
  type MarkdownSourceNode as MdNode,
  type MarkdownSourceModel as Model,
  sourceSha,
  type MarkdownSourceUnit as Unit,
} from "./source-edit"

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
const modelWith = (source: string, opts: RenderMarkdownOptions) => {
  const tokens = new Marked({ gfm: true }).lexer(source)
  const model = buildModel(source, tokens)
  return { ...model, ...renderStamped(model, tokens, opts) }
}
/** A save, its sync and the next save's source map all model the same document: once.
 *  Shared, so read-only. */
const plainModel = lastOf(3, 16_384, (source: string) => modelWith(source, {}))
const modelOf = (source: string, opts?: RenderMarkdownOptions) =>
  opts && Object.keys(opts).length ? modelWith(source, opts) : plainModel(source)

const hashOf = async (source: string, n: MdNode | undefined): Promise<string> =>
  n ? hashSource(source.slice(n.start, n.end)) : ""

/**
 * The editor's view of a stored Markdown document: the reader's page, with
 * `data-derive-src` on every modeled element, `data-derive-readonly` on what can't be
 * edited in place, and the base identity (`data-derive-src-version`/`-sha`) and the
 * origins that may drive the editor (`data-derive-host`) on the root.
 */
export const renderMarkdownForEditor = async (
  source: string,
  title: string | null,
  base: { version: number; host?: string },
  opts: RenderMarkdownOptions = {},
): Promise<string> => {
  const { body, mermaid } = modelOf(source, opts)
  const sha = await sourceSha(source)
  return renderDocShell(body, title, mermaid ? MERMAID_HEAD : "")
    .replace(
      '<html lang="en">',
      `<html lang="en" data-derive-src-version="${base.version}" data-derive-src-sha="${escapeHtml(sha)}"${hostMarker(base.host)}>`,
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

export type { AppliedMarkdownSourceOps as AppliedMarkdownOps } from "./source-edit"

export const applyMarkdownOps = (
  source: string,
  raw: unknown,
  historySource?: (version: number) => Promise<string | null>,
): Promise<import("./source-edit").AppliedMarkdownSourceOps> =>
  applyMarkdownSourceOps(source, raw, { parse: modelOf, hash: hashOf, load: historySource })
