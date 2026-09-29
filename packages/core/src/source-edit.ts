/**
 * Exact-source editing: the rendered editor names what changed by where it lives in the
 * stored source, never by searching for text.
 *
 * Serving (editors only) stamps `data-derive-src="N"` on every body element, where N is
 * the element's index among ALL start tags of the stored source. A save then says "element
 * N's children are now …" as tokens: typed text, `keep` (copy an original element's exact
 * bytes, optionally with new children), or a small allowlist of editor formatting. Nothing
 * is searched, so repeated wording, line breaks, whitespace and entities cannot make an edit
 * ambiguous; the only failure left is someone else having changed that element, caught by
 * each referenced element's content hash.
 *
 * Moves, duplicates and deletes are the same operation: a parent's new child list keeps an
 * element from anywhere (move), keeps it twice (duplicate, with fresh identities), or leaves
 * it out (delete). Every byte outside the edited elements' inner ranges is untouched, and a
 * kept element's bytes are its stored bytes.
 */

import { DECK_CONTENT_TYPE, HTML_CONTENT_TYPE, isMarkdownLike } from "./content-types"
import {
  type CopyIdentities,
  copyIdentitiesOf,
  copyWithFreshIdentities,
  sliceSlides,
} from "./decks"
import { EditError } from "./doc-text"
import { sha256Hex } from "./hash"
import { elementEnd, type HtmlTag, RAW_TEXT_ELEMENTS, RCDATA_ELEMENTS, tags } from "./html-tags"
import { escapeHtml } from "./md"
import { lastOf, Recent } from "./memo"
import { hexOf, Sha256 } from "./sha256"
import { setLayoutAttributes, sourceElements } from "./structural-edit"
import { setOpeningTagStyle } from "./style-attribute"

/** First 16 hex digits of the sha256 of an element's full outer source bytes (UTF-8). */
export type SourceHash = string

export type SourceInlineTag = "b" | "strong" | "i" | "em" | "a" | "br"

export type SourceToken =
  | { text: string }
  /** A DOM Comment node's data, verbatim: the source's `<!--data-->` round-trips exactly. */
  | { comment: string }
  | { keep: number; hash: SourceHash; children?: SourceToken[] }
  | { tag: SourceInlineTag; href?: string; children?: SourceToken[] }

export type SourceOp =
  | { op: "content"; src: number; hash: SourceHash; children: SourceToken[] }
  /** Set (a string) or remove (null) the style attribute and the structural layout
   *  attributes the editor writes (data-derive-size|width|height|align|gap), checked by
   *  the structural contract. An omitted field stays as it is. */
  | {
      op: "attrs"
      src: number
      hash: SourceHash
      style?: string | null
      attrs?: Record<string, string | null>
    }

/** Someone changed a referenced element since the page was served. `conflicts` lists the
 *  source ids, so the editor can say which edits need redoing. */
export class SourceConflictError extends EditError {
  constructor(
    message: string,
    readonly conflicts: number[],
  ) {
    super(message)
  }
}

/** The stored types the rendered editor saves as ops (and is served stamped for).
 *  Markdown names rendered elements by markdown-source.ts's ids instead of start tags. */
export const isSourceEditable = (contentType: string): boolean => {
  const base = contentType.split(";")[0]?.trim()
  return base === HTML_CONTENT_TYPE || base === DECK_CONTENT_TYPE || isMarkdownLike(contentType)
}

const MAX_SOURCE_OPS = 500
const MAX_TOKENS = 50_000
const MAX_DEPTH = 64
const MAX_STYLE = 4096
/** Duplicates copy bytes, so a small payload could ask for an enormous document. Cap the
 *  output at the upload limit's order of magnitude before building it. */
const MAX_OUTPUT_CHARS = 100 * 1024 * 1024
const INLINE_TAGS = new Set<string>(["b", "strong", "i", "em", "a", "br"])
/** Elements whose DOM children are not their source children, so no child list can say
 *  what they contain. `template`/`noscript` bodies are also never stamped. */
const OPAQUE = new Set([...RAW_TEXT_ELEMENTS, ...RCDATA_ELEMENTS, "template", "noscript"])

interface SourceNode {
  n: number
  tag: HtmlTag
  /** Offset past the element's last byte; -1 when the source does not say where it ends. */
  end: number
  /** Where its inner content ends (its close tag's `<`, or `end` when implicitly closed). */
  innerEnd: number
  /** Its end is written in the source (a close tag, or a void element), not implied. */
  explicit: boolean
  /** Carries `data-derive-src` when served to an editor (a body element outside
   *  template/noscript), and is therefore addressable by ops. */
  stamped: boolean
}

/** Every start tag in source order with its browser-effective range. One tokenizer pass
 *  (html-tags), explicit ranges from structural-edit, `elementEnd` only for elements the
 *  author closed implicitly. Elements whose ranges cross (misnested markup) get end -1. */
