// What Derive knows about slide decks. A deck is not a separate artifact kind — it is a
// single-file HTML page that speaks the `derive-deck` protocol (artifact authoring standard §3), which is
// what turns on the host's deck bar, Present mode, and slide-pinned comments. Both places
// that care — the content-type sniff in publish.ts and the "you built slides but never
// announced them" advisory — resolve it through the ONE pair of predicates here, so what
// gets typed and what gets advised can never disagree.
//
// The authoring guide is derive://skills/decks; the starter is deck-template.html.

import { EditError } from "./doc-text"
import { attrValue, attrValues, classTokens, elementEnd, type HtmlTag, tags } from "./html-tags"

/** HTML comments hold prose ABOUT decks (including this repo's own annotated starter) and
 *  render nothing, so they must never make a page look like a deck. Stripped before any
 *  structural count.
 *
 *  A linear indexOf scan rather than `replace(/<!--[\s\S]*?-->/g, "")`, for two reasons.
 *  (1) That regex is polynomial on hostile input: with the `g` flag and a lazy body, a
 *  document of many unclosed `<!--` restarts a scan-to-end at every one of them, and this
 *  runs on every publish over content we do not control. (2) It is also more correct — an
 *  UNTERMINATED comment left the rest of the document visible to the regex, while a
 *  browser treats everything after it as commented out, so markup a reader never sees
 *  could still be counted as slides. */
const withoutCommentsInText = (html: string): string => {
  let out = ""
  let i = 0
  for (;;) {
    const start = html.indexOf("<!--", i)
    if (start === -1) return out + html.slice(i)
    out += html.slice(i, start)
    const ordinary = html.indexOf("-->", start + 4)
    const legacy = html.indexOf("--!>", start + 4)
    const end = ordinary < 0 ? legacy : legacy < 0 ? ordinary : Math.min(ordinary, legacy)
    if (end === -1) return out // unterminated: the rest of the document is inside it
    i = end + (html.startsWith("--!>", end) ? 4 : 3)
  }
}

/** Remove real HTML comments while preserving parsed tags and raw script/style
 *  elements verbatim. In raw text and quoted attributes, `<!--` is data rather
 *  than an HTML comment opener; treating it as one can hide a valid protocol post. */
const withoutComments = (html: string): string => {
  const all = tags(html)
  const protectedRanges: { start: number; end: number }[] = all.map((tag) => ({
    start: tag.start,
    end: tag.end,
  }))
  for (let i = 0; i < all.length; i++) {
    const open = all[i]
    if (!open || open.closing || (open.name !== "script" && open.name !== "style")) continue
    const end = elementEnd(all, i)
    protectedRanges.push({ start: open.start, end: end < 0 ? html.length : end })
  }
  if (!protectedRanges.length) return withoutCommentsInText(html)
  protectedRanges.sort((a, b) => a.start - b.start || b.end - a.end)
  let out = ""
  let cursor = 0
  for (const range of protectedRanges) {
    if (range.start < cursor) continue
    out += withoutCommentsInText(html.slice(cursor, range.start))
    out += html.slice(range.start, range.end)
    cursor = range.end
  }
  return out + withoutCommentsInText(html.slice(cursor))
}

/** Is this opening tag a slide? It carries the stable `data-derive-slide` index, or `slide`
 *  as a WHOLE class token.
 *
 *  Whole token, not a substring: `\bslide\b` treats a hyphen as a word boundary, so
 *  `class="slide-inner"` matched — and real decks are full of `slide-inner`, `slide-chart`,
 *  `slide-kicker`. That made every such wrapper look like a slide nested inside its own
 *  slide, which inflated the count and made the slicer refuse the deck outright. Found by
 *  running this over real published decks rather than fixtures. */
export const isSlideAttrs = (attrs: string): boolean =>
  attrValues(attrs, "data-derive-slide").length > 0 ||
  classTokens(attrs).some((t) => t.toLowerCase() === "slide")

