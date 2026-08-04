// What Derive knows about slide decks. A deck is not a separate artifact kind — it is a
// single-file HTML page that speaks the `derive-deck` protocol (STANDARD.md §3), which is
// what turns on the host's deck bar, Present mode, and slide-pinned comments. Both places
// that care — the content-type sniff in publish.ts and the "you built slides but never
// announced them" advisory — resolve it through the ONE pair of predicates here, so what
// gets typed and what gets advised can never disagree.
//
// The authoring guide is derive://skills/decks; the starter is deck-template.html.

import { EditError } from "./doc-text"

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

/** A real slide element opening — a container tag carrying `class="…slide…"` or the stable
 *  `data-derive-slide` index. Deliberately requires a live tag, so an escaped code sample
 *  (`&lt;section class="slide"&gt;`) on a page documenting the pattern doesn't count. */
const SLIDE_ELEMENT =
  /<(?:section|div|article|li)\b[^>]*(?:class\s*=\s*["'][^"']*\bslide\b|data-derive-slide\s*=)/gi

/** How many slide elements this HTML actually contains. */
export const countSlideElements = (html: string): number =>
  (withoutComments(html).match(SLIDE_ELEMENT) ?? []).length

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

/** The tag names a slide element may use — the same set the sniffer counts. */
const SLIDE_TAGS = new Set(["section", "div", "article", "li"])

/** Does this opening tag's attribute text mark it as a slide? Mirrors SLIDE_ELEMENT. */
const isSlideAttrs = (attrs: string): boolean =>
  /class\s*=\s*["'][^"']*\bslide\b/i.test(attrs) || /data-derive-slide\s*=/i.test(attrs)

/** The `data-derive-slide` value on an opening tag, when it carries a numeric one. */
const idOf = (attrs: string): number | null => {
  const m = attrs.match(/data-derive-slide\s*=\s*["']?(-?\d+)/i)
  if (!m?.[1]) return null
  const n = Number(m[1])
  return Number.isInteger(n) ? n : null
}

interface Tag {
  name: string
  closing: boolean
  selfClosing: boolean
  attrs: string
  start: number
  /** Offset just past the tag's `>`. */
  end: number
}

/** Walk the document's real tags, skipping what a browser would not read as markup:
 *  comment bodies, and the raw-text bodies of <script>/<style> (where a `</section>`
 *  inside a string or a template literal is text, not a close tag). Everything
 *  structural here is decided from this one pass, so the sniffer's view of the page and
 *  the slicer's can't diverge. */
const tags = (html: string): Tag[] => {
  const out: Tag[] = []
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf("<", i)
    if (lt === -1) break
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4)
      if (close === -1) break // unterminated: a browser comments out the rest
      i = close + 3
      continue
    }
    const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 64))
    if (!m?.[1]) {
      i = lt + 1
      continue
    }
    // Find this tag's `>`, honoring quoted attribute values so a `>` inside one
    // (title="a > b") doesn't end the tag early.
    let j = lt + 1 + (m[0].length - 1)
    let quote = ""
    for (; j < html.length; j++) {
      const ch = html[j] as string
      if (quote) {
        if (ch === quote) quote = ""
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === ">") break
    }
    if (j >= html.length) break // unterminated tag: nothing structural left to trust
    const name = m[1].toLowerCase()
    const closing = m[0][1] === "/"
    const attrs = html.slice(lt + m[0].length, j)
    out.push({
      name,
      closing,
      selfClosing: attrs.trimEnd().endsWith("/"),
      attrs,
      start: lt,
      end: j + 1,
    })
    i = j + 1
    // Raw-text elements: their content is text, so skip straight past the close tag.
    if (!closing && (name === "script" || name === "style")) {
      const close = new RegExp(`</${name}\\b`, "i").exec(html.slice(i))
      if (!close) break
      i += close.index
    }
  }
  return out
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
    const open = all[t] as Tag
    if (open.closing || !SLIDE_TAGS.has(open.name) || !isSlideAttrs(open.attrs)) continue
    if (open.selfClosing) {
      spans.push({ position: 0, start: open.start, end: open.end, id: idOf(open.attrs) })
      continue
    }
    // Walk to this element's own close tag, counting same-name nesting on the way.
    let depth = 1
    let end = -1
    for (let k = t + 1; k < all.length; k++) {
      const tag = all[k] as Tag
      if (tag.name !== open.name || tag.selfClosing) continue
      depth += tag.closing ? -1 : 1
      if (depth === 0) {
        end = tag.end
        break
      }
    }
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
const stamped = (texts: string[], ids: (number | null)[]): string[] => {
  let next = Math.max(-1, ...ids.filter((v): v is number => v !== null)) + 1
  return texts.map((text, i) => {
    if (ids[i] !== null) return text
    const id = next++
    // Insert into the opening tag, just past the tag name.
    const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(text)
    return m
      ? `${text.slice(0, m[0].length)} data-derive-slide="${id}"${text.slice(m[0].length)}`
      : text
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
  ).map((text, i) => ({ text, id: ids[i] }))
  let nextId = Math.max(-1, ...known) + 1

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