const indexElements = lastOf(3, 32_768, (html: string): readonly SourceNode[] => {
  const all = tags(html)
  const explicit = sourceElements(html, all)
  const closeAt = new Map(all.filter((t) => t.closing).map((t) => [t.end, t]))
  const els: SourceNode[] = []
  all.forEach((tag, i) => {
    if (tag.closing) return
    const known = explicit[els.length]
    let end = known?.end ?? -1
    let innerEnd = known?.closeStart ?? -1
    const stated = end >= 0
    if (end < 0) {
      end = elementEnd(all, i)
      const close = closeAt.get(end)
      innerEnd = close?.name === tag.name ? close.start : end
    }
    els.push({ n: els.length, tag, end, innerEnd, explicit: stated, stamped: false })
  })
  const open: SourceNode[] = []
  const crossed = new Set<SourceNode>()
  let unstampedUntil = -1
  for (const el of els) {
    while (open.length && (open.at(-1) as SourceNode).end <= el.tag.start) open.pop()
    const parent = open.at(-1)
    if (parent && el.end > parent.end) crossed.add(el).add(parent)
    el.stamped = el.tag.start >= unstampedUntil && el.tag.name !== "html" && el.tag.name !== "head"
    if (el.tag.name === "head" || el.tag.name === "template" || el.tag.name === "noscript")
      unstampedUntil = Math.max(unstampedUntil, el.end < 0 ? html.length : el.end)
    if (el.end >= 0 && !el.tag.selfClosing) open.push(el)
  }
  for (const el of crossed) el.end = -1
  return els
})

const usable = (el: SourceNode | undefined): el is SourceNode => !!el && el.stamped && el.end >= 0

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A string's UTF-8 bytes, and the byte offset of each of its UTF-16 offsets. */
const utf8 = (text: string): { bytes: Uint8Array; at: (i: number) => number } => {
  const bytes = encode(text)
  if (bytes.length === text.length) return { bytes, at: (i) => i }
  const offsets = new Uint32Array(text.length + 1)
  let b = 0
  for (let i = 0; i < text.length; i++) {
    offsets[i] = b
    const c = text.charCodeAt(i)
    if (c < 0x80) b += 1
    else if (c < 0x800) b += 2
    else if (c >= 0xd800 && c < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      offsets[++i] = b
      b += 4
    } else b += 3
  }
  offsets[text.length] = b
  return { bytes, at: (i) => offsets[i] as number }
}

/** Text becomes character data, never markup. Quotes stay as typed: they are inert in
 *  text, and escaping them would rewrite untouched prose inside an edited element. */
const escapeText = (text: string): string =>
  text.replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"))

/** The sha256 of stored source text, as the editor's page and source map report it. */
export const sourceSha = (html: string): Promise<string> => sha256Hex(encode(html))

/** The hash an op names a source slice by (Markdown's nodes). */
export const hashSource = (text: string): SourceHash => {
  const bytes = encode(text)
  return hexOf(new Sha256().update(bytes).digest(), 8)
}

/** Separates an element's own bytes from a child's digest in what its hash covers: 0xFF is
 *  never a byte of UTF-8, so the stream reads back one way only. */
const CHILD = new Uint8Array([0xff])

/** A document an op save made from another, and where: `segments` are the old
 *  document's replaced ranges (sorted, disjoint) with their new text. Lets the new
 *  document's hashes reuse every digest of an element the save left alone. */
const madeBy = new Recent<string, { from: string; segments: readonly Segment[] }>(4)

/** The segments a splice applies: sorted, and each one starting past the last. */
const disjoint = (segments: readonly Segment[]): Segment[] => {
  const out: Segment[] = []
  let cursor = 0
  for (const seg of segments) {
    if (seg.start < cursor) continue
    out.push(seg)
    cursor = seg.end
  }
  return out
}

interface Digests {
  hex: readonly SourceHash[]
  /** Each element's full digest (32 bytes at 32·N), all zero where it has none. */
  full: Uint8Array
}

/**
 * Every element's hash (array index = N), "" for an element no op may name or keep (not
 * stamped, or markup whose end the source doesn't state). An element's hash is the SHA-256
 * of its outer bytes with each child element's bytes replaced by 0xFF and that child's own
 * digest: it pins exactly the same bytes a hash of the whole slice would, but the document
 * is hashed about once rather than once per level of nesting (a 150-slide deck is ten
 * megabytes of nested slices). A document a save just made hashes only what the save
 * changed and the elements holding it; everything else keeps its digest. Remembered for
 * the last few documents.
 */
