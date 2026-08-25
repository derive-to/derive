// What Derive knows about slide decks. A deck is not a separate artifact kind — it is a
// single-file HTML page that speaks the `derive-deck` protocol (artifact authoring standard §3), which is
// what turns on the host's deck bar, Present mode, and slide-pinned comments. Both places
// that care — the content-type sniff in publish.ts and the "you built slides but never
// announced them" advisory — resolve it through the ONE pair of predicates here, so what
// gets typed and what gets advised can never disagree.
//
// The authoring guide is derive://skills/decks; the starter is deck-template.html.

import { EditError } from "./doc-text"
import { attrValues, classTokens, elementEnd, type HtmlTag, tags } from "./html-tags"

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
const withoutComments = (html: string): string => {
  let out = ""
  let i = 0
  for (;;) {
    const start = html.indexOf("<!--", i)
    if (start === -1) return out + html.slice(i)
    out += html.slice(i, start)
    const end = html.indexOf("-->", start + 4)
    if (end === -1) return out // unterminated: the rest of the document is inside it
    i = end + 3
  }
}

/** A container tag that MIGHT be a slide — the cheap linear scan; `isSlideAttrs` decides. */
const SLIDE_CANDIDATE = /<(?:section|div|article|li)\b([^>]*)>/gi

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
  const src = withoutComments(html)
  let n = 0
  for (const m of src.matchAll(SLIDE_CANDIDATE)) if (isSlideAttrs(m[1] ?? "")) n++
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
export const isDeckDocument = (html: string): boolean =>
  speaksDeckProtocol(html) && countSlideElements(html) >= DECK_MIN_SLIDES

/** Slides built without the protocol: the page paginates itself and silently forfeits the
 *  deck bar, Present mode, and slide-pinned comments. Three, so an ordinary page with a
 *  couple of `.slide`-classed elements is never lectured. */
const ADVISE_MIN_SLIDES = 3

/** True when a page is plainly a deck attempt that never announced itself. */
export const isUnannouncedDeck = (html: string): boolean =>
  !speaksDeckProtocol(html) && countSlideElements(html) >= ADVISE_MIN_SLIDES

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
      items.splice(pos, 0, { text: withId(src.text, nextId), id: nextId })
      nextId++
    } else {
      throw new EditError(
        `slide_ops: unknown op ${JSON.stringify((op as { op?: unknown })?.op)} — use "move", "delete", or "duplicate".`,
      )
    }
  }

  // Rebuild around the slide region. Gaps between slides are whitespace by the guard
  // above, so one canonical separator (the deck's own first gap) keeps the source tidy
  // whether the count grew, shrank, or stayed put.
  const sep = gaps[0] ?? "\n"
  return html.slice(0, first.start) + items.map((s) => s.text).join(sep) + html.slice(last.end)
}
