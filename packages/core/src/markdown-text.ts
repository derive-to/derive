import { marked } from "marked"
import { decodeEntities, ENTITY_RE, type PageTextSegment, pageTextParts } from "./anchor"

/** A page-text run projected from Markdown. `block` is the rendered editable block
 *  that owns the text; an edit may cross inline syntax inside one block, but never
 *  a paragraph/list/table boundary. */
export interface MarkdownTextSegment extends PageTextSegment {
  block: number
  boundary?: "inline" | "html" | "structural"
}

export interface MarkdownInlineWrapper {
  kind: "strong" | "em" | "del" | "link"
  at: number
  end: number
  contentStart: number
  contentEnd: number
  open: string
  close: string
}

export interface MarkdownTextParts {
  text: string
  segments: MarkdownTextSegment[]
  wrappers: MarkdownInlineWrapper[]
}

interface MarkdownToken {
  type: string
  raw?: string
  text?: string
  tokens?: MarkdownToken[]
  items?: MarkdownToken[]
  header?: MarkdownToken[]
  rows?: MarkdownToken[][]
}

const WRAPPERS = new Set<MarkdownInlineWrapper["kind"]>(["strong", "em", "del", "link"])

/**
 * Project the rendered text of the Markdown blocks the inline editor can mutate
 * back onto their raw-source offsets.
 *
 * Marked is already the renderer's parser, so its inline token boundaries are the
 * authority here too. Formatting delimiters and link destinations become mapped
 * gaps; visible text remains byte-addressable. Unsupported composite block shapes
 * stay literal, preserving the old safe behavior (a word inside them can still be
 * edited, but an edit cannot jump over their Markdown structure).
 */