const elementDigests = lastOf(4, 32_768, (html: string): Digests => {
  const els = indexElements(html)
  const { bytes, at } = utf8(html)
  const hex = new Array<SourceHash>(els.length).fill("")
  const full = new Uint8Array(32 * els.length)
  // A save's result: the previous document's digests, where the save left bytes alone.
  const made = madeBy.get(html)
  madeBy.delete(html)
  const was = made && elementDigests.peek(made.from)
  const wasEls = was && made ? indexElements(made.from) : null
  const wasAt = wasEls ? new Map(wasEls.map((e) => [e.tag.start, e])) : null
  // The save's segments in new offsets, and the shift they leave after them.
  const moved: { start: number; end: number; shift: number }[] = []
  if (made) {
    let shift = 0
    for (const seg of made.segments) {
      const start = seg.start + shift
      shift += seg.text.length - (seg.end - seg.start)
      moved.push({ start, end: start + seg.text.length, shift })
    }
  }
  /** The previous document's element with these very bytes at this place, if any. */
  let seg = 0
  const unchanged = (el: SourceNode): SourceNode | undefined => {
    if (!was || !wasAt) return undefined
    while (seg < moved.length && (moved[seg] as { end: number }).end <= el.tag.start) seg++
    const next = moved[seg]
    // A segment overlapping or inside the element: its bytes changed.
    if (next && next.start < el.end && !(next.start === next.end && next.start === el.tag.start))
      return undefined
    const shift = seg ? (moved[seg - 1] as { shift: number }).shift : 0
    const old = wasAt.get(el.tag.start - shift)
    if (!old || old.end !== el.end - shift || old.tag.name !== el.tag.name) return undefined
    // It had a digest of its own (it wasn't misnested there).
    return was.full.subarray(32 * old.n, 32 * old.n + 32).some((b) => b !== 0) ? old : undefined
  }

  // One hasher per depth, reused: frames only ever nest.
  const pool: Sha256[] = []
  const open: { el: SourceNode; cursor: number }[] = []
  const give = (child: SourceNode, digest: Uint8Array) => {
    const parent = open.at(-1)
    if (!parent) return
    ;(pool[open.length - 1] as Sha256)
      .update(bytes, parent.cursor, at(child.tag.start))
      .update(CHILD)
      .update(digest)
    parent.cursor = at(child.end)
  }
  const close = () => {
    const f = open.pop() as { el: SourceNode; cursor: number }
    const digest = (pool[open.length] as Sha256).update(bytes, f.cursor, at(f.el.end)).digest()
    full.set(digest, 32 * f.el.n)
    if (usable(f.el)) hex[f.el.n] = hexOf(digest, 8)
    give(f.el, digest)
  }
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as SourceNode
    if (el.end < 0) continue
    while (open.length && (open.at(-1) as { el: SourceNode }).el.end <= el.tag.start) close()
    // Crossing its container (misnested markup the index didn't catch): its bytes are the
    // container's own, and nothing may name it.
    const top = open.at(-1)
    if (top && el.end > top.el.end) continue
    const old = unchanged(el)
    if (old && was) {
      // The same bytes as before: its digest and every one inside it carry over.
      const d = old.n - el.n
      let j = i
      for (; j < els.length && (els[j] as SourceNode).tag.start < el.end; j++) {
        const n = (els[j] as SourceNode).n
        hex[n] = was.hex[n + d] ?? ""
        full.set(was.full.subarray(32 * (n + d), 32 * (n + d + 1)), 32 * n)
      }
      give(el, was.full.subarray(32 * old.n, 32 * (old.n + 1)))
      i = j - 1
      continue
    }
    pool[open.length] ??= new Sha256()
    open.push({ el, cursor: at(el.tag.start) })
  }
  while (open.length) close()
  return { hex, full }
})
const elementHashes = (html: string): readonly SourceHash[] => elementDigests(html).hex

/** Every source id's hash, and the sha of the whole source (see elementHashes). */
export const sourceMap = async (html: string): Promise<{ sha: string; hashes: SourceHash[] }> => ({
  sha: await sourceSha(html),
  hashes: [...elementHashes(html)],
})

/** The app origins (space-separated) whose pages may drive this document's editor: the
 *  in-frame client takes editing messages only from its parent at one of these. */
export const hostMarker = (host: string | undefined): string =>
  host ? ` data-derive-host="${escapeHtml(host)}"` : ""
/** An editor's page of any kind (a LaTeX paper, a bundle's page) carrying `host` first on
 *  its root (a page stamped with it already is left alone). Without an `<html>` tag one
 *  goes before the first element, as stampSourceIds does. */
export const withHostMarker = (html: string, host: string | undefined): string => {
  if (!host) return html
  // Past a leading doctype and comments: the root tag, or where one goes.
  const lead = /^(?:\s|<!--[\s\S]*?-->|<!doctype[^>]*>)*/i.exec(html)?.[0].length ?? 0
  const root = /^<html\b[^>]*/i.exec(html.slice(lead))
  // Ours comes first: a document's own `data-derive-host` loses (the parser keeps the
  // first of a repeated attribute).
  if (root && /\sdata-derive-host="[^"]*"/i.exec(root[0])?.[0] === hostMarker(host)) return html
  const at = root ? lead + 5 : lead
  return (
    html.slice(0, at) + (root ? hostMarker(host) : `<html${hostMarker(host)}>`) + html.slice(at)
  )
}

