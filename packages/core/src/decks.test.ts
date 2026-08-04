import { describe, expect, it } from "vitest"
import { DECK_TEMPLATE } from "./deck-template.gen"
import {
  applySlideOps,
  countSlideElements,
  isDeckDocument,
  isUnannouncedDeck,
  MAX_SLIDE_OPS,
  sliceSlides,
  speaksDeckProtocol,
} from "./decks"

/** A minimal real deck: the protocol plus slides that carry the stable index. */
const deck = (n = 3) =>
  `<!doctype html><html><head><title>d</title></head><body>${Array.from(
    { length: n },
    (_, i) => `<section class="slide" data-derive-slide="${i}"><h2>${i}</h2></section>`,
  ).join(
    "",
  )}<script>parent.postMessage({source:"derive-deck",type:"state",i:0,total:${n}},"*")</script></body></html>`

/** The same slides with the announce removed — what an agent builds without the skill. */
const silentDeck = (n = 3) =>
  `<!doctype html><html><body>${Array.from(
    { length: n },
    (_, i) => `<section class="slide" data-derive-slide="${i}"><h2>${i}</h2></section>`,
  ).join("")}</body></html>`

describe("deck detection", () => {
  it("types a real deck as a deck", () => {
    expect(isDeckDocument(deck())).toBe(true)
    expect(countSlideElements(deck(7))).toBe(7)
  })

  it("ships a canonical template that is itself a deck", () => {
    // The starter every surface hands over. If this ever fails, the thing we tell people
    // to copy would publish as an ordinary page.
    expect(isDeckDocument(DECK_TEMPLATE)).toBe(true)
    expect(countSlideElements(DECK_TEMPLATE)).toBeGreaterThanOrEqual(2)
  })

  it("centres the stage out of flow, so a short viewport can't clip it (regression)", () => {
    // Found by opening the starter in a 633px-tall window: a transform does NOT shrink an
    // element's layout box, so the 720px stage still occupied 720px, overflowed, and got
    // clipped by `overflow: hidden` at the bottom. Grid-centring looked correct at 800px
    // and wrong on any laptop with a browser bar. Both halves of the fix are asserted
    // because either one alone re-opens the bug.
    expect(DECK_TEMPLATE).toContain("position: fixed")
    expect(DECK_TEMPLATE).toContain("translate(-50%, -50%) scale(")
  })

  // The reason detection needs BOTH halves. Every one of these mentions the protocol.
  it("does not call a document ABOUT decks a deck", () => {
    const doc =
      "<!doctype html><html><body><h1>How decks work</h1>" +
      "<p>Post <code>source:'derive-deck'</code> on every change, and give each slide a " +
      '<code>&lt;section class="slide" data-derive-slide="N"&gt;</code> wrapper.</p></body></html>'
    expect(speaksDeckProtocol(doc)).toBe(true) // it does say the word
    expect(countSlideElements(doc)).toBe(0) // but the samples are escaped, not markup
    expect(isDeckDocument(doc)).toBe(false)
  })

  it("ignores slide markup that only appears inside an HTML comment", () => {
    // This repo's own annotated starter describes a slide element in its header comment,
    // and a commented-out slide is not a slide.
    const commented =
      '<!doctype html><html><body><!-- each slide is a <section class="slide" ' +
      'data-derive-slide="N"> --><p>nothing here yet</p></body></html>'
    expect(countSlideElements(commented)).toBe(0)
    expect(isDeckDocument(commented)).toBe(false)
  })

  it("treats an UNTERMINATED comment as swallowing the rest of the document", () => {
    // What a browser does, and what the obvious `replace(/<!--[\s\S]*?-->/g, "")` did NOT:
    // with no closing marker the regex matched nothing, leaving markup a reader can never
    // see to be counted as slides.
    const cut = '<!-- todo <section class="slide">a</section><section class="slide">b</section>'
    expect(countSlideElements(cut)).toBe(0)
  })

  it("stays linear on hostile comment input (ReDoS guard)", () => {
    // A page of unclosed comment openers is the polynomial case for the lazy-body regex:
    // every `<!--` restarts a scan to end of string. This runs on every publish, over
    // content we don't control, so it has to be O(n).
    const hostile = `${"<!--".repeat(60_000)}x`
    const started = performance.now()
    expect(countSlideElements(hostile)).toBe(0)
    expect(speaksDeckProtocol(hostile)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it("needs more than one slide — the protocol name plus a single section is not a deck", () => {
    const one =
      '<div class="slide">only one</div><script>postMessage({source:"derive-deck"})</script>'
    expect(isDeckDocument(one)).toBe(false)
  })

  it("counts slides on any container tag, by class or by index attribute", () => {
    expect(countSlideElements('<div class="slide"></div><div class="slide x"></div>')).toBe(2)
    expect(countSlideElements("<article data-derive-slide='0'></article>")).toBe(1)
    // A class that merely CONTAINS "slide" as a word boundary miss must not count.
    expect(countSlideElements('<div class="slideshow"></div>')).toBe(0)
  })

  it("counts `slide` as a whole class token, never a hyphenated relative", () => {
    // Found on real published decks: `\bslide\b` treats a hyphen as a word boundary, so
    // every slide-inner / slide-chart / slide-kicker wrapper counted as its own slide.
    // That inflated the count AND made each one look like a slide nested in a slide.
    const inner =
      '<section class="slide"><div class="slide-inner"><div class="slide-chart"></div>' +
      '<p class="slide-kicker">k</p></div></section>'
    expect(countSlideElements(inner)).toBe(1)
    expect(countSlideElements('<div class="kpi-row kpi-row-slide"></div>')).toBe(0)
    // …but `slide` alongside other classes is still a slide.
    expect(countSlideElements('<section class="slide slide-title-card"></section>')).toBe(1)
    expect(countSlideElements('<section class="on slide "></section>')).toBe(1)
  })
})

describe("unannounced decks", () => {
  it("flags slides built without the protocol", () => {
    expect(isUnannouncedDeck(silentDeck(3))).toBe(true)
    expect(isUnannouncedDeck(silentDeck(12))).toBe(true)
  })

  it("stays quiet once the page announces itself", () => {
    expect(isUnannouncedDeck(deck(3))).toBe(false)
    expect(isUnannouncedDeck(DECK_TEMPLATE)).toBe(false)
  })

  it("stays quiet on an ordinary page that happens to use a slide class twice", () => {
    // A carousel, a hero, a stray utility class: two is not a deck attempt.
    expect(isUnannouncedDeck('<div class="slide"></div><div class="slide"></div>')).toBe(false)
  })
})

/** Slides separated by real whitespace, the way an authored deck actually reads. */
const spaced = (slides: string[]) =>
  `<!doctype html><html><body>\n  ${slides.join("\n  ")}\n<script>parent.postMessage({source:"derive-deck",type:"state",i:0,total:${slides.length}},"*")</script></body></html>`

const sl = (id: number | null, body: string) =>
  id === null
    ? `<section class="slide"><h2>${body}</h2></section>`
    : `<section class="slide" data-derive-slide="${id}"><h2>${body}</h2></section>`

/** The visible order of a deck's slides, by their heading text. */
const order = (html: string) =>
  sliceSlides(html).map((s) => /<h2>([^<]*)</.exec(html.slice(s.start, s.end))?.[1])

/** Each slide's stable identity, in document order. */
const idsOf = (html: string) => sliceSlides(html).map((s) => s.id)

describe("sliceSlides", () => {
  it("returns each slide's exact span, in DOCUMENT order", () => {
    const html = spaced([sl(0, "a"), sl(1, "b"), sl(2, "c")])
    const spans = sliceSlides(html)
    expect(spans.map((s) => s.position)).toEqual([1, 2, 3])
    expect(spans.map((s) => html.slice(s.start, s.end))).toEqual([
      sl(0, "a"),
      sl(1, "b"),
      sl(2, "c"),
    ])
  })

  it("orders by the DOM, not by the identity attribute", () => {
    // After one reorder these disagree. Document order is what the deck's own script
    // reveals, so it is what "slide 2" means to anyone watching.
    const html = spaced([sl(2, "third"), sl(0, "first"), sl(1, "second")])
    expect(order(html)).toEqual(["third", "first", "second"])
    expect(idsOf(html)).toEqual([2, 0, 1])
  })

  it("ignores slides that only exist inside a comment", () => {
    const html = spaced([sl(0, "a"), sl(1, "b")]).replace(
      "<body>",
      `<body><!-- ${sl(9, "ghost")} -->`,
    )
    expect(order(html)).toEqual(["a", "b"])
  })

  it("is not fooled by markup inside a script", () => {
    // A close tag in a JS string is text, not structure — counting it would end a slide early.
    const html = spaced([
      `<section class="slide" data-derive-slide="0"><h2>a</h2><script>const t = "</section>"</script></section>`,
      sl(1, "b"),
    ])
    expect(order(html)).toEqual(["a", "b"])
  })

  it("handles a `>` inside an attribute value", () => {
    const html = spaced([
      `<section class="slide" data-derive-slide="0" title="a > b"><h2>a</h2></section>`,
      sl(1, "b"),
    ])
    expect(order(html)).toEqual(["a", "b"])
  })

  it("counts nested non-slide elements of the same tag correctly", () => {
    const html = spaced([
      `<section class="slide" data-derive-slide="0"><section><h2>a</h2></section></section>`,
      sl(1, "b"),
    ])
    expect(order(html)).toEqual(["a", "b"])
  })

  it("slices a real-world deck whose slides contain slide-* wrappers", () => {
    // The shape that broke this on a real 165KB deck: every slide wraps a `slide-inner`,
    // which used to read as a slide nested inside a slide and refused the whole document.
    const html = spaced([
      '<section class="slide" data-derive-slide="0"><div class="slide-inner"><h2>a</h2><div class="slide-chart"></div></div></section>',
      '<section class="slide" data-derive-slide="1"><div class="slide-inner"><h2>b</h2></div></section>',
    ])
    expect(order(html)).toEqual(["a", "b"])
    expect(applySlideOps(html, [{ op: "move", from: 2, to: 1 }])).toContain("slide-inner")
    expect(order(applySlideOps(html, [{ op: "move", from: 2, to: 1 }]))).toEqual(["b", "a"])
  })

  it("refuses a deck that nests one slide inside another", () => {
    const html = spaced([
      `<section class="slide"><section class="slide"><h2>a</h2></section></section>`,
    ])
    expect(() => sliceSlides(html)).toThrow(/nests a slide/i)
  })

  it("refuses a slide that never closes", () => {
    expect(() => sliceSlides(`<body><section class="slide"><h2>a</h2></body>`)).toThrow(
      /never closed/i,
    )
  })

  it("returns nothing for a page with no slides", () => {
    expect(sliceSlides("<html><body><p>hi</p></body></html>")).toEqual([])
  })
})

describe("applySlideOps", () => {
  const three = () => spaced([sl(0, "a"), sl(1, "b"), sl(2, "c")])

  it("moves a slide and NEVER renumbers identities", () => {
    // The whole comment-safety argument rests on this: threads ride the attribute.
    const out = applySlideOps(three(), [{ op: "move", from: 3, to: 1 }])
    expect(order(out)).toEqual(["c", "a", "b"])
    expect(idsOf(out)).toEqual([2, 0, 1])
  })

  it("moves forward as well as back", () => {
    expect(order(applySlideOps(three(), [{ op: "move", from: 1, to: 3 }]))).toEqual(["b", "c", "a"])
  })

  it("deletes by position", () => {
    const out = applySlideOps(three(), [{ op: "delete", at: 2 }])
    expect(order(out)).toEqual(["a", "c"])
    expect(idsOf(out)).toEqual([0, 2])
  })

  it("duplicates after the original with a FRESH identity", () => {
    // A copy sharing its original's id would make every thread claim both slides.
    const out = applySlideOps(three(), [{ op: "duplicate", at: 1 }])
    expect(order(out)).toEqual(["a", "a", "b", "c"])
    expect(idsOf(out)).toEqual([0, 3, 1, 2])
  })

  it("applies ops in order, each seeing the last one's result", () => {
    const out = applySlideOps(three(), [
      { op: "move", from: 3, to: 1 },
      { op: "delete", at: 2 },
    ])
    expect(order(out)).toEqual(["c", "b"])
  })

  it("keeps the document around the slides byte-for-byte", () => {
    const src = three()
    const out = applySlideOps(src, [{ op: "move", from: 1, to: 2 }])
    expect(out.startsWith("<!doctype html><html><body>\n  ")).toBe(true)
    expect(out.endsWith("</body></html>")).toBe(true)
    expect(isDeckDocument(out)).toBe(true)
    expect(countSlideElements(out)).toBe(countSlideElements(src))
  })

  it("stamps identities onto a class-only deck on its first arrange", () => {
    const html = spaced([sl(null, "a"), sl(null, "b"), sl(null, "c")])
    expect(idsOf(html)).toEqual([null, null, null])
    const out = applySlideOps(html, [{ op: "move", from: 1, to: 2 }])
    expect(order(out)).toEqual(["b", "a", "c"])
    expect(idsOf(out)).toEqual([1, 0, 2])
  })

  it("mints identities only for the slides that lack one", () => {
    const html = spaced([sl(4, "a"), sl(null, "b")])
    const out = applySlideOps(html, [{ op: "move", from: 2, to: 1 }])
    expect(idsOf(out)).toEqual([5, 4])
  })

  it("refuses content sitting between two slides", () => {
    // It belongs to neither slide, so a reorder would move it somewhere it doesn't belong.
    const withOrphan = spaced([sl(0, "a"), "<p>orphan</p>", sl(1, "b")])
    expect(() => applySlideOps(withOrphan, [{ op: "move", from: 1, to: 2 }])).toThrow(
      /between slides/i,
    )
  })

  it("refuses two slides that share an identity", () => {
    const html = spaced([sl(0, "a"), sl(0, "b")])
    expect(() => applySlideOps(html, [{ op: "move", from: 1, to: 2 }])).toThrow(
      /same data-derive-slide/i,
    )
  })

  it("refuses an out-of-range position and applies NOTHING", () => {
    expect(() => applySlideOps(three(), [{ op: "move", from: 9, to: 1 }])).toThrow(/out of range/i)
    expect(() => applySlideOps(three(), [{ op: "delete", at: 0 }])).toThrow(/out of range/i)
  })

  it("refuses to delete the last slide standing", () => {
    const html = spaced([sl(0, "a")])
    expect(() => applySlideOps(html, [{ op: "delete", at: 1 }])).toThrow(/only slide/i)
  })

  it("refuses an unknown op, an empty batch, and an oversized one", () => {
    expect(() => applySlideOps(three(), [{ op: "shuffle" } as never])).toThrow(/unknown op/i)
    expect(() => applySlideOps(three(), [])).toThrow(/empty/i)
    expect(() =>
      applySlideOps(
        three(),
        Array.from({ length: MAX_SLIDE_OPS + 1 }, () => ({ op: "move", from: 1, to: 2 }) as const),
      ),
    ).toThrow(/maximum per request/i)
  })

  it("refuses a document with no slides at all", () => {
    expect(() =>
      applySlideOps("<html><body><p>hi</p></body></html>", [{ op: "delete", at: 1 }]),
    ).toThrow(/no slide elements/i)
  })

  it("rearranges the canonical template and leaves it a deck", () => {
    // The starter every surface hands over is the deck most likely to be arranged first.
    const out = applySlideOps(DECK_TEMPLATE, [{ op: "move", from: 3, to: 1 }])
    expect(isDeckDocument(out)).toBe(true)
    expect(countSlideElements(out)).toBe(countSlideElements(DECK_TEMPLATE))
    expect(idsOf(out)).toEqual([2, 0, 1])
  })
})
