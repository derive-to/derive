/**
 * Exact-source editing for Markdown: the rendered editor's `ops` (source-edit.ts) applied
 * to Markdown source.
 *
 * An editor is served the page with `data-derive-src="N"` on every element the renderer
 * drew from a Markdown construct (a paragraph, a list item, a table cell, a `**strong**`
 * run, a link, a code span…), N being that construct's index in one pre-order walk of the
 * parser's tokens, and the root `<main>` as 0. The walk also knows each construct's exact
 * byte range, its content range, and how every rendered character of its text maps back to
 * source bytes (an entity is one character over many bytes; a soft line break is one
 * newline over the next line's `> ` or list indent). What cannot be mapped exactly is
 * served read-only, never guessed at.
 *
 * A save rewrites only the content range of each element an op names:
 *  - text is aligned against the element's original rendered text, so every character the
 *    person did not touch is written back as its original bytes (entities, escapes, line
 *    prefixes included); what they typed is written as typed — Markdown is source, so
 *    typing `**x**` makes bold — escaped only where it would otherwise break the element's
 *    own structure (a `|` in a table cell, a list marker at the start of a line…);
 *  - `keep` copies a construct's original bytes, or its delimiters around new content;
 *  - editor formatting becomes Markdown: bold `**…**`, italic `*…*`, a link `[…](href)`,
 *    a line break a hard break (`\` + newline + the block's continuation prefix; `<br>`
 *    in a table cell or a heading, which are one line). Each op must read back as the
 *    page showed it, so where a delimiter can't open or close where it sits (`**x.**y`,
 *    two runs meeting) the op is spelled with `__`/`_`, then with `<strong>`/`<em>`;
 *  - a block kept twice (Enter splitting a paragraph or list item) is written twice,
 *    separated as its container separates blocks (a blank line, or the next list item).
 * Every byte outside the edited content ranges is untouched.
 */

import { Marked, Renderer, type Token, type Tokens } from "marked"
import { decodedEntitiesIn, decodeEntities } from "./anchor"
import { EditError } from "./doc-text"
import { parseDynamicFence } from "./dynamic-data"
import { sha256Hex } from "./hash"
import { newShortId } from "./ids"
import {
  escapeHtml,
  type RenderMarkdownOptions,
  renderDocShell,
  renderSpecialFence,
  stampSanitizer,
} from "./md"
import { MERMAID_HEAD } from "./mermaid"
import {
  parseSourceOps,
  SourceConflictError,
  type SourceHash,
  type SourceToken,
  sourceSha,
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

/** One rendered character run of an inline container: `r` is what the page shows, the
 *  source bytes are [s, e). Atomic units (an entity, an escape, a surrogate pair) are
 *  written back whole or not at all. */
interface Unit {
  s: number
  e: number
  r: string
  atomic: boolean
}

interface Ctx {
  cell?: boolean
  link?: boolean
  atx?: boolean
  code?: "span" | "block"
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
  /** Content, in order: text units and child nodes (inline), or child nodes (blocks). */
  seq: (Unit | MdNode)[]
  /** Whether a content op may rewrite it (its content is mapped and verified). */
  editable: boolean
  /** Its content starts a line (a paragraph, a list item's text). */
  lineStart: boolean
  ctx: Ctx
  /** Its text as rendered, filled in while rendering. */
  rendered?: string
  /** A fenced code block's fence. */
  fence?: string
}

const isUnit = (x: Unit | MdNode): x is Unit => "r" in x
const INLINE_KINDS = new Set<Kind>(["strong", "em", "del", "a", "codespan", "img", "br"])
const WRAPPERS = new Set<Kind>(["strong", "em", "del", "a"])
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
const BLOCK_CONTAINERS = new Set<Kind>(["root", "bq", "list", "tbody"])

/** Normalized text (what the parser saw) with each character's source offset. */
interface Mapped {
  text: string
  at: number[]
}
const sliceMapped = (m: Mapped, a: number, b: number): Mapped => ({
  text: m.text.slice(a, b),
  at: m.at.slice(a, b + 1),
})

/** Map a container's normalized text (its lines with the container's own prefix removed)
 *  onto the source lines it came from: each text line must be a suffix of its source
 *  line. null when the parser changed more than a prefix. */
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
    if (i < want.length - 1) at.push(src.at[off + line.length] as number)
    else at.push(src.at[base + t.length] as number)
    off += line.length + 1
  }
  return { text, at }
}

/** A raw slice's length without its trailing blank lines and final newline. */
const trimmedLength = (raw: string): number => {
  let e = raw.length
  for (;;) {
    const nl = raw.lastIndexOf("\n", e - 1)
    if (nl < 0 || raw.slice(nl + 1, e).trim() !== "") break
    e = nl
  }
  return e
}

/** A table row's cells: content ranges (trimmed) within the line, split at unescaped pipes. */
const rowCells = (line: string): { s: number; e: number }[] | null => {
  let a = 0
  let b = line.length
  while (a < b && /[ \t]/.test(line[a] as string)) a++
  while (b > a && /[ \t]/.test(line[b - 1] as string)) b--
  if (line[a] === "|") a++
  if (b > a && line[b - 1] === "|" && line[b - 2] !== "\\") b--
  const out: { s: number; e: number }[] = []
  let s = a
  for (let i = a; i <= b; i++) {
    if (i < b && !(line[i] === "|" && line[i - 1] !== "\\")) continue
    let cs = s
    let ce = i
    while (cs < ce && /[ \t]/.test(line[cs] as string)) cs++
    while (ce > cs && /[ \t]/.test(line[ce - 1] as string)) ce--
    out.push({ s: cs, e: ce })
    s = i + 1
  }
  return out.length ? out : null
}

type Stamped = Token & { __n?: MdNode; __table?: { thead: MdNode; tbody?: MdNode; rows: MdNode[] } }

interface Model {
  source: string
  nodes: MdNode[]
  root: MdNode
}

/** Build the model: walk the parser's tokens once, give every construct its id and exact
 *  ranges. Tokens get their node attached for the renderer. */