/**
 * The editor's view of a stored document: `data-derive-src="N"` inserted right after the
 * tag name of every body element, and the base identity on the root element
 * (`data-derive-src-version`, `data-derive-src-sha`), with the app origins allowed to drive
 * the editor (`data-derive-host`, see hostMarker). Byte-identical to the input apart from
 * those attributes. A document without an `<html>` tag gets one before its first element;
 * the parser merges its attributes onto the root it has already implied.
 */
export const stampSourceIds = (
  html: string,
  base: { version: number; sha: string; host?: string },
): string => {
  const els = indexElements(html)
  const marker = ` data-derive-src-version="${base.version}" data-derive-src-sha="${escapeHtml(base.sha)}"${hostMarker(base.host)}`
  const root = els.find((el) => el.tag.name === "html")
  const inserts: [number, string][] = []
  if (!root && els[0]) inserts.push([els[0].tag.start, `<html${marker}>`])
  for (const el of els) {
    const at = el.tag.start + 1 + el.tag.name.length
    if (el === root) inserts.push([at, marker])
    else if (el.stamped) inserts.push([at, ` data-derive-src="${el.n}"`])
  }
  let out = ""
  let cursor = 0
  for (const [at, text] of inserts) {
    out += html.slice(cursor, at) + text
    cursor = at
  }
  return out + html.slice(cursor)
}

// ── Payload validation ──────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)
const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const isHash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{16}$/.test(v)

/** Shape-check an untrusted `ops` payload. Every failure is a 400 naming the position. */
export const parseSourceOps = (raw: unknown): SourceOp[] => {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new EditError("`ops` must be a non-empty JSON array of ops.")
  if (raw.length > MAX_SOURCE_OPS)
    throw new EditError(`\`ops\` has ${raw.length} entries — the maximum is ${MAX_SOURCE_OPS}.`)
  let count = 0
  const tokens = (list: unknown, at: string, depth: number): SourceToken[] => {
    if (!Array.isArray(list)) throw new EditError(`${at}.children must be an array of tokens.`)
    if (depth > MAX_DEPTH) throw new EditError(`${at} nests deeper than ${MAX_DEPTH} levels.`)
    count += list.length
    if (count > MAX_TOKENS) throw new EditError(`\`ops\` carries more than ${MAX_TOKENS} tokens.`)
    return list.map((t, i): SourceToken => {
      const here = `${at}.children[${i}]`
      if (isRecord(t) && typeof t.text === "string" && !("keep" in t) && !("tag" in t))
        return { text: t.text }
      if (isRecord(t) && typeof t.comment === "string" && !("keep" in t) && !("tag" in t)) {
        // Refuse only what would end the emitted `<!--data-->` early or open another
        // comment; everything a browser parsed out of stored source (`a -- b`) round-trips.
        if (/-->|--!>|<!--|^-?>|<!-$/.test(t.comment))
          throw new EditError(
            `${here}: a comment can't contain "-->", "--!>" or "<!--", start with ">" or "->", or end with "<!-".`,
          )
        return { comment: t.comment }
      }
      if (isRecord(t) && "keep" in t) {
        if (!isId(t.keep) || !isHash(t.hash))
          throw new EditError(`${here} needs an integer \`keep\` and a 16-hex \`hash\`.`)
        return t.children === undefined
          ? { keep: t.keep, hash: t.hash }
          : { keep: t.keep, hash: t.hash, children: tokens(t.children, here, depth + 1) }
      }
      if (isRecord(t) && typeof t.tag === "string" && INLINE_TAGS.has(t.tag)) {
        const tag = t.tag as SourceInlineTag
        if (tag === "a") {
          const href = typeof t.href === "string" ? t.href.trim() : ""
          if (!/^(?:https?:\/\/|mailto:)/i.test(href))
            throw new EditError(`${here}: a link needs an http(s) or mailto href.`)
          return { tag, href, children: tokens(t.children ?? [], here, depth + 1) }
        }
        if (t.href !== undefined) throw new EditError(`${here}: only a link takes an href.`)
        if (tag === "br") {
          if (t.children !== undefined) throw new EditError(`${here}: br has no children.`)
          return { tag }
        }
        return { tag, children: tokens(t.children ?? [], here, depth + 1) }
      }
      throw new EditError(
        `${here} isn't a token: use {text}, {comment}, {keep, hash, children?}, or {tag: b|strong|i|em|a|br}.`,
      )
    })
  }
  return raw.map((op, i): SourceOp => {
    const at = `ops[${i}]`
    if (!isRecord(op) || !isId(op.src) || !isHash(op.hash))
      throw new EditError(`${at} needs an integer \`src\` and a 16-hex \`hash\`.`)
    if (op.op === "content")
      return { op: "content", src: op.src, hash: op.hash, children: tokens(op.children, at, 0) }
    if (op.op === "attrs") {
      const { style, attrs } = op
      if (
        !(
          style === undefined ||
          style === null ||
          (typeof style === "string" && style.length <= MAX_STYLE)
        )
      )
        throw new EditError(`${at}.style must be a string (≤ ${MAX_STYLE} chars) or null.`)
      if (
        attrs !== undefined &&
        !(isRecord(attrs) && Object.values(attrs).every((v) => v === null || typeof v === "string"))
      )
        throw new EditError(`${at}.attrs must map attribute names to strings or null.`)
      return { op: "attrs", src: op.src, hash: op.hash, style, attrs } as SourceOp
    }
    throw new EditError(`${at}: unknown op ${JSON.stringify(op.op)} — use "content" or "attrs".`)
  })
}

