import type { Page } from "@playwright/test"
import { DECK_TEMPLATE } from "../src/lib/deck-template.gen"
import { expect, openArtifact, publishArtifact, test } from "./fixtures"

/**
 * Decks: the host half of the derive-deck protocol, end to end.
 *
 * Its own file rather than a line in the smoke gate, per the e2e README — this is one
 * surface in depth, and it is the surface with the widest gap between "covered by unit
 * tests" and "actually works". The detection rules are unit-tested in core
 * (packages/core/src/decks.test.ts); what those tests cannot reach is the part that
 * breaks: a real cross-origin sandboxed iframe posting real messages to a real host bar.
 * Before this file, the DeckBar's four test ids had no consumers at all, so the bar could
 * have stopped rendering, stopped advancing, or stopped receiving state without failing
 * anything.
 *
 * It drives the CANONICAL starter (the same bytes the CLI scaffolds and the MCP serves),
 * so it doubles as the guard that what we hand people is a working deck.
 */

/** Publish the canonical deck and open it with the workbench interactive. */
async function seedDeck(page: Page) {
  const shortId = await publishArtifact(page, "deck.html", DECK_TEMPLATE, "text/html")
  await openArtifact(page, shortId)
  // The bar appears only once the deck's own postMessage arrives, so its presence IS the
  // proof that the protocol round-tripped through the sandbox.
  await expect(page.getByTestId("deck-position")).toBeVisible()
  return shortId
}

test.describe("deck", () => {
  test("the host bar reflects the deck's state and drives it both ways", async ({
    owner: page,
  }) => {
    await seedDeck(page)

    const position = page.getByTestId("deck-position")
    const prev = page.getByTestId("deck-prev")
    const next = page.getByTestId("deck-next")

    // The count came FROM the deck (total), not from anything the host parsed.
    await expect(position).toHaveText("1 / 3")
    // At the first slide there is nowhere back to go, and the bar says so.
    await expect(prev).toBeDisabled()
    await expect(next).toBeEnabled()

    await next.click()
    await expect(position).toHaveText("2 / 3")
    await expect(prev).toBeEnabled()

    await next.click()
    await expect(position).toHaveText("3 / 3")
    // Last slide: forward is spent. This only reads correctly because the deck reported
    // its own total — a host guessing the slide count would have to be wrong somewhere.
    await expect(next).toBeDisabled()

    await prev.click()
    await expect(position).toHaveText("2 / 3")
  })

  test("Present mode is offered for a deck", async ({ owner: page }) => {
    await seedDeck(page)
    // Fullscreen is host-side (it fullscreens the iframe wrapper), which is why a deck
    // needs nothing beyond the protocol to be presentable. Assert the affordance exists;
    // real fullscreen is a browser gesture this suite can't meaningfully verify.
    await expect(page.getByTestId("deck-fullscreen")).toBeVisible()
  })

  test("a comment on a later slide flips the deck to that slide", async ({ owner: page }) => {
    // The claim the decks skill makes, and the one advertised deck feature I had verified
    // only by reasoning: comments bind to a SLIDE, so jumping to a thread takes you to the
    // slide its text lives on. Worth a test on its own merits — the binding had no coverage.
    //
    // The comment is created over REST with a TextQuoteSelector and NO slide index, which
    // is the stricter case: the slide has to be RESOLVED from where the quoted text
    // actually landed (landedSlides, reported out of the frame by the injected anchor
    // client), not read back from something the client stamped on the way in.
    const shortId = await publishArtifact(page, "deck.html", DECK_TEMPLATE, "text/html")
    // Text unique to the LAST slide of the canonical starter.
    const onLastSlide = "Every slide earns a picture and a sentence."
    expect(DECK_TEMPLATE).toContain(onLastSlide)
    const comment = async (body_md: string, exact?: string) => {
      const res = await page.request.post(`/v1/artifacts/${shortId}/comments`, {
        data: { body_md, anchor: exact ? { type: "TextQuoteSelector", exact } : undefined },
      })
      expect(res.ok(), `comment failed: ${res.status()}`).toBeTruthy()
    }
    await comment("Tighten this closing line.", onLastSlide)
    // A second, unanchored thread: the panel's thread nav only renders once there is more
    // than one thread, and anchored threads are ordered ahead of general ones — so the
    // first Next lands on the anchored one above.
    await comment("Looks good overall.")

    await openArtifact(page, shortId)
    const position = page.getByTestId("deck-position")
    // A deck always opens on its first slide, so any flip below is caused by the jump.
    await expect(position).toHaveText("1 / 3")

    // Jump to the thread. The anchor resolves on slide 3, so the host drives the deck there.
    await page.getByTestId("comment-nav-next").click()
    await expect(position).toHaveText("3 / 3")
  })

  test("a shared deck link presents for a signed-out visitor too", async ({ owner, browser }) => {
    // Sharing a link is how a deck usually reaches its audience, so the recipient — who is
    // typically not signed in — has to get the presentation chrome, not just a static first
    // slide. This works because the rendered frame is built ONCE in pages/artifact/index.tsx
    // and placed in both the workbench and the public viewer, and DeckBar is gated on the
    // deck's own postMessage rather than on the viewer being authenticated.
    //
    // Pinned deliberately: reading public-viewer.tsx alone strongly suggests the opposite
    // (it imports Presence from rail-deck and NOT DeckBar), and I reported it as broken on
    // that basis before checking. A test is the cheap way to stop the next person doing the
    // same in either direction.
    const shortId = await publishArtifact(owner, "deck.html", DECK_TEMPLATE, "text/html")
    const anon = await browser.newContext()
    const page = await anon.newPage()
    try {
      await page.goto(`/artifacts/${shortId}`)
      // Signed out for real — the public viewer's growth verbs, not the workbench.
      await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible()
      const position = page.getByTestId("deck-position")
      await expect(position).toHaveText("1 / 3")
      await expect(page.getByTestId("deck-fullscreen")).toBeVisible()
      // And it DRIVES, not just renders.
      await page.getByTestId("deck-next").click()
      await expect(position).toHaveText("2 / 3")
    } finally {
      await anon.close()
    }
  })

  test("an ordinary page gets no deck chrome", async ({ owner: page }) => {
    // The negative half: the bar is opt-in via the protocol, so a page that never posts
    // must stay a page. Without this, a bar that rendered unconditionally would pass
    // every assertion above.
    const shortId = await publishArtifact(
      page,
      "page.html",
      "<!doctype html><html><body><h1>Just a page</h1><p>No slides here.</p></body></html>",
      "text/html",
    )
    await openArtifact(page, shortId)
    await expect(page.getByTestId("deck-position")).toHaveCount(0)
  })

  test("the library's Start a deck opens the editor on the canonical starter", async ({
    owner: page,
  }) => {
    // The human entry point. It has to arrive with the real starter in the editor —
    // an empty editor here is the whole feature failing silently.
    await page.goto("/")
    await page.getByTestId("library-new").click()
    await page.getByTestId("library-new-deck").click()
    await expect(page).toHaveURL(/\/new\?start=deck/)
    const editor = page.getByTestId("artifact-source-editor")
    await expect(editor).toContainText("data-derive-slide")
    await expect(editor).toContainText("derive-deck")
  })
})
