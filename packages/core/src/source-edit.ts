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
  /** Carries `data-derive-src` when served to an editor (a body element outside
   *  template/noscript), and is therefore addressable by ops. */
  stamped: boolean
}

/** Every start tag in source order with its browser-effective range. One tokenizer pass
 *  (html-tags), explicit ranges from structural-edit, `elementEnd` only for elements the
 *  author closed implicitly. Elements whose ranges cross (misnested markup) get end -1. */
const indexElements = (html: string): SourceNode[] => {
  const all = tags(html)
  const explicit = sourceElements(html, all)
  const closeAt = new Map(all.filter((t) => t.closing).map((t) => [t.end, t]))
  const els: SourceNode[] = []
  all.forEach((tag, i) => {
    if (tag.closing) return
    const known = explicit[els.length]
    let end = known?.end ?? -1
    let innerEnd = known?.closeStart ?? -1
    if (end < 0) {
      end = elementEnd(all, i)
      const close = closeAt.get(end)
      innerEnd = close?.name === tag.name ? close.start : end
    }
    els.push({ n: els.length, tag, end, innerEnd, stamped: false })
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
}

const usable = (el: SourceNode | undefined): el is SourceNode => !!el && el.stamped && el.end >= 0

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Text becomes character data, never markup. Quotes stay as typed: they are inert in
 *  text, and escaping them would rewrite untouched prose inside an edited element. */
const escapeText = (text: string): string =>
  text.replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"))

/** The sha256 of stored source text, as the editor's page and source map report it. */
export const sourceSha = (html: string): Promise<string> => sha256Hex(encode(html))

const hashOf = async (html: string, el: SourceNode | undefined): Promise<SourceHash> =>
  usable(el) ? (await sha256Hex(encode(html.slice(el.tag.start, el.end)))).slice(0, 16) : ""

/** The hash for every source id (array index = N). "" marks an element no op may name
 *  or keep: not stamped, or markup whose end the source does not state. */
export const sourceMap = async (html: string): Promise<{ sha: string; hashes: SourceHash[] }> => {
  const els = indexElements(html)
  const [sha, hashes] = await Promise.all([
    sourceSha(html),
    Promise.all(els.map((el) => hashOf(html, el))),
  ])
  return { sha, hashes }
}

/**
 * The editor's view of a stored document: `data-derive-src="N"` inserted right after the
 * tag name of every body element, and the base identity on the root element
 * (`data-derive-src-version`, `data-derive-src-sha`). Byte-identical to the input apart from
 * those attributes. A document without an `<html>` tag gets one before its first element;
 * the parser merges its attributes onto the root it has already implied.
 */
export const stampSourceIds = (html: string, base: { version: number; sha: string }): string => {
  const els = indexElements(html)
  const marker = ` data-derive-src-version="${base.version}" data-derive-src-sha="${escapeHtml(base.sha)}"`
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
  const expected = new Map<number, SourceHash>()
  const expect = (n: number, hash: SourceHash): void => {
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
    expect(op.src, op.hash)
    if (op.op === "content") walk(op.children)
  }
  const actual = await Promise.all(
    [...expected].map(async ([n, h]) => [n, h, await hashOf(html, els[n])] as const),
  )
  const conflicts = actual.filter(([, want, got]) => want !== got).map(([n]) => n)
  if (conflicts.length)
    throw new SourceConflictError(
      `${conflicts.length === 1 ? "An element" : `${conflicts.length} elements`} changed since this page was loaded: ${conflicts.map(place).join(", ")}. Reload to see the latest version, then redo ${conflicts.length === 1 ? "that edit" : "those edits"}.`,
      conflicts.sort((a, b) => a - b),
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
  const out = splice(
    0,
    html.length,
    [...overrides, ...replaced].sort((a, b) => a.start - b.start || b.end - a.end),
  )
  if (out === html)
    throw new EditError(
      "These ops leave the document exactly as it is, so there is nothing to save.",
    )
  return { html: out, changes }
}