// ── Apply ───────────────────────────────────────────────────────────────────────────

interface Segment {
  start: number
  end: number
  text: string
}

/** The ids a save names (as targets or keeps) whose source no longer hashes as the
 *  editor was served it, in order. One id sent with two different hashes is a 400. */
export const staleSourceIds = async (
  ops: SourceOp[],
  hash: (n: number) => Promise<SourceHash>,
  place: (n: number) => string,
): Promise<number[]> => {
  const expected = new Map<number, SourceHash>()
  const expect = (n: number, hash: SourceHash): void => {
    if ((expected.get(n) ?? hash) !== hash)
      throw new EditError(`${place(n)} is sent with two different hashes.`)
    expected.set(n, hash)
  }
  const walk = (list: SourceToken[]): void => {
    for (const t of list) {
      if ("keep" in t) expect(t.keep, t.hash)
      if ("children" in t && t.children) walk(t.children)
    }
  }
  for (const op of ops) {
    expect(op.src, op.hash)
    if (op.op === "content") walk(op.children)
  }
  const stale = await Promise.all(
    [...expected].map(async ([n, want]) => ((await hash(n)) === want ? -1 : n)),
  )
  return stale.filter((n) => n >= 0).sort((a, b) => a - b)
}

export interface AppliedSourceOps {
  html: string
  /** Each content op's inner source before and after, for the review summary. */
  changes: { before: string; after: string }[]
}

/**
 * Apply an editor save to stored source. Atomic: every op applies, or this throws —
 * `SourceConflictError` when a referenced element no longer hashes the same (409), plain
 * `EditError` for a malformed payload or structural misuse (400). The caller passes the
 * CURRENT source; a save based on an older version still lands when every element it
 * names is byte-identical at the same source id.
 */
