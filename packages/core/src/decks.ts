// What Derive knows about slide decks. A deck is not a separate artifact kind — it is a
// single-file HTML page that speaks the `derive-deck` protocol (STANDARD.md §3), which is
// what turns on the host's deck bar, Present mode, and slide-pinned comments. Both places
// that care — the content-type sniff in publish.ts and the "you built slides but never
// announced them" advisory — resolve it through the ONE pair of predicates here, so what
// gets typed and what gets advised can never disagree.
//
// The authoring guide is derive://skills/decks; the starter is deck-template.html.

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