/** How many slide elements this HTML actually contains. */
export const countSlideElements = (html: string): number => {
  let n = 0
  for (const tag of tags(html))
    if (!tag.closing && SLIDE_TAGS.has(tag.name) && isSlideAttrs(tag.attrs)) n++
  return n
}

/** Does this page announce itself to the host over the deck protocol? Matches the bare
 *  protocol name so either quote style (source:'derive-deck' / "derive-deck") is found. */
export const speaksDeckProtocol = (html: string): boolean =>
  withoutComments(html).includes("derive-deck")

/** How many slide elements a page needs before it is read as a deck rather than a page that
 *  happens to mention the protocol. Two, because a deck has at least two slides. */
const DECK_MIN_SLIDES = 2

/** A deck: it announces itself AND has slides to announce. Both halves are required —
 *  the protocol name alone appears in any document about decks (this file included), and
 *  slides alone are just sections. */
export const isDeckDocument = (html: string): boolean => {
  if (!speaksDeckProtocol(html) || countSlideElements(html) < DECK_MIN_SLIDES) return false
  // Classification enables structural editing in the UI, so it must not advertise
  // a deck whose slide structure the organizer will immediately refuse. Keep this
  // predicate non-throwing because it also runs while sniffing arbitrary uploads.
  try {
    return sliceSlides(html).length >= DECK_MIN_SLIDES
  } catch {
    return false
  }
}

/** Slides built without the protocol: the page paginates itself and silently forfeits the
 *  deck bar, Present mode, and slide-pinned comments. Three, so an ordinary page with a
 *  couple of `.slide`-classed elements is never lectured. */
const ADVISE_MIN_SLIDES = 3

/** True when a page is plainly a deck attempt that never announced itself. */
export const isUnannouncedDeck = (html: string): boolean => {
  if (speaksDeckProtocol(html) || countSlideElements(html) < ADVISE_MIN_SLIDES) return false
  try {
    return sliceSlides(html).length >= ADVISE_MIN_SLIDES
  } catch {
    return false
  }
}

// ── Structural slide operations ────────────────────────────────────────────────
//
// Reordering a deck is the one edit the text pipelines provably cannot express.
// applyQuoteEdits refuses any span that crosses an element boundary (by design), and
// old_str/new_str can only do it by copying whole slides byte-for-byte through a model's
// output — thousands of tokens for an intent worth twenty, and brittle against a single
// whitespace difference. So the intent itself becomes the payload: move / delete /
// duplicate by position, materialized here against the real source.
//
// The contract this holds to, in order of importance:
//   1. Never lose content. Anything the scanner cannot account for refuses the WHOLE
//      batch with a reason — the quote-edit philosophy, for the same reason.
//   2. Identity is the `data-derive-slide` attribute and is never renumbered; document
//      order alone decides what plays first. A comment thread rides its slide's identity,
//      so a move must not disturb it.
//   3. Positions are 1-based, matching what the deck bar and the arrange grid show a
//      person. The protocol's own `i` is 0-based; that is a wire detail, not a UI one.

/** The tag names a slide element may use — the same set the sniffer counts. The slicer and
 *  the sniffer share `isSlideAttrs` above, so what gets counted and what gets sliced can
 *  never disagree about what a slide is. */
const SLIDE_TAGS = new Set(["section", "div", "article", "li"])

/** The `data-derive-slide` value on an opening tag, when it carries a numeric one. */
const idOf = (attrs: string): number | null => {
  const values = attrValues(attrs, "data-derive-slide")
  if (values.length > 1)
    throw new EditError(
      "A slide has more than one data-derive-slide attribute, so its identity is ambiguous. Edit the source directly.",
    )
  const raw = values[0]
  if (raw === undefined) return null
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new EditError(
      `Slide identity ${JSON.stringify(raw)} must be one whole, safely representable integer. Edit the source directly.`,
    )
  return Number(raw)
}