export const applySourceOps = async (html: string, raw: unknown): Promise<AppliedSourceOps> => {
  const ops = parseSourceOps(raw)
  const els = indexElements(html)
  let slides: { position: number; start: number; end: number }[] | null = null
  const place = (n: number): string => {
    if (slides === null)
      try {
        slides = sliceSlides(html)
      } catch {
        slides = []
      }
    const el = els[n]
    const slide = el && slides.find((s) => s.start <= el.tag.start && el.tag.start < s.end)
    return slide ? `slide ${slide.position} (element ${n})` : `element ${n}`
  }
  const fail = (message: string): never => {
    throw new EditError(message)
  }

  // 1. Every element the save names must still be the bytes the editor was served.
  const hashes = elementHashes(html)
  const conflicts = await staleSourceIds(ops, async (n) => hashes[n] ?? "", place)
  if (conflicts.length)
    throw new SourceConflictError(
      `${conflicts.length === 1 ? "An element" : `${conflicts.length} elements`} changed since this page was loaded: ${conflicts.map(place).join(", ")}. Reload to see the latest version, then redo ${conflicts.length === 1 ? "that edit" : "those edits"}.`,
      conflicts,
    )
  const at = (n: number): SourceNode => els[n] as SourceNode // hash-verified above, so usable

  // 2. Structure: one op per element, content ops never nested, targets that hold children.
  const holdsChildren = (el: SourceNode, role: string): void => {
    if (el.tag.selfClosing || OPAQUE.has(el.tag.name))
      fail(`${place(el.n)} is a <${el.tag.name}>, whose content can't be ${role}.`)
    for (let k = el.n + 1; k < els.length && (els[k] as SourceNode).tag.start < el.innerEnd; k++)
      if ((els[k] as SourceNode).stamped && (els[k] as SourceNode).end < 0)
        fail(
          `${place(el.n)} can't be ${role}: ${place(k)} inside it has markup whose end the source doesn't state. Edit the source directly.`,
        )
  }
  const contentOps = ops
    .flatMap((op) => (op.op === "content" ? [{ op, el: at(op.src) }] : []))
    .sort((a, b) => a.el.tag.start - b.el.tag.start)
  contentOps.forEach(({ el }, i) => {
    const prev = contentOps[i - 1]?.el
    if (prev && el.tag.start < prev.end)
      fail(
        `${place(el.n)} is inside ${place(prev.n)}, which the same save also edits — express the inner change with keep+children.`,
      )
    holdsChildren(el, "edited")
  })
  const overrides: Segment[] = []
  for (const op of ops) {
    if (op.op !== "attrs") continue
    const el = at(op.src)
    if (overrides.some((s) => s.start === el.tag.start))
      fail(`${place(el.n)} has two attrs ops in one save.`)
    let text = html.slice(el.tag.start, el.tag.end)
    if (op.style !== undefined)
      text = setOpeningTagStyle(
        text,
        op.style === null ? null : escapeHtml(op.style).replaceAll("'", "&#39;"),
      )
    if (op.attrs) {
      const label = place(el.n)
      text = setLayoutAttributes(text, op.attrs, label[0]?.toUpperCase() + label.slice(1))
    }
    overrides.push({ start: el.tag.start, end: el.tag.end, text })
  }
  overrides.sort((a, b) => a.start - b.start)

  const splice = (start: number, end: number, segments: Segment[]): string => {
    let out = ""
    let cursor = start
    for (const s of segments) {
      if (s.start >= end) break
      if (s.start < cursor) continue
      out += html.slice(cursor, s.start) + s.text
      cursor = s.end
    }
    return out + html.slice(cursor, end)
  }
  const contains = (outer: SourceNode, inner: SourceNode): boolean =>
    outer.tag.start <= inner.tag.start && inner.end <= outer.end

  // 3. Copies. An element still present elsewhere — in place (outside every edited range)
  //    or inside another element kept verbatim — or already emitted once, is duplicated,
  //    and its copy gets fresh identities (slide, DOM ids, structural ids).
  const verbatim = new Set<SourceNode>()
  const collect = (list: SourceToken[]): void => {
    for (const t of list)
      if ("keep" in t && !t.children) verbatim.add(at(t.keep))
      else if ("children" in t && t.children) collect(t.children)
  }
  for (const { op } of contentOps) collect(op.children)
  const present = (el: SourceNode): boolean =>
    !contentOps.some(({ el: e }) => e.tag.end <= el.tag.start && el.tag.start < e.innerEnd) ||
    [...verbatim].some((v) => v !== el && contains(v, el))
  const emitted = new Set<SourceNode>()
  let identities: CopyIdentities | null = null
  const links = els.filter((el) => el.tag.name === "a" && el.end >= 0)
  let budget = MAX_OUTPUT_CHARS
  const spend = (text: string): string => {
    budget -= text.length
    if (budget < 0) fail("These ops would build a document larger than the upload limit.")
    return text
  }

  const render = (list: SourceToken[], chain: SourceNode[], inLink: boolean): string => {
    const context = chain.at(-1) as SourceNode
    let out = ""
    for (const t of list) {
      if ("text" in t) out += spend(escapeText(t.text))
      else if ("comment" in t) out += spend(`<!--${t.comment}-->`)
      else if ("tag" in t) {
        if (context.tag.namespace !== "html")
          fail(`${place(context.n)} is SVG or MathML, so it can't take b/i/a/br formatting.`)
        if (t.tag === "br") out += "<br>"
        else if (t.tag === "a") {
          if (inLink) fail(`${place(context.n)} would put a link inside a link.`)
          out += `<a href="${escapeHtml(t.href ?? "")}">${render(t.children ?? [], chain, true)}</a>`
        } else out += `<${t.tag}>${render(t.children ?? [], chain, inLink)}</${t.tag}>`
      } else {
        const el = at(t.keep)
        const cycle = chain.find((c) => contains(el, c))
        if (cycle) fail(`${place(el.n)} can't be kept inside ${place(cycle.n)}, which it contains.`)
        let bytes: string
        if (t.children) {
          holdsChildren(el, "given new children")
          const opening = overrides.find((s) => s.start === el.tag.start)?.text
          bytes =
            (opening ?? html.slice(el.tag.start, el.tag.end)) +
            render(t.children, [...chain, el], inLink || el.tag.name === "a") +
            html.slice(el.innerEnd, el.end)
        } else bytes = spend(splice(el.tag.start, el.end, overrides))
        if (present(el) || emitted.has(el)) {
          identities ??= copyIdentitiesOf(html)
          bytes = copyWithFreshIdentities(bytes, identities)
        } else emitted.add(el)
        out += bytes
      }
    }
    return out
  }

  const changes: AppliedSourceOps["changes"] = []
  const replaced: Segment[] = contentOps.map(({ op, el }) => {
    const inLink = links.some((a) => a !== el && contains(a, el))
    const text = render(op.children, [el], inLink || el.tag.name === "a")
    changes.push({ before: html.slice(el.tag.end, el.innerEnd), after: text })
    return { start: el.tag.end, end: el.innerEnd, text }
  })
  const segments = [...overrides, ...replaced].sort((a, b) => a.start - b.start || b.end - a.end)
  const out = splice(0, html.length, segments)
  if (out === html)
    throw new EditError(
      "These ops leave the document exactly as it is, so there is nothing to save.",
    )
  // The save's result is hashed next (its sync, the next save): from this document's.
  if (elementDigests.peek(html) && out.length >= 32_768) {
    madeBy.set(out, { from: html, segments: disjoint(segments) })
  }
  return { html: out, changes }
}

