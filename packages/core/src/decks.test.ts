import { describe, expect, it } from "vitest"
import { DECK_TEMPLATE } from "./deck-template.gen"
import { countSlideElements, isDeckDocument, isUnannouncedDeck, speaksDeckProtocol } from "./decks"

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