/** One slide element's exact span in the source. */
export interface SlideSpan {
  /** 1-based position in document order — what a person sees on the deck bar. */
  position: number
  /** Offset of the opening `<`. */
  start: number
  /** Offset just past the closing `>`. */
  end: number
  /** The stable `data-derive-slide` value, or null when the deck never stamped one. */
  id: number | null
}

/** Every slide element's byte span, in document order.
 *
 *  Document order, deliberately: a deck's own script reveals slides in DOM order, so
 *  that is what "slide 3" means to anyone watching. The `data-derive-slide` attribute is
 *  identity, and after the first reorder the two disagree — sorting by it here would put
 *  this slicer at odds with the page it is slicing.
 *
 *  Throws `EditError` rather than guessing when the structure is ambiguous: a slide that
 *  never closes, or one nested inside another. Returns [] for a page with no slides. */
export const sliceSlides = (html: string): SlideSpan[] => {
  const all = tags(html)
  const spans: SlideSpan[] = []
  for (let t = 0; t < all.length; t++) {
    const open = all[t] as HtmlTag
    if (open.closing || !SLIDE_TAGS.has(open.name) || !isSlideAttrs(open.attrs)) continue
    const end = elementEnd(all, t)
    if (end === -1)
      throw new EditError(
        `A slide element (<${open.name}> at character ${open.start}) is never closed — the deck's structure can't be read. Fix the markup, or edit the source directly.`,
      )
    spans.push({ position: 0, start: open.start, end, id: idOf(open.attrs) })
  }
  // A slide inside a slide has no single position, so no op on it could mean one thing.
  for (let i = 1; i < spans.length; i++)
    if ((spans[i] as SlideSpan).start < (spans[i - 1] as SlideSpan).end)
      throw new EditError(
        "This deck nests a slide element inside another one, so slides have no single order. Edit the source directly.",
      )
  return spans.map((s, i) => ({ ...s, position: i + 1 }))
}

/** A structural change to a deck, by 1-based position. */
export type SlideOp =
  | { op: "move"; from: number; to: number }
  | { op: "delete"; at: number }
  | { op: "duplicate"; at: number }
  | { op: "insert"; at: number }

/** Enough for any real rearranging session; a runaway loop is not an edit. */
export const MAX_SLIDE_OPS = 200

/** Give every slide a stable identity, minting only for the ones that lack it. Existing
 *  values are never touched: they are what comment threads are pinned to. */
const stamped = (texts: string[], ids: (number | null)[]): { text: string; id: number }[] => {
  let next = Math.max(-1, ...ids.filter((v): v is number => v !== null)) + 1
  return texts.map((text, i) => {
    const existing = ids[i]
    if (existing !== null && existing !== undefined) return { text, id: existing }
    const id = next++
    // Insert into the opening tag, just past the tag name.
    const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(text)
    return {
      text: m
        ? `${text.slice(0, m[0].length)} data-derive-slide="${id}"${text.slice(m[0].length)}`
        : text,
      id,
    }
  })
}

/** Re-stamp one slide's identity — for the copy a duplicate makes, which must not share
 *  its original's threads. */