// ── Sync: bring an editor's stamped page to a newer version in place ────────────────

/** How an editor's page (stamped from one source) becomes the page stamped from another,
 *  without reloading it. Apply in this order, against the old page: find every element
 *  named by a patch's `old` id and every other stamped element; replace each patch root
 *  with its `html` (already stamped with new ids); give every other stamped element outside
 *  a patch root `data-derive-src = remap[its old id]` (always ≥ 0 there). The result is
 *  the new page exactly. `head` means that can't be done in place (something outside the
 *  body changed, or a changed part holds a script, or markup whose extent the source
 *  doesn't state): `patches` is then empty and the page must be swapped whole. Inside a
 *  patch root, `remap[old] ≥ 0` names the new element with identical content, so a caller
 *  may keep its live node instead of the parsed copy. */
export interface StampedSync {
  remap: number[]
  patches: { old: number; html: string }[]
  head: boolean
}
/** What `/sync` answers an editor's page: the sync, and the new version's source map. */
export interface SyncReply extends StampedSync {
  version: number
  sha: string
  hashes: string[]
}

interface StampedEl {
  id: number
  start: number
  end: number
  index: number
  /** Index of its last stamped descendant (itself when it has none). */
  last: number
  kids: StampedEl[]
  name: string
  /** Its outer text without stamps; "" when its extent is unknown. */
  key: string
  /** Parsing its bytes alone gives the same subtree: an explicit end, nothing inside whose
   *  extent is unknown, and no script (a script inserted by a patch never runs). */
  patchable: boolean
}

const STAMP_ATTR = /\sdata-derive-src="(\d+)"/
const BASE_MARK = / data-derive-src-version="\d+" data-derive-src-sha="[^"]*"/

/** A stamped page's elements, keyed by their unstamped bytes. A sync's new page is the
 *  next sync's old one: remembered for the last two. */
const parseStamped = lastOf(2, 32_768, (doc: string) => {
  const els = indexElements(doc)
  const cuts: [number, number][] = []
  const mark = BASE_MARK.exec(doc)
  if (mark) cuts.push([mark.index, mark.index + mark[0].length])
  const unknown: number[] = []
  const scripts: number[] = []
  const found: { el: SourceNode; id: number }[] = []
  for (const el of els) {
    if (el.end < 0) unknown.push(el.tag.start)
    if (el.tag.name === "script") scripts.push(el.tag.start)
    const m = STAMP_ATTR.exec(doc.slice(el.tag.start, el.tag.end))
    if (!m) continue
    const at = el.tag.start + m.index
    cuts.push([at, at + m[0].length])
    found.push({ el, id: Number(m[1]) })
  }
  cuts.sort((a, b) => a[0] - b[0])
  let text = ""
  let cursor = 0
  const removed: number[] = []
  for (const [from, to] of cuts) {
    text += doc.slice(cursor, from)
    cursor = to
    removed.push((removed.at(-1) ?? 0) + to - from)
  }
  text += doc.slice(cursor)
  /** A document offset (never inside a cut) as an offset into `text`. */
  const off = (p: number): number => {
    let lo = 0
    let hi = cuts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((cuts[mid] as [number, number])[1] <= p) lo = mid + 1
      else hi = mid
    }
    return p - (lo ? (removed[lo - 1] as number) : 0)
  }
  const within = (list: number[], start: number, end: number): boolean =>
    list.some((p) => p >= start && p < end)
  const nodes: StampedEl[] = found.map(({ el, id }, index) => ({
    id,
    start: el.tag.start,
    end: el.end,
    index,
    last: index,
    kids: [],
    name: el.tag.name,
    key: el.end < 0 ? "" : text.slice(off(el.tag.start), off(el.end)),
    patchable:
      el.end >= 0 &&
      el.explicit &&
      !within(unknown, el.tag.start, el.end) &&
      !within(scripts, el.tag.start, el.end),
  }))
  const root: StampedEl = {
    id: -1,
    start: 0,
    end: doc.length,
    index: -1,
    last: nodes.length - 1,
    kids: [],
    name: "",
    key: "",
    patchable: false,
  }
  const open: StampedEl[] = [root]
  for (const node of nodes) {
    while (open.length > 1 && (open.at(-1) as StampedEl).end <= node.start) open.pop()
    ;(open.at(-1) as StampedEl).kids.push(node)
    if (node.end > node.start) open.push(node)
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i] as StampedEl
    if (node.end < 0) continue
    let j = i
    while (j + 1 < nodes.length && (nodes[j + 1] as StampedEl).start < node.end) j++
    node.last = j
  }
  /** Its text with each child cut out: what must match for its children to be patched
   *  in place. null when a child's extent is unknown. */
  const shell = (node: StampedEl): string | null => {
    if (node.end < 0 || node.kids.some((k) => k.end < 0)) return null
    let out = ""
    let at = node.start
    for (const k of node.kids) {
      out += `${text.slice(off(at), off(k.start))}\u0000`
      at = k.end
    }
    return out + text.slice(off(at), off(node.end))
  }
  return { doc, nodes, root, shell }
})