const buildModel = (source: string, tokens: Token[]): Model => {
  const nodes: MdNode[] = []
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
    stamp = true,
  ): MdNode => {
    const n: MdNode = {
      n: stamp ? nodes.length : -1,
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
    if (stamp) nodes.push(n)
    return n
  }
  const root = node("root", 0, source.length, null)
  root.editable = true

  const units = (m: Mapped, from: number, to: number, out: (Unit | MdNode)[], raw: boolean) => {
    const entities = raw
      ? []
      : decodedEntitiesIn(m.text, from, to).filter((x) => m.text[x.end - 1] === ";")
    let i = from
    for (const ent of [...entities, { start: to, end: to, text: "" }]) {
      for (; i < ent.start; i++) {
        const c = m.text.charCodeAt(i)
        // A surrogate pair is one character: never split it.
        const w = c >= 0xd800 && c < 0xdc00 && i + 1 < ent.start ? 2 : 1
        out.push({
          s: m.at[i] as number,
          e: m.at[i + w] as number,
          r: m.text.slice(i, i + w),
          atomic: w > 1,
        })
        i += w - 1
      }
      if (ent.end > ent.start)
        out.push({
          s: m.at[ent.start] as number,
          e: m.at[ent.end] as number,
          r: ent.text,
          atomic: true,
        })
      i = Math.max(i, ent.end)
    }
  }

  /** Forget what a failed walk stamped under `n`: nothing inside it is addressable. */
  const unmap = (n: MdNode) => {
    const drop = (x: MdNode) => {
      for (const c of x.seq) if (!isUnit(c)) drop(c)
      if (x.n >= 0) x.n = -2
    }
    for (const c of n.seq) if (!isUnit(c)) drop(c)
    n.seq = []
  }

  /** Map inline tokens over `m` into `into`. False when something can't be mapped.
   *  Inline HTML is mapped only as emphasis (`<strong>…</strong>`, `<em>`, `<b>`, `<i>`,
   *  `<del>`, `<s>`, opened and closed here) and `<br>`: the editor's own spellings where
   *  Markdown has none. Any other tag leaves the container read-only. */
  const inline = (list: Token[], m: Mapped, into: MdNode): boolean => {
    let cur = 0
    let target = into
    const open: { node: MdNode; tag: string; parent: MdNode }[] = []
    for (const tok of list as Stamped[]) {
      const raw = tok.raw
      if (m.text.slice(cur, cur + raw.length) !== raw) return false
      const s = cur
      const e = cur + raw.length
      const src = (a: number, b: number) => [m.at[a] as number, m.at[b] as number] as const
      if (tok.type === "text") units(m, s, e, target.seq, false)
      else if (tok.type === "escape") {
        const [a, b] = src(s, e)
        target.seq.push({ s: a, e: b, r: tok.text, atomic: true })
      } else if (tok.type === "strong" || tok.type === "em" || tok.type === "del") {
        const [a, b] = src(s, e)
        const child = node(tok.type, a, b, target)
        tok.__n = child
        target.seq.push(child)
        const d = (raw.length - tok.text.length) / 2
        if (d > 0 && Number.isInteger(d) && raw.slice(d, raw.length - d) === tok.text) {
          ;[child.cStart, child.cEnd] = src(s + d, e - d)
          child.editable = inline(tok.tokens ?? [], sliceMapped(m, s + d, e - d), child)
        }
        if (!child.editable) unmap(child)
      } else if (tok.type === "link") {
        const [a, b] = src(s, e)
        const child = node("a", a, b, target)
        child.ctx.link = true
        tok.__n = child
        target.seq.push(child)
        const len = tok.text.length
        if (raw[0] === "[" && raw.slice(1, 1 + len) === tok.text && raw[1 + len] === "]") {
          ;[child.cStart, child.cEnd] = src(s + 1, s + 1 + len)
          child.editable = inline(tok.tokens ?? [], sliceMapped(m, s + 1, s + 1 + len), child)
        }
        if (!child.editable) unmap(child)
      } else if (tok.type === "codespan") {
        const [a, b] = src(s, e)
        const child = node("codespan", a, b, target)
        child.ctx.code = "span"
        tok.__n = child
        target.seq.push(child)
        const f = /^`+/.exec(raw)?.[0].length ?? 0
        const inner = raw.slice(f, raw.length - f)
        if (f && raw.length >= 2 * f && raw.endsWith("`".repeat(f)) && inner === tok.text) {
          ;[child.cStart, child.cEnd] = src(s + f, e - f)
          units(m, s + f, e - f, child.seq, true)
          child.editable = true
        }
      } else if (tok.type === "image" || tok.type === "br") {
        const [a, b] = src(s, e)
        const child = node(tok.type === "br" ? "br" : "img", a, b, target)
        tok.__n = child
        target.seq.push(child)
      } else if (tok.type === "html") {
        const tag = /^<(\/?)(strong|em|b|i|del|s|br)\s*(\/?)>$/i.exec(raw)
        if (!tag) return false
        const [, closing, rawName, selfClosing] = tag as unknown as [string, string, string, string]
        const name = rawName.toLowerCase()
        const [a, b] = src(s, e)
        if (name === "br") {
          if (closing) return false
          const child = node("br", a, b, target)
          tok.__n = child
          target.seq.push(child)
        } else if (!closing && !selfClosing) {
          const kind: Kind =
            name === "strong" || name === "b"
              ? "strong"
              : name === "em" || name === "i"
                ? "em"
                : "del"
          const child = node(kind, a, b, target)
          child.cStart = b
          child.editable = true
          tok.__n = child
          target.seq.push(child)
          open.push({ node: child, tag: name, parent: target })
          target = child
        } else {
          const top = open.pop()
          if (!top || top.tag !== name || closing !== "/") return false
          top.node.cEnd = a
          top.node.end = b
          target = top.parent
        }
      } else return false
      cur = e
    }
    return !open.length && cur === m.text.length
  }

  const inlineContainer = (n: MdNode, list: Token[], m: Mapped) => {
    n.editable = inline(list, m, n)
    if (!n.editable) unmap(n)
  }

  /** Map block tokens over `m` as the children of `parent`. */
  const blocks = (list: Token[], m: Mapped, parent: MdNode): boolean => {
    let cur = 0
    for (const tok of list as Stamped[]) {
      const raw = tok.raw
      const at = m.text.indexOf(raw, cur)
      if (at < 0 || m.text.slice(cur, at).trim() !== "") return false
      cur = at + raw.length
      if (tok.type === "space") continue
      const len = trimmedLength(raw)
      const range = sliceMapped(m, at, at + len)
      const start = range.at[0] as number
      const end = range.at[len] as number
      if (tok.type === "paragraph" || tok.type === "heading" || tok.type === "text") {
        const kind: Kind = tok.type === "paragraph" ? "p" : tok.type === "heading" ? "h" : "tb"
        const n = node(kind, start, end, parent, kind !== "tb")
        tok.__n = n
        parent.seq.push(n)
        const text = (tok as Tokens.Paragraph).text
        const atx = kind === "h" && /^ {0,3}#/.test(raw)
        const hashes = atx ? (/^ {0,3}#{1,6}[ \t]*/.exec(raw)?.[0].length ?? 0) : 0
        const off = kind === "h" ? raw.indexOf(text, hashes) : raw.startsWith(text) ? 0 : -1
        n.ctx.atx = atx
        n.lineStart = !atx
        if (off < 0 || !(tok as Tokens.Paragraph).tokens) continue
        const content = sliceMapped(m, at + off, at + off + text.length)
        n.cStart = content.at[0] as number
        n.cEnd = content.at[text.length] as number
        inlineContainer(n, (tok as Tokens.Paragraph).tokens, content)
      } else if (tok.type === "blockquote") {
        const n = node("bq", start, end, parent)
        tok.__n = n
        parent.seq.push(n)
        const marker = /^ {0,3}> ?/.exec(raw)?.[0] ?? "> "
        n.prefix = parent.prefix + marker.trimStart()
        const inner = alignLines((tok as Tokens.Blockquote).text, range)
        n.editable = !!inner && blocks((tok as Tokens.Blockquote).tokens, inner, n)
      } else if (tok.type === "list") {
        const n = node("list", start, end, parent)
        tok.__n = n
        parent.seq.push(n)
        n.editable = true
        let icur = 0
        for (const item of (tok as Tokens.List).items as (Tokens.ListItem & Stamped)[]) {
          const iat = range.text.indexOf(item.raw.slice(0, trimmedLength(item.raw)), icur)
          const ilen = trimmedLength(item.raw)
          if (iat < 0 || range.text.slice(icur, iat).trim() !== "") {
            n.editable = false
            break
          }
          icur = iat + ilen
          const ir = sliceMapped(range, iat, iat + ilen)
          const li = node("li", ir.at[0] as number, ir.at[ilen] as number, n)
          item.__n = li
          n.seq.push(li)
          if (item.task) continue
          const first = ir.text.split("\n", 1)[0] as string
          const textFirst = item.text.split("\n", 1)[0] as string
          const indent = textFirst
            ? first.length - textFirst.length
            : (/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]*/.exec(first)?.[0].length ?? first.length)
          li.prefix = n.prefix + " ".repeat(Math.max(0, indent))
          const inner = alignLines(item.text, ir)
          if (!inner) continue
          li.cStart = inner.at[0] as number
          li.editable = blocks(item.tokens, inner, li)
        }
      } else if (tok.type === "table") {
        const t = tok as Tokens.Table & Stamped
        const n = node("table", start, end, parent)
        tok.__n = n
        parent.seq.push(n)
        const lines = range.text.split("\n")
        let off = 0
        const lineRanges = lines.map((l) => {
          const r = { s: off, e: off + l.length }
          off += l.length + 1
          return r
        })
        const rowNode = (li: number, parentNode: MdNode, cells: Tokens.TableCell[]) => {
          const lr = lineRanges[li] as { s: number; e: number }
          const tr = node("tr", range.at[lr.s] as number, range.at[lr.e] as number, parentNode)
          parentNode.seq.push(tr)
          const found = rowCells(lines[li] as string)
          if (!found || found.length !== cells.length) return tr
          tr.editable = true
          found.forEach((c, k) => {
            const cellTok = cells[k] as Tokens.TableCell & Stamped
            const cell = node(
              "cell",
              range.at[lr.s + c.s] as number,
              range.at[lr.s + c.e] as number,
              tr,
            )
            cell.ctx.cell = true
            cellTok.__n = cell
            tr.seq.push(cell)
            // The cell's text with `\|` read as `|`, each character on its source bytes.
            const raw = (lines[li] as string).slice(c.s, c.e)
            const cm: Mapped = { text: "", at: [] }
            for (let i = 0; i < raw.length; i++) {
              cm.at.push(range.at[lr.s + c.s + i] as number)
              if (raw[i] === "\\" && raw[i + 1] === "|") i++
              cm.text += raw[i]
            }
            cm.at.push(cell.end)
            if (cm.text !== cellTok.text) return
            inlineContainer(cell, cellTok.tokens, cm)
          })
          return tr
        }
        const bodyLines = lines.length - 2
        if (bodyLines !== t.rows.length || lines.length < 2) continue
        const thead = node(
          "thead",
          range.at[0] as number,
          range.at[lineRanges[0]?.e ?? 0] as number,
          n,
        )
        n.seq.push(thead)
        rowNode(0, thead, t.header)
        let tbody: MdNode | undefined
        const rows: MdNode[] = []
        if (bodyLines > 0) {
          const s0 = lineRanges[2]?.s ?? 0
          tbody = node("tbody", range.at[s0] as number, end, n)
          tbody.editable = true
          n.seq.push(tbody)
          t.rows.forEach((cells, r) => {
            rows.push(rowNode(r + 2, tbody as MdNode, cells))
          })
        }
        t.__table = { thead, tbody, rows: [thead.seq[0] as MdNode, ...rows] }
      } else if (tok.type === "code") {
        const n = node("pre", start, end, parent)
        tok.__n = n
        parent.seq.push(n)
        const c = tok as Tokens.Code
        const fence = /^ {0,3}(`{3,}|~{3,})/.exec(raw)
        if (
          !fence ||
          parseDynamicFence(c.lang) ||
          c.lang?.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid"
        )
          continue
        const nl = raw.indexOf("\n")
        if (nl < 0 && c.text) continue
        const bodyAt = nl < 0 ? len : nl + 1
        if (raw.slice(bodyAt, bodyAt + c.text.length) !== c.text) continue
        const body = sliceMapped(m, at + bodyAt, at + bodyAt + c.text.length)
        const code = node("code", body.at[0] as number, body.at[c.text.length] as number, n)
        code.ctx.code = "block"
        code.fence = fence[1]
        n.seq.push(code)
        units(body, 0, c.text.length, code.seq, true)
        // The renderer ends the block's text with a newline no source byte stands for.
        code.seq.push({ s: code.cEnd, e: code.cEnd, r: "\n", atomic: true })
        code.editable = true
        n.cStart = code.cStart
        n.cEnd = code.cEnd
        n.editable = true
      } else if (tok.type === "hr") {
        const n = node("hr", start, end, parent)
        tok.__n = n
        parent.seq.push(n)
      } else {
        // An HTML block, a link definition: no element of ours to stamp, kept in place.
        const n = node("raw", start, end, parent, false)
        tok.__n = n
        parent.seq.push(n)
      }
    }
    return m.text.slice(cur).trim() === ""
  }

  const top: Mapped = { text: norm, at: topAt }
  root.editable = blocks(tokens, top, root)
  // Ids stay dense: whatever a failed walk un-stamped is renumbered out.
  const live = nodes.filter((x) => x.n !== -2)
  live.forEach((x, i) => {
    x.n = i
  })
  return { source, nodes: live, root }
}

// ── Rendering ───────────────────────────────────────────────────────────────────────

const textOf = (html: string): string =>
  decodeEntities(html.replace(/\n$/, "").replace(/<[^>]*>/g, "")).replaceAll("\u00a0", " ")
const predicted = (n: MdNode): string =>
  n.seq
    .map((x) => (isUnit(x) ? x.r : (x.rendered ?? predicted(x))))
    .join("")
    .replaceAll("\u00a0", " ")

/** Render tokens as the reader's page does, with every modeled construct stamped. An
 *  inline container whose rendered text differs from what the model predicts is served
 *  read-only: the map would be wrong, so no edit may rely on it. */
const renderStamped = (
  tokens: Token[],
  opts: RenderMarkdownOptions,
): { body: string; mermaid: boolean } => {
  const nonce = `${newShortId()}${newShortId()}`
  const attr = `data-derive-s${nonce}`
  let mermaid = false
  const base = new Renderer()
  const stamp = (html: string, n: MdNode | undefined, ro = false): string => {
    if (n && n.rendered === undefined) n.rendered = textOf(html)
    if (!n && !ro) return html
    const value = `${n && n.n >= 0 ? n.n : ""}${ro ? "r" : ""}`
    if (!value) return html
    return html.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9]*)/, `$1 ${attr}="${value}"`)
  }
  /** Stamp an inline container, verifying its text on the way. */
  const container = (html: string, n: MdNode | undefined): string => {
    if (!n) return html
    n.rendered = textOf(html)
    if (n.editable && INLINE_CONTAINERS.has(n.kind) && predicted(n) !== n.rendered)
      n.editable = false
    return stamp(html, n, INLINE_CONTAINERS.has(n.kind) && !n.editable)
  }
  const nodeOf = (t: unknown) => (t as Stamped).__n
  const md = new Marked({
    gfm: true,
    renderer: {
      paragraph(t) {
        base.parser = this.parser
        return container(base.paragraph(t), nodeOf(t))
      },
      heading(t) {
        base.parser = this.parser
        return container(base.heading(t), nodeOf(t))
      },
      text(t) {
        base.parser = this.parser
        const html = base.text(t)
        const n = nodeOf(t)
        if (n?.kind === "tb") {
          n.rendered = textOf(html)
          if (n.editable && predicted(n) !== n.rendered) n.editable = false
        }
        return html
      },
      blockquote(t) {
        base.parser = this.parser
        const n = nodeOf(t)
        return stamp(base.blockquote(t), n, !n?.editable)
      },
      list(t) {
        // As marked draws a list, with the items through this renderer.
        const n = nodeOf(t)
        const type = t.ordered ? "ol" : "ul"
        const start = t.ordered && t.start !== 1 ? ` start="${t.start}"` : ""
        const items = t.items.map((item) => this.listitem(item)).join("")
        return stamp(`<${type}${start}>\n${items}</${type}>\n`, n, !n?.editable)
      },
      listitem(t) {
        base.parser = this.parser
        const n = nodeOf(t)
        const tb = n?.seq.find((x): x is MdNode => !isUnit(x) && x.kind === "tb")
        const html = base.listitem(t)
        // A tight item's text is the item's own: its text block decides.
        return stamp(html, n, !n?.editable || (tb ? !tb.editable : false))
      },
      tablecell(t) {
        base.parser = this.parser
        return container(base.tablecell(t), nodeOf(t))
      },
      table(t) {
        base.parser = this.parser
        const map = (t as Stamped).__table
        const row = (cells: Tokens.TableCell[], tr: MdNode | undefined) =>
          stamp(`<tr>\n${cells.map((c) => this.tablecell(c)).join("")}</tr>\n`, tr)
        const head = row(t.header, map?.rows[0])
        const body = t.rows.map((cells, r) => row(cells, map?.rows[r + 1])).join("")
        const html = `<table>\n${stamp("<thead>\n", map?.thead)}${head}</thead>\n${body ? `${stamp("<tbody>", map?.tbody)}${body}</tbody>` : ""}</table>\n`
        return stamp(html, nodeOf(t), !map)
      },
      code(t) {
        base.parser = this.parser
        const n = nodeOf(t)
        const special = renderSpecialFence(t, opts, () => {
          mermaid = true
        })
        if (special !== false) return stamp(special, n, true)
        const html = base.code(t)
        const code = n?.seq[0] as MdNode | undefined
        if (!code) return stamp(html, n, true)
        code.rendered = textOf(html)
        if (predicted(code) !== code.rendered) code.editable = false
        return stamp(html.replace(/<code\b/, stamp("<code", code, !code.editable)), n)
      },
      hr(t) {
        return stamp(base.hr(t), nodeOf(t))
      },
      html(t) {
        // Authored HTML: shown as written, never edited inline.
        const n = nodeOf(t)
        if ("block" in t && t.block) {
          if (n) n.rendered = textOf(t.text)
          return stamp(t.text, undefined, true)
        }
        // An emphasis or break tag the model maps (the editor's own spellings).
        if (n) {
          const html = stamp(t.text, n)
          // Its words are rendered by the tokens that follow: read them from the model.
          n.rendered = n.kind === "br" ? "" : undefined
          return html
        }
        return t.text
      },
      strong(t) {
        base.parser = this.parser
        return container(base.strong(t), nodeOf(t))
      },
      em(t) {
        base.parser = this.parser
        return container(base.em(t), nodeOf(t))
      },
      del(t) {
        base.parser = this.parser
        return container(base.del(t), nodeOf(t))
      },
      link(t) {
        base.parser = this.parser
        return container(base.link(t), nodeOf(t))
      },
      codespan(t) {
        return container(base.codespan(t), nodeOf(t))
      },
      br(t) {
        const n = nodeOf(t)
        if (n) n.rendered = ""
        return stamp(base.br(t), n)
      },
      image(t) {
        base.parser = this.parser
        const n = nodeOf(t)
        if (n) n.rendered = ""
        return stamp(base.image(t), n)
      },
    },
  })
  const html = md.parser(tokens)
  const clean = stampSanitizer(attr).process(html)
  const body = clean.replace(
    new RegExp(` ${attr}="(\\d*)(r?)"`, "g"),
    (_m, n: string, r: string) =>
      `${n ? ` data-derive-src="${n}"` : ""}${r ? " data-derive-readonly" : ""}`,
  )
  return { body, mermaid }
}

const lex = (source: string): Token[] => new Marked({ gfm: true }).lexer(source)

/** The model with its editable flags settled (they depend on the rendered text). */
const modelOf = (source: string): Model & { body: string; mermaid: boolean } => {
  const tokens = lex(source)
  const model = buildModel(source, tokens)
  return { ...model, ...renderStamped(tokens, {}) }
}

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
  const tokens = lex(source)
  buildModel(source, tokens)
  const { body, mermaid } = renderStamped(tokens, opts)
  const sha = await sourceSha(source)
  return renderDocShell(body, title, mermaid ? MERMAID_HEAD : "")
    .replace(
      '<html lang="en">',
      `<html lang="en" data-derive-src-version="${base.version}" data-derive-src-sha="${escapeHtml(sha)}">`,
    )
    .replace("<main data-derive-ready>", '<main data-derive-ready data-derive-src="0">')
}

const hashText = async (text: string): Promise<SourceHash> =>
  (await sha256Hex(new TextEncoder().encode(text))).slice(0, 16)

/** The hash of every id's source bytes, as `sourceMap` gives them for HTML. */
export const markdownSourceMap = async (
  source: string,
): Promise<{ sha: string; hashes: SourceHash[] }> => {
  const { nodes } = modelOf(source)
  const [sha, hashes] = await Promise.all([
    sourceSha(source),
    Promise.all(nodes.map((n) => hashText(source.slice(n.start, n.end)))),
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

const BLOCK_START: [RegExp, (m: RegExpExecArray) => number][] = [
  [/^#{1,6}(?=[ \t]|$)/, () => 0],
  [/^>/, () => 0],
  [/^[-+*](?=[ \t]|$)/, () => 0],
  [/^\d{1,9}[.)](?=[ \t]|$)/, (m) => m[0].length - 1],
  [/^(?:`{3,}|~{3,})/, () => 0],
  [/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/, () => 0],
]
const SETEXT = /^(?:=+|-+)[ \t]*$/

/** How emphasis is spelled. "md": `**`/`*` for new formatting, the author's own
 *  delimiters kept. The others re-spell every run in the op — `__` with `*`, `**` with
 *  `_`, `__`/`_` (a delimiter meeting another run), then `<strong>`/`<em>` (one that can't
 *  close where it sits, like `**x.**y`). The save takes the first that reads back as the
 *  page showed. */
type Spelling = "md" | "mixA" | "mixB" | "alt" | "html"
/** The delimiter character a spelling writes for strong and for emphasis. */
const DELIM: Record<Exclude<Spelling, "html">, { strong: string; em: string }> = {
  md: { strong: "*", em: "*" },
  mixA: { strong: "_", em: "*" },
  mixB: { strong: "*", em: "_" },
  alt: { strong: "_", em: "_" },
}
interface Serializer {
  model: Model
  spelling: Spelling
}

const fail = (message: string): never => {
  throw new EditError(message)
}

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
  if (n.ctx.cell) t = t.replace(/\|/g, "\\|")
  if (n.ctx.link && !n.ctx.code) t = t.replace(/[[\]]/g, "\\$&")
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

const nodeSym = (n: MdNode) => `\u0000${n.n}`

/** An inline container's new content: its original text aligned against the new, the
 *  unchanged characters written back as their original bytes. */
const inlinePieces = (z: Serializer, n: MdNode, tokens: SourceToken[]): Piece[] => {
  const src = z.model.source
  // Original symbols: one per rendered character (with its unit), one per child node.
  const aSym: string[] = []
  const aRef: { si: number; k: number }[] = []
  n.seq.forEach((x, si) => {
    if (isUnit(x))
      for (let k = 0; k < x.r.length; k++) {
        aSym.push(x.r[k] as string)
        aRef.push({ si, k })
      }
    else {
      aSym.push(nodeSym(x))
      aRef.push({ si, k: 0 })
    }
  })
  const bSym: string[] = []
  const bTok: (SourceToken | null)[] = []
  for (const t of tokens) {
    if ("text" in t)
      for (let i = 0; i < t.text.length; i++) {
        bSym.push(t.text[i] as string)
        bTok.push(null)
      }
    else {
      const node = "keep" in t ? z.model.nodes[t.keep] : undefined
      bSym.push(node ? nodeSym(node) : "\u0000new")
      bTok.push(t)
    }
  }
  const loose = n.ctx.code === undefined
  const eq = (x: string, y: string) =>
    x === y || (loose && x.length === 1 && y.length === 1 && isSpace(x) && isSpace(y))
  const match = align(aSym, bSym, eq)
  // An atomic unit stays only when every character of it matched, in one run.
  const unitMatch = new Map<number, number[]>()
  match.forEach((ai, bi) => {
    if (ai < 0) return
    const r = aRef[ai] as { si: number }
    unitMatch.set(r.si, [...(unitMatch.get(r.si) ?? []), bi])
  })
  for (const [si, bis] of unitMatch) {
    const u = n.seq[si] as Unit | MdNode
    if (!isUnit(u) || !u.atomic) continue
    const whole =
      bis.length === u.r.length && bis.every((b, i) => i === 0 || b === (bis[i - 1] as number) + 1)
    if (!whole) for (const b of bis) match[b] = -1
  }

  const pieces: Piece[] = []
  const emitted = new Set<number>()
  let ins = ""
  const flush = () => {
    if (ins) pieces.push({ s: typed(ins, n), kind: "ins" })
    ins = ""
  }
  for (let bi = 0; bi < bSym.length; bi++) {
    const t = bTok[bi]
    const ai = match[bi] as number
    if (t === null || t === undefined) {
      if (ai < 0) {
        ins += bSym[bi]
        continue
      }
      const { si } = aRef[ai] as { si: number }
      if (emitted.has(si)) continue
      flush()
      emitted.add(si)
      const u = n.seq[si] as Unit
      pieces.push({ s: src.slice(u.s, u.e), kind: "orig", si, nl: u.r === "\n" })
      continue
    }
    flush()
    const si = ai >= 0 ? (aRef[ai] as { si: number }).si : undefined
    const out = emitToken(z, n, t)
    if (out !== null)
      pieces.push({ s: out, kind: "node", si, nl: /\n[^\n]*$/.test(out) && isBreak(z, t) })
  }
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
 *  line break, a line's prefix) moves outside the delimiters — a delimiter beside it
 *  wouldn't open or close — and nothing is left of it when the content is gone. */
const wrapPieces = (pieces: Piece[], open: string, close: string): string => {
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

const isBreak = (z: Serializer, t: SourceToken): boolean =>
  ("tag" in t && t.tag === "br") || ("keep" in t && z.model.nodes[t.keep]?.kind === "br")

/** One non-text token inside an inline container, as Markdown; null to drop it. */
const emitToken = (z: Serializer, n: MdNode, t: SourceToken): string | null => {
  const src = z.model.source
  if ("comment" in t) return `<!--${t.comment}-->`
  if ("tag" in t) return emitTag(z, n, t)
  if (!("keep" in t)) return null
  const k = z.model.nodes[t.keep] as MdNode
  if (!INLINE_KINDS.has(k.kind))
    fail(
      "A paragraph can only hold words, links and formatting. Use the source editor to move blocks.",
    )
  if (!t.children) {
    // Another spelling re-spells kept emphasis too: two runs that now touch (`**a****b**`)
    // only parse apart when one of them changes.
    const bytes =
      z.spelling !== "md" && k.kind !== "a" && WRAPPERS.has(k.kind) && k.editable
        ? emphasis(z, k, src.slice(k.cStart, k.cEnd))
        : src.slice(k.start, k.end)
    return reindent(bytes, k.linePrefix, n.prefix)
  }
  return reindent(emitWith(z, k, t.children), k.linePrefix, n.prefix)
}

/** Kept emphasis around its content (its own bytes, or new pieces), in the save's
 *  spelling. */
const emphasis = (z: Serializer, k: MdNode, inner: string | Piece[]): string => {
  const src = z.model.source
  const pieces: Piece[] = typeof inner === "string" ? [{ s: inner, kind: "orig" }] : inner
  if (z.spelling === "html") {
    const tag = k.kind === "em" ? "em" : k.kind === "del" ? "del" : "strong"
    return wrapPieces(pieces, `<${tag}>`, `</${tag}>`)
  }
  const html = /^</.test(src.slice(k.start, k.cStart))
  const swap = (d: string) => {
    if (z.spelling === "md" || k.kind === "del" || html) return d
    const c = DELIM[z.spelling as Exclude<Spelling, "html">][k.kind === "em" ? "em" : "strong"]
    return d.replace(/[*_]/g, c)
  }
  return wrapPieces(pieces, swap(src.slice(k.start, k.cStart)), swap(src.slice(k.cEnd, k.end)))
}

/** A kept construct with new content: its delimiters around the serialized content. */
const emitWith = (z: Serializer, k: MdNode, children: SourceToken[]): string => {
  const src = z.model.source
  if (!k.editable) fail("Part of that edit is inside something that can't be edited inline.")
  if (k.kind === "codespan") return codespan(serializeInline(z, k, children))
  if (WRAPPERS.has(k.kind) && k.kind !== "a")
    return emphasis(z, k, finishInline(k, inlinePieces(z, k, children)))
  const inner = serializeContent(z, k, children)
  const open = src.slice(k.start, k.cStart)
  const close = src.slice(k.cEnd, k.end)
  if (k.kind === "a") return inner.trim() ? open + inner + close : inner
  return open + inner + close
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

/** Editor formatting as Markdown. */
const emitTag = (z: Serializer, n: MdNode, t: TagToken): string | null => {
  if (t.tag === "br") {
    if (n.ctx.code === "block") return `\n${n.prefix}`
    if (n.ctx.code === "span") return " "
    // An ATX heading and a table cell are one line: only HTML can break them.
    if (n.ctx.cell || n.ctx.atx) return "<br>"
    return `\\\n${n.prefix}`
  }
  // Code holds no formatting: its words stay, as code.
  if (n.ctx.code) return serializeInline(z, { ...n, seq: [], lineStart: false }, t.children ?? [])
  const kind: Kind = t.tag === "a" ? "a" : t.tag === "b" || t.tag === "strong" ? "strong" : "em"
  const pseudo: MdNode = { ...n, kind, seq: [], lineStart: false, ctx: { ...n.ctx } }
  if (t.tag === "a") {
    if (n.ctx.link) fail("That edit would put a link inside a link.")
    pseudo.ctx.link = true
    const inner = serializeInline(z, pseudo, t.children ?? [])
    const href = t.href ?? ""
    const dest = /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, "\\$&")}>` : href
    return inner.trim() ? `[${inner}](${dest})` : inner
  }
  const inner = finishInline(pseudo, inlinePieces(z, pseudo, t.children ?? []))
  const strong = t.tag === "b" || t.tag === "strong"
  if (z.spelling === "html")
    return wrapPieces(inner, strong ? "<strong>" : "<em>", strong ? "</strong>" : "</em>")
  const d = DELIM[z.spelling][strong ? "strong" : "em"].repeat(strong ? 2 : 1)
  return wrapPieces(inner, d, d)
}

/** Settle an inline container's pieces: nothing typed may start a new block at a line
 *  start, a break needs text after it, and typed space at the edges of a block is dropped. */
const finishInline = (n: MdNode, pieces: Piece[]): Piece[] => {
  if (n.ctx.code) return pieces
  const block = n.kind === "p" || n.kind === "tb" || n.kind === "cell" || n.kind === "h"
  if (block) {
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
  const starts: number[] = []
  if (n.lineStart) starts.push(0)
  pieces.forEach((p, i) => {
    if (p.nl) starts.push(i + 1)
  })
  for (const k of starts) {
    if (k >= pieces.length) continue
    const first = pieces[k] as Piece
    const prev = pieces[k - 1]
    const untouched =
      first.si !== undefined && (k === 0 ? first.si === 0 : prev?.si === first.si - 1)
    if (untouched) continue
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
    let at = -1
    for (const [re, idx] of BLOCK_START) {
      const m = re.exec(line)
      if (m) {
        at = idx(m)
        break
      }
    }
    if (at < 0 && k > 0 && SETEXT.test(line)) at = 0
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
  const words = (host: MdNode, group: SourceToken[]) =>
    serializeInline(z, { ...host, seq: [], lineStart: true, editable: true }, group)
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
    const prev = items.at(-1)
    if (n.kind === "list") {
      if (!prev?.node) fail("Text can only be typed inside a list item.")
      const host = prev?.node as MdNode
      const line = words({ ...host, kind: "tb", linePrefix: host.prefix }, group)
      if (prev && line) prev.bytes += `\n${host.prefix}${line}`
      return
    }
    if (n.kind === "tbody" || n.kind === "thead")
      fail("Text can only be typed inside a table cell.")
    const kind: Kind = "p"
    items.push({ bytes: words({ ...n, kind, linePrefix: n.prefix }, group) })
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
    if ((k.kind === "tr") !== (n.kind === "tbody" || n.kind === "thead"))
      fail("A table row can only move within its table.")
    const kt = t as KeepToken
    const bytes = kt.children ? emitBlockWith(z, k, kt.children) : src.slice(k.start, k.end)
    const orig = kids.includes(k) && !firstEmit.has(k) ? k : undefined
    if (orig) firstEmit.add(orig)
    items.push({ orig, node: k, bytes: reindent(bytes, k.linePrefix, n.prefix) })
  }
  flushInline()
  if (n.kind === "li" && kids[0]?.kind === "tb" && !firstEmit.has(kids[0])) {
    // Every word of the item's own text was deleted.
    firstEmit.add(kids[0])
    items.unshift({ orig: kids[0], node: kids[0], bytes: "" })
  }
  // What has no element of ours (an HTML block, a link definition) stays where it was:
  // after the kept block that preceded it.
  kids.forEach((k, i) => {
    if (k.n >= 0 || k.kind === "tb") return
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const idx = items.findIndex((it) => it.orig === kids[j])
      if (idx >= 0) {
        at = idx + 1
        break
      }
    }
    items.splice(at, 0, { orig: k, bytes: src.slice(k.start, k.end) })
  })
  const sep = (i: number): string => {
    const a = kids[i] as MdNode
    const b = kids[i + 1] as MdNode
    return src.slice(a.end, b.start)
  }
  const blank = `\n${n.prefix.trimEnd()}\n${n.prefix}`
  const fallback =
    n.kind === "list"
      ? kids.length > 1
        ? sep(0)
        : `\n${n.prefix}`
      : n.kind === "tbody" || n.kind === "thead"
        ? `\n${n.prefix}`
        : n.kind === "li" && !kids.some((_k, i) => i > 0 && /\n[ \t>]*\n/.test(sep(i - 1)))
          ? `\n${n.prefix}`
          : blank
  const live = items.filter((it) => it.bytes !== "" || it.orig?.kind === "tb")
  let out = ""
  live.forEach((it, i) => {
    if (i > 0) {
      const prev = live[i - 1] as Item
      const pi = prev.orig ? kids.indexOf(prev.orig) : -1
      out += pi >= 0 && it.orig && kids.indexOf(it.orig) === pi + 1 ? sep(pi) : fallback
    }
    out += it.bytes
  })
  const lead = kids[0] ? src.slice(n.cStart, kids[0].start) : ""
  const tail = kids.length ? src.slice((kids.at(-1) as MdNode).end, n.cEnd) : ""
  return lead + out + tail
}

/** A block kept with new content (a split's halves, an item holding an edit). */
const emitBlockWith = (z: Serializer, k: MdNode, children: SourceToken[]): string => {
  const src = z.model.source
  if (!k.editable) fail("Part of that edit is inside something that can't be edited inline.")
  const inner = serializeContent(z, k, children)
  // A paragraph whose words are all gone is gone: Markdown has no empty paragraph.
  if (k.kind === "p" && inner.trim() === "") return ""
  return src.slice(k.start, k.cStart) + inner + src.slice(k.cEnd, k.end)
}

/** A table row: the same cells in the same order, each with its content rewritten. */
const serializeRow = (z: Serializer, n: MdNode, tokens: SourceToken[]): string => {
  const src = z.model.source
  const cells = n.seq as MdNode[]
  const kept = tokens.filter((t) => !("text" in t && t.text.trim() === ""))
  if (
    kept.length !== cells.length ||
    kept.some((t, i) => !("keep" in t) || t.keep !== (cells[i] as MdNode).n)
  )
    fail("A Markdown table row keeps its cells: type inside a cell instead.")
  let out = ""
  let cursor = n.cStart
  kept.forEach((t, i) => {
    const c = cells[i] as MdNode
    const children = (t as KeepToken).children
    out += src.slice(cursor, c.cStart)
    out += children ? serializeContent(z, c, children) : src.slice(c.cStart, c.cEnd)
    cursor = c.cEnd
  })
  return out + src.slice(cursor, n.cEnd)
}

/** A node's new content (what replaces [cStart, cEnd)). */
const serializeContent = (z: Serializer, n: MdNode, tokens: SourceToken[]): string => {
  if (!n.editable) fail("That part of the document can't be edited inline. Use the source editor.")
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
    const fence = n.fence
    if (
      fence &&
      body.split("\n").some((l) => {
        const m = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/.exec(l)
        return !!m && m[1]?.[0] === fence[0] && (m[1]?.length ?? 0) >= fence.length
      })
    )
      fail("A line in that code block would end it early. Use the source editor.")
    return body
  }
  if (INLINE_CONTAINERS.has(n.kind)) return serializeInline(z, n, tokens)
  if (n.kind === "tr") return serializeRow(z, n, tokens)
  if (n.kind === "li" || BLOCK_CONTAINERS.has(n.kind)) return serializeBlocks(z, n, tokens)
  return fail("That part of the document can't be edited inline. Use the source editor.")
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
const MARK: Record<string, string> = {
  strong: "s",
  em: "e",
  del: "d",
  a: "a",
  code: "c",
  codespan: "c",
}
const chars = (text: string, marks: string[], out: string[]) => {
  const m = [...new Set(marks)].sort().join("")
  for (const ch of text) out.push(isSpace(ch) ? " " : `${ch}${m}`)
}

/** How a model (or a save's intended model) reads. */
const readingOfModel = (n: MdNode): string => {
  const out: string[] = []
  const walk = (x: MdNode, marks: string[]) => {
    const mark = MARK[x.kind]
    const m = mark ? [...marks, mark] : marks
    const block = !INLINE_KINDS.has(x.kind) && x.kind !== "tb"
    if (block) out.push("\u00b6")
    if (x.kind === "br") out.push("\u23ce")
    if (x.kind === "img") out.push("\ufffc")
    for (const c of x.seq)
      if (isUnit(c)) chars(c.r, m, out)
      else walk(c, m)
    if (!x.seq.length && x.rendered) chars(x.rendered, m, out)
    if (block) out.push("\u00b6")
  }
  walk(n, [])
  return settle(out)
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
  const model = modelOf(source)
  const place = (n: number) => `element ${n}`
  const expected = new Map<number, SourceHash>()
  const expect = (n: number, hash: SourceHash) => {
    if ((expected.get(n) ?? hash) !== hash) fail(`${place(n)} is sent with two different hashes.`)
    expected.set(n, hash)
  }
  const walk = (list: SourceToken[]): void => {
    for (const t of list) {
      if ("keep" in t) expect(t.keep, t.hash)
      if ("children" in t && t.children) walk(t.children)
    }
  }
  for (const op of ops) {
    if (op.op !== "content") fail("A Markdown document has no layout to change inline.")
    expect(op.src, op.hash)
    if (op.op === "content") walk(op.children)
  }
  const actual = await Promise.all(
    [...expected].map(async ([n, h]) => {
      const node = model.nodes[n]
      return [n, h, node ? await hashText(source.slice(node.start, node.end)) : ""] as const
    }),
  )
  const conflicts = actual.filter(([, want, got]) => want !== got).map(([n]) => n)
  if (conflicts.length)
    throw new SourceConflictError(
      `${conflicts.length === 1 ? "A part of the document" : `${conflicts.length} parts of the document`} changed since this page was loaded. Reload to see the latest version, then redo ${conflicts.length === 1 ? "that edit" : "those edits"}.`,
      conflicts.sort((a, b) => a - b),
    )
  const targets = ops
    .map((op) => ({
      op: op as Extract<typeof op, { op: "content" }>,
      node: model.nodes[op.src] as MdNode,
    }))
    .sort((a, b) => a.node.start - b.node.start)
  targets.forEach(({ node }, i) => {
    const prev = targets[i - 1]?.node
    if (prev && node.start < prev.end)
      fail(`${place(node.n)} is inside ${place(prev.n)}, which the same save also edits.`)
  })

  // An edit inside a run of emphasis, a link or a code span rewrites the whole run: its
  // delimiters depend on its content (space moves out of `**`, a typed backtick needs a
  // longer fence, an emptied run goes).
  const whole = (node: MdNode) => INLINE_KINDS.has(node.kind)
  const range = (node: MdNode) => (whole(node) ? [node.start, node.end] : [node.cStart, node.cEnd])
  const spell = (spelling: Spelling) =>
    targets.map(({ op, node }) =>
      whole(node)
        ? emitWith({ model, spelling }, node, op.children)
        : serializeContent({ model, spelling }, node, op.children),
    )
  const assemble = (texts: string[]) => {
    let out = ""
    let cursor = 0
    const at: number[] = []
    targets.forEach(({ node }, k) => {
      const [from, to] = range(node) as [number, number]
      out += source.slice(cursor, from)
      at.push(out.length)
      out += texts[k] as string
      cursor = to
    })
    return { markdown: out + source.slice(cursor), at }
  }
  // Each op must read back as the page showed it. Emphasis delimiters are the one thing
  // that may not (a `*` run meeting another, `**x.**y`): an op that doesn't is spelled
  // another way when that one does. Typed Markdown reads differently on purpose; no
  // spelling fixes that, and the plain one stays.
  const reading = targets.map(({ op, node }) =>
    readingOfModel(expectedNode(model, node, op.children)),
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
  let texts = spell("md")
  const spellings: Partial<Record<Spelling, string[]>> = {}
  for (const k of misread(texts))
    for (const spelling of ["mixA", "mixB", "alt", "html"] as const) {
      spellings[spelling] ??= spell(spelling)
      const trial = [...texts]
      trial[k] = (spellings[spelling] as string[])[k] as string
      if (!misread(trial, k).length) {
        texts = trial
        break
      }
    }
  const result: AppliedMarkdownOps = {
    markdown: assemble(texts).markdown,
    changes: targets.map(({ node }, k) => ({
      before: source.slice(...(range(node) as [number, number])),
      after: texts[k] as string,
    })),
  }
  if (result.markdown === source)
    fail("These ops leave the document exactly as it is, so there is nothing to save.")
  return result
}

/** A node as the save means it to read: the op's children in place of its content,
 *  each kept construct as it was (or with its own new children). */
const expectedNode = (model: Model, node: MdNode, children: SourceToken[]): MdNode => {
  const fromTokens = (host: MdNode, tokens: SourceToken[]): MdNode => {
    const seq: (Unit | MdNode)[] = []
    for (const t of tokens) {
      if ("text" in t) {
        if (INLINE_CONTAINERS.has(host.kind) || host.kind === "li")
          seq.push({ s: 0, e: 0, r: t.text, atomic: false })
      } else if ("tag" in t) {
        const kind: Kind =
          t.tag === "br"
            ? "br"
            : t.tag === "a"
              ? "a"
              : t.tag === "b" || t.tag === "strong"
                ? "strong"
                : "em"
        // Code holds no formatting: its words stay plain code.
        const inner = fromTokens(
          { ...host, kind: host.ctx.code ? host.kind : kind, seq: [] },
          t.children ?? [],
        )
        if (host.ctx.code) seq.push(...inner.seq)
        else seq.push(inner)
      } else if ("keep" in t) {
        const k = model.nodes[t.keep] as MdNode
        seq.push(t.children ? fromTokens(k, t.children) : k)
      }
    }
    // Its words are exactly these tokens (an emptied construct reads as nothing).
    return { ...host, seq, rendered: "" }
  }
  return fromTokens(node, children)
}