const withId = (text: string, id: number): string => {
  if (/data-derive-slide\s*=/i.test(text))
    return text.replace(/data-derive-slide\s*=\s*["']?-?\d+["']?/i, `data-derive-slide="${id}"`)
  const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(text)
  return m
    ? `${text.slice(0, m[0].length)} data-derive-slide="${id}"${text.slice(m[0].length)}`
    : text
}

const inactiveClasses = (classes: string[]): string[] =>
  classes.filter((name) => !["on", "active", "is-active", "current"].includes(name.toLowerCase()))

const IDREF_LIST_ATTRS = new Set([
  "aria-controls",
  "aria-describedby",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
  "aria-labelledby",
  "aria-owns",
  "headers",
  "itemref",
])
const IDREF_ATTRS = new Set(["aria-activedescendant", "contextmenu", "for", "form", "list"])
const FRAGMENT_ATTRS = new Set(["href", "usemap", "xlink:href"])
const SVG_TIMING_ATTRS = new Set(["begin", "end"])

const cssUnescapeIdentifier = (value: string): string =>
  value.replace(
    /\\(?:([0-9a-f]{1,6})(?:\r\n|[ \n\r\t\f])?|(\r\n|[\n\r\f])|(.))/gis,
    (_whole, hex: string | undefined, newline: string | undefined, escaped: string | undefined) => {
      if (hex) {
        const cp = Number.parseInt(hex, 16)
        return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)
          ? "�"
          : String.fromCodePoint(cp)
      }
      return newline ? "" : (escaped ?? "")
    },
  )

const domIds = (html: string): string[] =>
  tags(html).flatMap((tag) => (tag.closing ? [] : attrValues(tag.attrs, "id")))

/** A duplicated slide is a new DOM subtree, so authored IDs inside it must also be
 *  new. Rewrite the IDREF attributes browsers and assistive technology resolve,
 *  plus fragment/url references used by SVG. Attribute spelling and quote style
 *  stay unchanged; only values that point at an ID from this slide move. */
const rewriteCopiedDomIds = (html: string, slideId: number, used: Set<string>): string => {
  const originals = domIds(html)
  if (new Set(originals).size !== originals.length)
    throw new EditError(
      "This slide repeats a DOM id inside itself, so duplicating it would leave ambiguous references. Give its elements unique ids first.",
    )
  const rewritten = new Map<string, string>()
  for (const original of originals) {
    let candidate = `${original}--derive-copy-${slideId}`
    let n = 2
    while (used.has(candidate)) candidate = `${original}--derive-copy-${slideId}-${n++}`
    rewritten.set(original, candidate)
    used.add(candidate)
  }
  if (!rewritten.size) return html

  const rewriteValue = (name: string, value: string): string => {
    const lower = name.toLowerCase()
    if (lower === "id") return rewritten.get(value) ?? value
    if (IDREF_ATTRS.has(lower)) return rewritten.get(value) ?? value
    if (IDREF_LIST_ATTRS.has(lower))
      return value.replace(/\S+/g, (token) => rewritten.get(token) ?? token)
    if (FRAGMENT_ATTRS.has(lower) && value.startsWith("#"))
      return `#${rewritten.get(value.slice(1)) ?? value.slice(1)}`
    if (SVG_TIMING_ATTRS.has(lower)) {
      let nextValue = value
      for (const [original, next] of rewritten) {
        const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        nextValue = nextValue.replace(
          new RegExp(`(^|;)(\\s*)${escaped}(?=\\.)`, "g"),
          (_whole, boundary: string, space: string) => `${boundary}${space}${next}`,
        )
      }
      return nextValue
    }
    return value.replace(
      /url\(\s*((?:["'])|(?:&(?:quot|apos|#(?:34|39)|#x(?:22|27));))?#([^\s)"']+?)\1\s*\)/gi,
      (whole, _quote, ref: string) => {
        const decoded = cssUnescapeIdentifier(ref)
        const next = rewritten.get(decoded)
        const encoded = next?.startsWith(decoded) ? ref + next.slice(decoded.length) : next
        return encoded ? whole.replace(`#${ref}`, `#${encoded}`) : whole
      },
    )
  }

  const attr = /([^\s"'<>/=]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  let out = ""
  let cursor = 0
  for (const tag of tags(html)) {
    if (tag.closing) continue
    out += html.slice(cursor, tag.start)
    const raw = html
      .slice(tag.start, tag.end)
      .replace(
        attr,
        (whole, name: string, equals: string, double: string, single: string, bare: string) => {
          const value = double ?? single ?? bare ?? ""
          const next = rewriteValue(name, value)
          if (next === value) return whole
          if (double !== undefined) return `${name}${equals}"${next}"`
          if (single !== undefined) return `${name}${equals}'${next}'`
          return `${name}${equals}${next}`
        },
      )
    out += raw
    cursor = tag.end
  }
  return out + html.slice(cursor)
}

/** A newly-created slide is never the live one merely because its source was. Deck
 *  runtimes commonly persist `on`/`active` on the first slide in authored source; copying
 *  that state would paint two slides at once after reload. Only the OUTER slide's class
 *  list is touched, and content/style classes remain byte-for-byte. */
const inactiveCopy = (text: string, id: number, usedDomIds: Set<string>): string => {
  const copied = rewriteCopiedDomIds(withId(text, id), id, usedDomIds)
  const open = tags(copied).find((tag) => !tag.closing && SLIDE_TAGS.has(tag.name))
  if (!open) return copied
  const opening = copied
    .slice(open.start, open.end)
    .replace(/class\s*=\s*(["'])(.*?)\1/i, (_all, quote: string, value: string) => {
      const classes = inactiveClasses(value.split(/\s+/).filter(Boolean))
      return `class=${quote}${classes.join(" ")}${quote}`
    })
  return copied.slice(0, open.start) + opening + copied.slice(open.end)
}

const escapeAttr = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")

/** A blank slide inherits only visual/layout attributes. Content identity (`id`), ARIA
 *  references, and arbitrary data hooks are unique to the source slide and would become
 *  broken duplicates if copied onto a new one. */
const blankOpening = (open: HtmlTag, id: number): string => {
  const classes = inactiveClasses(classTokens(open.attrs))
  const style = attrValue(open.attrs, "style")
  const role = attrValue(open.attrs, "role")
  return `<${open.name} data-derive-slide="${id}"${
    classes.length ? ` class="${escapeAttr(classes.join(" "))}"` : ""
  }${style ? ` style="${escapeAttr(style)}"` : ""}${role ? ` role="${escapeAttr(role)}"` : ""}>`
}

/** Make a deliberately small blank slide in the deck's own outer shell. Keeping the
 *  source slide's tag + attributes preserves arbitrary deck layout conventions (a deck
 *  may use `li.slide`, an inline style, or its own data attributes), while the fresh
 *  identity keeps comment threads distinct. The interior is intentionally plain HTML:
 *  it is useful immediately and can be changed with the rendered editor. */
const blankFrom = (text: string, id: number): string => {
  const all = tags(text)
  const open = all.find((tag) => !tag.closing && SLIDE_TAGS.has(tag.name))
  if (!open) throw new EditError("The slide used as a template has no readable opening tag.")
  const close = [...all].reverse().find((tag) => tag.closing && tag.name === open.name)
  const opening = blankOpening(open, id)
  const closing = close ? text.slice(close.start, close.end) : `</${open.name}>`
  return `${opening}\n  <h2>New slide</h2>\n  <p>Add content in Edit mode.</p>\n${closing}`
}

/**
 * Apply structural ops to a deck's source and return the new source.
 *
 * Ops are applied in order, each seeing the previous one's result — the same semantics
 * `old_str` edits already have, so "move 5 to 2, then delete 7" means what it reads like.
 * Nothing is applied unless everything validates: a bad position, an ambiguous structure,
 * or real content between slides refuses the whole batch.
 */
export const applySlideOps = (html: string, ops: SlideOp[]): string => {
  if (!Array.isArray(ops) || ops.length === 0)
    throw new EditError("`slide_ops` is empty — provide at least one op.")
  if (ops.length > MAX_SLIDE_OPS)
    throw new EditError(
      `\`slide_ops\` has ${ops.length} entries — the maximum per request is ${MAX_SLIDE_OPS}.`,
    )
  const spans = sliceSlides(html)
  if (spans.length === 0)
    throw new EditError(
      'This document has no slide elements, so there is nothing to arrange. A deck\'s slides are elements carrying class="slide" or data-derive-slide.',
    )

  // Whatever sits BETWEEN slides travels with neither of them, so reordering would
  // silently relocate it. Whitespace is safe to normalize; anything else is content,
  // and losing content is the one outcome worth refusing an edit over.
  const first = spans[0] as SlideSpan
  const last = spans[spans.length - 1] as SlideSpan
  const gaps: string[] = []
  for (let i = 1; i < spans.length; i++) {
    const gap = html.slice((spans[i - 1] as SlideSpan).end, (spans[i] as SlideSpan).start)
    if (gap.trim())
      throw new EditError(
        `There is content between slides ${i} and ${i + 1} that belongs to neither, so reordering would move it somewhere it doesn't belong. Edit the source directly.`,
      )
    gaps.push(gap)
  }

  const ids = spans.map((s) => s.id)
  const known = ids.filter((v): v is number => v !== null)
  if (new Set(known).size !== known.length)
    throw new EditError(
      "Two slides share the same data-derive-slide value, so their comment threads can't be told apart. Give each slide a distinct value first.",
    )

  // Identity first: a class-only deck (or one an agent extended by hand) gets stamped on
  // its first arrange, so every later session — and every comment left in between — has
  // something stable to hold onto.
  const items = stamped(
    spans.map((s) => html.slice(s.start, s.end)),
    ids,
  )
  let nextId = Math.max(-1, ...items.map((item) => item.id)) + 1
  const authoredDomIds = domIds(html)
  if (new Set(authoredDomIds).size !== authoredDomIds.length)
    throw new EditError(
      "This deck repeats a DOM id, so its document-wide references are already ambiguous. Give every element a unique id before arranging slides.",
    )
  const usedDomIds = new Set(authoredDomIds)

  const at = (n: unknown, label: string, max: number): number => {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max)
      throw new EditError(
        `slide_ops: ${label} ${JSON.stringify(n)} is out of range — this deck has ${max} slide${max === 1 ? "" : "s"} (positions are 1-based).`,
      )
    return n
  }

  for (const raw of ops) {
    const op = raw as SlideOp
    if (op?.op === "move") {
      const from = at(op.from, "from", items.length)
      const to = at(op.to, "to", items.length)
      if (from === to) continue
      const [moved] = items.splice(from - 1, 1)
      if (moved) items.splice(to - 1, 0, moved)
    } else if (op?.op === "delete") {
      const pos = at(op.at, "at", items.length)
      if (items.length === 1)
        throw new EditError(
          "That would delete the deck's only slide. Delete the artifact instead, or leave one slide standing.",
        )
      items.splice(pos - 1, 1)
    } else if (op?.op === "duplicate") {
      const pos = at(op.at, "at", items.length)
      const src = items[pos - 1] as { text: string; id: number | null }
      // The copy is a NEW slide: it must not inherit the original's identity, or every
      // thread pinned to the original would claim both.
      items.splice(pos, 0, { text: inactiveCopy(src.text, nextId, usedDomIds), id: nextId })
      nextId++
    } else if (op?.op === "insert") {
      // `at` is the position the new slide will occupy, so unlike the other ops it may
      // be one past the current end. Use the nearest existing slide as the visual shell.
      const pos = at(op.at, "at", items.length + 1)
      const templateAt = Math.min(Math.max(pos - 1, 0), items.length - 1)
      const src = items[templateAt] as { text: string; id: number | null }
      items.splice(pos - 1, 0, { text: blankFrom(src.text, nextId), id: nextId })
      nextId++
    } else {
      throw new EditError(
        `slide_ops: unknown op ${JSON.stringify((op as { op?: unknown })?.op)} — use "move", "delete", "duplicate", or "insert".`,
      )
    }
  }

  // Rebuild around the slide region. Gaps between slides are whitespace by the guard
  // above, so one canonical separator (the deck's own first gap) keeps the source tidy
  // whether the count grew, shrank, or stayed put.
  const sep = gaps[0] ?? "\n"
  return html.slice(0, first.start) + items.map((s) => s.text).join(sep) + html.slice(last.end)
}