/** The longest common subsequence of two key lists, as index pairs (keys "" never match).
 *  A long middle past the budget is left unmatched: hints, not correctness, ride on it. */
const commonPairs = (a: string[], b: string[]): [number, number][] => {
  const pairs: [number, number][] = []
  let lo = 0
  while (lo < a.length && lo < b.length && a[lo] && a[lo] === b[lo]) pairs.push([lo, lo++])
  let hiA = a.length
  let hiB = b.length
  const tail: [number, number][] = []
  while (hiA > lo && hiB > lo && a[hiA - 1] && a[hiA - 1] === b[hiB - 1])
    tail.unshift([--hiA, --hiB])
  const n = hiA - lo
  const m = hiB - lo
  if (n > 0 && m > 0 && n * m <= 250_000) {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        (dp[i] as Uint32Array)[j] =
          a[lo + i] && a[lo + i] === b[lo + j]
            ? ((dp[i + 1] as Uint32Array)[j + 1] as number) + 1
            : Math.max(
                (dp[i + 1] as Uint32Array)[j] as number,
                (dp[i] as Uint32Array)[j + 1] as number,
              )
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[lo + i] && a[lo + i] === b[lo + j]) pairs.push([lo + i++, lo + j++])
      else if (
        ((dp[i + 1] as Uint32Array)[j] as number) >= ((dp[i] as Uint32Array)[j + 1] as number)
      )
        i++
      else j++
    }
  }
  return [...pairs, ...tail]
}

/**
 * What an editor's page, stamped from one source, needs to become the page stamped from
 * another (see {@link StampedSync}). Both arguments are whole stamped pages: an HTML
 * page's `stampSourceIds` output or a Markdown document's `renderMarkdownForEditor`,
 * after the same serve-time transforms. Elements are matched by their unstamped bytes,
 * children by position under a parent whose own bytes (outside its children) are
 * unchanged; the rest is the smallest set of patchable subtrees that covers every change.
 */
export const syncStamped = (before: string, after: string): StampedSync => {
  const A = parseStamped(before)
  const B = parseStamped(after)
  const remap = new Array<number>(A.nodes.reduce((max, n) => Math.max(max, n.id + 1), 0)).fill(-1)
  const size = (n: StampedEl) => n.last - n.index
  const same = (a: StampedEl, b: StampedEl) => !!a.key && a.key === b.key && size(a) === size(b)
  const whole = (a: StampedEl, b: StampedEl, pairs: [number, number][]) => {
    for (let k = 0; k <= size(a); k++)
      pairs.push([(A.nodes[a.index + k] as StampedEl).id, (B.nodes[b.index + k] as StampedEl).id])
  }
  /** Matches inside a replaced subtree: identical children (LCS), and same-tag children
   *  at the same place between them. */
  const hint = (a: StampedEl, b: StampedEl, pairs: [number, number][]) => {
    const common = commonPairs(
      a.kids.map((k) => k.key),
      b.kids.map((k) => k.key),
    )
    let i = 0
    let j = 0
    for (const [ci, cj] of [...common, [a.kids.length, b.kids.length] as [number, number]]) {
      if (ci - i === cj - j)
        for (; i < ci; i++, j++) {
          const ka = a.kids[i] as StampedEl
          const kb = b.kids[j] as StampedEl
          if (ka.name !== kb.name) continue
          pairs.push([ka.id, kb.id])
          hint(ka, kb, pairs)
        }
      const ka = a.kids[ci]
      const kb = b.kids[cj]
      if (ka && kb && same(ka, kb)) whole(ka, kb, pairs)
      i = ci + 1
      j = cj + 1
    }
  }
  const patches: StampedSync["patches"] = []
  const pairs: [number, number][] = []
  /** Whether `a` becomes `b` by patching inside it; records how on success only. */
  const inPlace = (a: StampedEl, b: StampedEl): boolean => {
    if (a.kids.length !== b.kids.length) return false
    const sa = A.shell(a)
    if (sa === null || sa !== B.shell(b)) return false
    const mark = [patches.length, pairs.length]
    const ok = a.kids.every((ka, i) => {
      const kb = b.kids[i] as StampedEl
      if (same(ka, kb)) whole(ka, kb, pairs)
      else if (inPlace(ka, kb)) pairs.push([ka.id, kb.id])
      else if (ka.patchable && kb.patchable) {
        patches.push({ old: ka.id, html: after.slice(kb.start, kb.end) })
        hint(ka, kb, pairs)
      } else return false
      return true
    })
    if (!ok) {
      patches.length = mark[0] as number
      pairs.length = mark[1] as number
    }
    return ok
  }
  const head = !inPlace(A.root, B.root)
  if (head) hint(A.root, B.root, pairs)
  for (const [from, to] of pairs) remap[from] = to
  return { remap, patches: head ? [] : patches, head }
}