export function markdownTextParts(source: string): MarkdownTextParts {
  const parts: string[] = []
  const segments: MarkdownTextSegment[] = []
  const wrappers: MarkdownInlineWrapper[] = []
  let tLen = 0
  let blockSeq = 0

  const pushGap = (
    rStart: number,
    rEnd: number,
    block: number,
    boundary: "inline" | "html" | "structural" = "inline",
  ) => {
    if (rEnd <= rStart) return
    segments.push({
      kind: "gap",
      tStart: tLen,
      tEnd: tLen + 1,
      rStart,
      rEnd,
      block,
      boundary,
    })
    parts.push(" ")
    tLen++
  }

  const pushEntity = (text: string, rStart: number, rEnd: number, block: number) => {
    if (!text) return
    segments.push({ kind: "entity", tStart: tLen, tEnd: tLen + text.length, rStart, rEnd, block })
    parts.push(text)
    tLen += text.length
  }

  const pushText = (rStart: number, rEnd: number, block: number) => {
    const raw = source.slice(rStart, rEnd)
    const entityRe = new RegExp(ENTITY_RE.source, "g")
    let last = 0
    for (let match = entityRe.exec(raw); match; match = entityRe.exec(raw)) {
      const decoded = decodeEntities(match[0])
      if (decoded === match[0]) continue
      if (match.index > last) {
        const plain = raw.slice(last, match.index)
        segments.push({
          kind: "text",
          tStart: tLen,
          tEnd: tLen + plain.length,
          rStart: rStart + last,
          rEnd: rStart + match.index,
          block,
        })
        parts.push(plain)
        tLen += plain.length
      }
      pushEntity(decoded, rStart + match.index, rStart + match.index + match[0].length, block)
      last = match.index + match[0].length
    }
    if (last >= raw.length) return
    const plain = raw.slice(last)
    segments.push({
      kind: "text",
      tStart: tLen,
      tEnd: tLen + plain.length,
      rStart: rStart + last,
      rEnd,
      block,
    })
    parts.push(plain)
    tLen += plain.length
  }

  const pushHtml = (raw: string, rStart: number, block: number) => {
    const mapped = pageTextParts(raw)
    for (const segment of mapped.segments) {
      segments.push({
        ...segment,
        tStart: tLen + segment.tStart,
        tEnd: tLen + segment.tEnd,
        rStart: rStart + segment.rStart,
        rEnd: rStart + segment.rEnd,
        block,
        ...(segment.kind === "gap" ? { boundary: "html" as const } : {}),
      })
    }
    parts.push(mapped.text)
    tLen += mapped.text.length
  }

  const locate = (raw: string, from: number, limit: number): number => {
    if (!raw) return -1
    const at = source.indexOf(raw, from)
    return at >= from && at + raw.length <= limit ? at : -1
  }

  /** Map a renderer-owned inline token list inside one source range. */
  const mapInline = (
    tokens: readonly MarkdownToken[],
    rangeStart: number,
    rangeEnd: number,
    block: number,
  ): { first: number | null; last: number | null } => {
    let cursor = rangeStart
    let first: number | null = null
    let last: number | null = null
    for (const token of tokens) {
      const raw = token.raw ?? ""
      const at = locate(raw, cursor, rangeEnd)
      if (at < 0) continue
      const end = at + raw.length
      pushGap(cursor, at, block)
      first ??= at
      last = end

      const children = Array.isArray(token.tokens) ? token.tokens : []
      // Marked exposes image alt text as child tokens, but `<img>` contributes no
      // DOM text node to the editor's snapshot. Keep the whole image as a seam.
      if (token.type === "image") pushGap(at, end, block, "structural")
      else if (children.length) {
        const childRange = mapInline(children, at, end, block)
        if (
          childRange.first !== null &&
          childRange.last !== null &&
          WRAPPERS.has(token.type as MarkdownInlineWrapper["kind"])
        ) {
          wrappers.push({
            kind: token.type as MarkdownInlineWrapper["kind"],
            at,
            end,
            contentStart: childRange.first,
            contentEnd: childRange.last,
            open: source.slice(at, childRange.first),
            close: source.slice(childRange.last, end),
          })
        }
      } else if (token.type === "text") pushText(at, end, block)
      else if (token.type === "escape" || token.type === "codespan")
        pushEntity(token.text ?? "", at, end, block)
      else if (token.type === "html") pushHtml(raw, at, block)
      // A break contributes no DOM text, an image contributes no text node, and
      // every other non-leaf token is renderer syntax. Keep it as a mapped gap.
      else pushGap(at, end, block)

      cursor = end
    }
    pushGap(cursor, rangeEnd, block)
    return { first, last }
  }

  const top = marked.lexer(source, { gfm: true }) as unknown as MarkdownToken[]

  /** Lists expose normalized nested tokens, but each item still carries an exact
   * raw slice. Map the visible inline text inside that slice and mark the bullet /
   * task checkbox / nested remainder as structural seams. */
  const mapList = (token: MarkdownToken, rangeStart: number, rangeEnd: number) => {
    let cursor = rangeStart
    for (const item of token.items ?? []) {
      const raw = item.raw ?? ""
      const at = locate(raw, cursor, rangeEnd)
      if (at < 0) continue
      const end = at + raw.length
      const block = blockSeq++
      pushGap(cursor, at, block, "structural")
      const textToken = (item.tokens ?? []).find(
        (child) => child.type === "text" && Array.isArray(child.tokens),
      )
      const textRaw = textToken?.raw ?? ""
      const textAt = locate(textRaw, at, end)
      if (textToken && textAt >= 0) {
        pushGap(at, textAt, block, "structural")
        mapInline(textToken.tokens ?? [], textAt, textAt + textRaw.length, block)
        pushGap(textAt + textRaw.length, end, block, "structural")
      } else pushText(at, end, block)
      cursor = end
    }
    if (cursor < rangeEnd) pushGap(cursor, rangeEnd, blockSeq++, "structural")
  }

  /** Blockquotes normalize away their `>` markers. Locate each nested paragraph's
   * raw inline text inside the original slice and keep the markers structural. */
  const mapBlockquote = (token: MarkdownToken, rangeStart: number, rangeEnd: number) => {
    let cursor = rangeStart
    for (const child of token.tokens ?? []) {
      const raw = child.raw ?? ""
      const at = locate(raw, cursor, rangeEnd)
      if (at < 0) continue
      const end = at + raw.length
      const block = blockSeq++
      pushGap(cursor, at, block, "structural")
      if (Array.isArray(child.tokens) && child.tokens.length)
        mapInline(child.tokens, at, end, block)
      else pushText(at, end, block)
      cursor = end
    }
    if (cursor < rangeEnd) pushGap(cursor, rangeEnd, blockSeq++, "structural")
  }

  /** Table cell token text is an exact source slice even though row/pipe structure
   * is normalized. Give every cell its own block so an edit cannot merge cells. */
  const mapTable = (token: MarkdownToken, rangeStart: number, rangeEnd: number) => {
    let cursor = rangeStart
    const cells = [...(token.header ?? []), ...(token.rows ?? []).flat()]
    for (const cell of cells) {
      const raw = cell.text ?? ""
      if (!raw) continue
      const at = locate(raw, cursor, rangeEnd)
      if (at < 0) continue
      const end = at + raw.length
      const block = blockSeq++
      pushGap(cursor, at, block, "structural")
      if (Array.isArray(cell.tokens) && cell.tokens.length) mapInline(cell.tokens, at, end, block)
      else pushText(at, end, block)
      cursor = end
    }
    if (cursor < rangeEnd) pushGap(cursor, rangeEnd, blockSeq++, "structural")
  }

  let cursor = 0
  for (const token of top) {
    const raw = token.raw ?? ""
    const at = locate(raw, cursor, source.length)
    if (at < 0) continue
    const end = at + raw.length
    const block = blockSeq++
    pushGap(cursor, at, block)
    const inline = Array.isArray(token.tokens) ? token.tokens : []
    if ((token.type === "paragraph" || token.type === "heading") && inline.length)
      mapInline(inline, at, end, block)
    else if (token.type === "list") mapList(token, at, end)
    else if (token.type === "blockquote") mapBlockquote(token, at, end)
    else if (token.type === "table") mapTable(token, at, end)
    else if (token.type === "html") pushHtml(raw, at, block)
    else if (token.type === "space" || token.type === "hr") pushGap(at, end, block)
    else {
      // Fenced/indented code and other unsupported composites stay literal until
      // their nested source maps can be proven safe.
      pushText(at, end, block)
    }
    cursor = end
  }
  if (cursor < source.length) pushText(cursor, source.length, blockSeq++)

  return { text: parts.join(""), segments, wrappers }
}
