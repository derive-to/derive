import type { Page } from "@playwright/test"
import { expect, openArtifact, publishArtifact, test } from "./fixtures"

/**
 * Decks: the presentation bar, present mode, and typing in a slide.
 *
 * The fixture below is deliberately a deck that says NOTHING about itself — no
 * `derive-deck` protocol, just switched slides and its own keyboard, which is what
 * most decks in the library actually are. So this file covers the two things that
 * only exist because of that: the viewer recognising a deck from its markup, and
 * the editor taking the keyboard away from the deck while someone types in it.
 */
const DECK = `<!doctype html><html><head><meta charset="utf-8"><title>Deck</title>
<style>.slide{position:absolute;inset:0;opacity:0}.slide.on{opacity:1}</style></head><body>
<section class="slide on" data-derive-slide="0"><h1 id="s1">First slide</h1></section>
<section class="slide" data-derive-slide="1"><h1 id="s2">Second slide</h1></section>
<section class="slide" data-derive-slide="2"><h1 id="s3">Third slide</h1></section>
<script>
  var slides = [].slice.call(document.querySelectorAll('.slide')), i = 0
  function show(n){ i = Math.max(0, Math.min(slides.length-1, n));
    slides.forEach(function(s,k){ s.classList.toggle('on', k===i) }) }
  addEventListener('keydown', function(e){
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); show(i+1) }
    else if (e.key === 'ArrowLeft') { show(i-1) }
  })
</script></body></html>`

const doc = (page: Page) => page.frameLocator("iframe[title]")

async function seedDeck(page: Page) {
  const shortId = await publishArtifact(page, "deck.html", DECK, "text/html")
  await openArtifact(page, shortId)
  await expect(page.getByTestId("deck-bar")).toBeVisible()
  return shortId
}

test("a deck that never announced itself still gets the bar, and the bar drives it", async ({
  owner,
}) => {
  await seedDeck(owner)
  await expect(owner.getByTestId("deck-position")).toHaveText("1 / 3")

  // Driving a sniffed deck goes through its OWN handler (a synthesized key), so the
  // page and the bar can't disagree about where it is.
  await owner.getByTestId("deck-next").click()
  await expect(owner.getByTestId("deck-position")).toHaveText("2 / 3")
  await expect(doc(owner).locator("#s2")).toBeVisible()

  await owner.getByTestId("deck-prev").click()
  await expect(owner.getByTestId("deck-position")).toHaveText("1 / 3")
})

test("typing in a slide types — the deck's own keys stay out of it", async ({ owner }) => {
  const shortId = await seedDeck(owner)
  await owner.getByTestId("deck-next").click()
  await expect(owner.getByTestId("deck-position")).toHaveText("2 / 3")

  // Edit the slide on screen. `force` because Playwright's actionability check sees
  // the NEXT slide stacked on top of this one (a deck hides slides with opacity,
  // which leaves them hit-testable) and refuses to click. A real click lands fine:
  // the client peels those overlays before it resolves what the pointer is over,
  // which is the whole reason editing a deck works at all.
  await doc(owner).locator("#s2").dblclick({ force: true })
  await expect(owner.getByTestId("inline-edit-bar")).toBeVisible()
  await owner.keyboard.press("End")
  // A space is the tell: this deck binds Space to "next slide".
  await owner.keyboard.type(" and a half")

  await expect(owner.getByTestId("deck-position")).toHaveText("2 / 3")
  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()

  const res = await owner.request.get(`/v1/artifacts/${shortId}/content`)
  const src = await res.text()
  expect(src).toContain("Second slide and a half")
  expect(src).toContain("Third slide")
})

test("present mode covers the screen and leaves on Escape", async ({ owner }) => {
  await seedDeck(owner)
  await owner.getByTestId("deck-fullscreen").click()
  // The exit is stated, because a full-screen page with no visible way out is a trap.
  await expect(owner.getByTestId("deck-bar")).toContainText("Esc to exit")
  await owner.keyboard.press("Escape")
  await expect(owner.getByTestId("deck-bar")).not.toContainText("Esc to exit")
})
