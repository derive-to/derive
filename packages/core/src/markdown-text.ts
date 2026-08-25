import { marked } from "marked"
import { decodedEntitiesIn, type PageTextSegment, pageTextParts } from "./anchor"

/** A page-text run projected from Markdown. `block` is the rendered editable block
 *  that owns the text; an edit may cross inline syntax inside one block, but never
 *  a paragraph/list/table boundary. */
export interface MarkdownTextSegment extends PageTextSegment {
  block: number
  boundary?: "inline" | "html" | "structural"
}

export interface MarkdownInlineWrapper {
  kind: "strong" | "em" | "del" | "link" | "code"
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

const WRAPPERS = new Set<MarkdownInlineWrapper["kind"]>(["strong", "em", "del", "link", "code"])

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
    projectSpace = true,
  ) => {
    if (rEnd <= rStart) return
    segments.push({
      kind: "gap",
      tStart: tLen,
      tEnd: tLen + (projectSpace ? 1 : 0),
      rStart,
      rEnd,
      block,
      boundary,
    })
    if (projectSpace) {
      parts.push(" ")
      tLen++
    }
  }

  const pushEntity = (text: string, rStart: number, rEnd: number, block: number) => {
    if (!text) return
    segments.push({ kind: "entity", tStart: tLen, tEnd: tLen + text.length, rStart, rEnd, block })
    parts.push(text)
    tLen += text.length
  }

  const pushText = (rStart: number, rEnd: number, block: number) => {
    const raw = source.slice(rStart, rEnd)
    let last = 0
    for (const entity of decodedEntitiesIn(source, rStart, rEnd)) {
      const localStart = entity.start - rStart
      const localEnd = entity.end - rStart
      if (localStart > last) {
        const plain = raw.slice(last, localStart)
        segments.push({
          kind: "text",
          tStart: tLen,
          tEnd: tLen + plain.length,
          rStart: rStart + last,
          rEnd: entity.start,
          block,
        })
        parts.push(plain)
        tLen += plain.length
      }
      pushEntity(entity.text, entity.start, entity.end, block)
      last = localEnd
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

  /** A renderer removes blockquote/list prefixes from fenced code token.raw. Map
   *  the visible code body inside the authored range instead of requiring that
   *  normalized token slice to occur byte-for-byte in the source. Multi-line
   *  prefixed bodies stay line-local so an edit cannot erase their structural
   *  `>` or list indentation. */
  const mapCode = (token: MarkdownToken, rangeStart: number, rangeEnd: number, block: number) => {
    const body = token.text ?? ""
    if (!body) {
      pushGap(rangeStart, rangeEnd, block, "structural")
      return
    }
    // For fenced code, the info string is source-only metadata and may contain the
    // same word as the rendered body. Never begin a body lookup until after the
    // opening fence line.
    const fenced = /^(?:`{3,}|~{3,})/.test(token.raw ?? "")
    const openingLineEnd = fenced ? source.indexOf("\n", rangeStart) : -1
    const bodyStart =
      openingLineEnd >= rangeStart && openingLineEnd < rangeEnd ? openingLineEnd + 1 : rangeStart
    const direct = locate(body, bodyStart, rangeEnd)
    if (direct >= 0) {
      pushGap(rangeStart, direct, block, "structural")
      pushText(direct, direct + body.length, block)
      pushGap(direct + body.length, rangeEnd, block, "structural")
      return
    }
    let cursor = bodyStart
    let previousLine = -1
    for (const [lineIndex, line] of body.split("\n").entries()) {
      if (!line) continue
      const at = locate(line, cursor, rangeEnd)
      if (at < 0) continue
      if (previousLine < 0 && lineIndex === 0) pushGap(rangeStart, at, block, "structural")
      else {
        if (previousLine < 0) pushGap(rangeStart, bodyStart, block, "structural")
        // The browser exposes a newline between code lines, while authored
        // blockquote/list prefixes live inside that separator. Mapping the whole
        // separator as one rendered newline lets a replacement remove complete
        // lines without leaving or deleting a partial structural prefix.
        pushEntity("\n".repeat(lineIndex - previousLine), cursor, at, block)
      }
      pushText(at, at + line.length, block)
      cursor = at + line.length
      previousLine = lineIndex
    }
    pushGap(cursor, rangeEnd, block, "structural")
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
      if (at < 0) {
        // Container parsers normalize away a prefix on every authored line, so a
        // multi-line text leaf may not exist as one contiguous raw substring. Map
        // each visible line in order and keep the intervening prefixes structural.
        if (token.type === "text" && raw.includes("\n")) {
          let lineCursor = cursor
          for (const line of raw.split("\n")) {
            if (!line) continue
            const lineAt = locate(line, lineCursor, rangeEnd)
            if (lineAt < 0) continue
            pushGap(
              lineCursor,
              lineAt,
              block,
              "structural",
              /\s/.test(source.slice(lineCursor, lineAt)),
            )
            pushText(lineAt, lineAt + line.length, block)
            first ??= lineAt
            last = lineAt + line.length
            lineCursor = lineAt + line.length
          }
          cursor = lineCursor
        }
        continue
      }
      const end = at + raw.length
      pushGap(cursor, at, block, "inline", /\s/.test(source.slice(cursor, at)))
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
      else if (token.type === "codespan") {
        const fence = /^`+/.exec(raw)?.[0] ?? ""
        if (fence && raw.endsWith(fence) && raw.length >= fence.length * 2) {
          const contentStart = at + fence.length
          const contentEnd = end - fence.length
          pushGap(at, contentStart, block, "inline", false)
          pushEntity(token.text ?? "", contentStart, contentEnd, block)
          pushGap(contentEnd, end, block, "inline", false)
          wrappers.push({
            kind: "code",
            at,
            end,
            contentStart,
            contentEnd,
            open: fence,
            close: fence,
          })
        } else pushGap(at, end, block, "structural", /\s/.test(raw))
      } else if (token.type === "escape") pushEntity(token.text ?? "", at, end, block)
      else if (token.type === "html") pushHtml(raw, at, block)
      // A break contributes no DOM text, an image contributes no text node, and
      // every other non-leaf token is renderer syntax. Keep it as a mapped gap.
      else pushGap(at, end, block, "inline", /\s/.test(raw))

      cursor = end
    }
    pushGap(cursor, rangeEnd, block, "inline", /\s/.test(source.slice(cursor, rangeEnd)))
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
      const located = locate(raw, cursor, rangeEnd)
      // Container prefixes can make a normalized multi-line item absent as one
      // contiguous source slice. A single item still owns the whole supplied
      // range, and its child tokens can be located safely inside that range.
      if (located < 0 && (token.items?.length ?? 0) !== 1) continue
      const at = located < 0 ? cursor : located
      const end = located < 0 ? rangeEnd : located + raw.length
      let itemCursor = at
      for (const child of item.tokens ?? []) {
        const childRaw = child.raw ?? ""
        const childAt = locate(childRaw, itemCursor, end)
        if (childAt < 0 && child.type === "code") {
          mapCode(child, itemCursor, end, blockSeq++)
          itemCursor = end
          continue
        }
        if (childAt < 0 && child.type === "blockquote") {
          mapBlockquote(child, itemCursor, end)
          itemCursor = end
          continue
        }
        if (childAt < 0 && child.type === "list") {
          mapList(child, itemCursor, end)
          itemCursor = end
          continue
        }
        if (childAt < 0 && Array.isArray(child.tokens) && child.tokens.length) {
          mapInline(child.tokens, itemCursor, end, blockSeq++)
          itemCursor = end
          continue
        }
        if (childAt < 0) continue
        const childEnd = childAt + childRaw.length
        if (child.type === "list") {
          pushGap(itemCursor, childAt, blockSeq++, "structural")
          mapList(child, childAt, childEnd)
        } else if (child.type === "blockquote") {
          pushGap(itemCursor, childAt, blockSeq++, "structural")
          mapBlockquote(child, childAt, childEnd)
        } else {
          const block = blockSeq++
          pushGap(itemCursor, childAt, block, "structural")
          if (child.type === "code") mapCode(child, childAt, childEnd, block)
          else if (Array.isArray(child.tokens) && child.tokens.length)
            mapInline(child.tokens, childAt, childEnd, block)
          else pushText(childAt, childEnd, block)
        }
        itemCursor = childEnd
      }
      if (itemCursor < end) pushGap(itemCursor, end, blockSeq++, "structural")
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
      if (at < 0 && child.type === "code") {
        mapCode(child, cursor, rangeEnd, blockSeq++)
        cursor = rangeEnd
        continue
      }
      if (at < 0 && child.type === "list") {
        mapList(child, cursor, rangeEnd)
        cursor = rangeEnd
        continue
      }
      if (at < 0 && child.type === "blockquote") {
        mapBlockquote(child, cursor, rangeEnd)
        cursor = rangeEnd
        continue
      }
      if (at < 0 && Array.isArray(child.tokens) && child.tokens.length) {
        mapInline(child.tokens, cursor, rangeEnd, blockSeq++)
        cursor = rangeEnd
        continue
      }
      if (at < 0) continue
      const end = at + raw.length
      const block = blockSeq++
      pushGap(cursor, at, block, "structural")
      if (child.type === "list") mapList(child, at, end)
      else if (child.type === "blockquote") mapBlockquote(child, at, end)
      else if (child.type === "code") mapCode(child, at, end, block)
      else if (Array.isArray(child.tokens) && child.tokens.length)
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
    else if (token.type === "code") mapCode(token, at, end, block)
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
