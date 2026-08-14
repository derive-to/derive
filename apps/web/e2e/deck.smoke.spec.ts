import { DECK_TEMPLATE } from "@derive/core"
import type { Page } from "@playwright/test"
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

  test("the library's deck template path hands the visual reference to the agent", async ({
    owner: page,
  }) => {
    // The canonical deck is an agent reference, never a source-code editor or
    // old-school field-by-field WYSIWYG flow.
    await page.goto("/")
    await page.getByTestId("library-new").click()
    await page.getByTestId("library-new-template").click()
    await expect(page).toHaveURL(/\/templates/)
    await page.getByTestId("template-use-narrative-pitch").click()
    await page
      .getByTestId("template-agent-brief")
      .fill("Make a launch narrative for product leaders that earns approval for the plan.")
    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
    await expect(page.getByTestId("template-agent-open-codex")).toBeEnabled()
    await expect(page.getByTestId("template-agent-open-claude")).toBeEnabled()
  })

  /* ── The other half: a deck that announces NOTHING ─────────────────────────
     Everything above drives the canonical starter, which speaks the protocol. Most
     decks in the library predate it and never will, so the viewer also recognises one
     from its markup — and that path, plus what editing does to a deck's own keyboard,
     is what the rest of this file covers. */

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

  async function seedSilentDeck(page: Page) {
    const shortId = await publishArtifact(page, "deck.html", DECK, "text/html")
    await openArtifact(page, shortId)
    await expect(page.getByTestId("deck-bar")).toBeVisible()
    return shortId
  }

  test("a deck that never announced itself still gets the bar, and the bar drives it", async ({
    owner,
  }) => {
    await seedSilentDeck(owner)
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
    const shortId = await seedSilentDeck(owner)
    await owner.getByTestId("deck-next").click()
    await expect(owner.getByTestId("deck-position")).toHaveText("2 / 3")

    // Enter the mode from the header, then click the slide on screen to arm it.
    // `force` because Playwright's actionability check sees the NEXT slide stacked
    // on top of this one (a deck hides slides with opacity, which leaves them
    // hit-testable) and refuses to click. A real click lands fine: the client peels
    // those overlays before it resolves what the pointer is over, which is the
    // whole reason editing a deck works at all.
    await owner.getByTestId("artifact-inline-edit").click()
    await expect(owner.getByTestId("inline-edit-bar")).toBeVisible()
    await doc(owner).locator("#s2").click({ force: true })
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
    await seedSilentDeck(owner)
    await owner.getByTestId("deck-fullscreen").click()
    // The exit is stated, because a full-screen page with no visible way out is a trap.
    await expect(owner.getByTestId("deck-bar")).toContainText("Esc to exit")
    await owner.keyboard.press("Escape")
    await expect(owner.getByTestId("deck-bar")).not.toContainText("Esc to exit")
  })

  /**
   * The capture rule, stated as a test rather than as a comment.
   *
   * The client takes keys and clicks away from the page while a caret is in an
   * editable block. That interception runs on EVERY artifact, so the blast radius if
   * the gate is ever wrong is "documents stop receiving input" — the kind of thing
   * that deserves an assertion rather than an argument. This fixture counts what the
   * PAGE's own listeners see, and the test pins both halves of the rule: silence
   * while editing, and everything back afterwards.
   */
  const COUNTER = `<!doctype html><html><head><meta charset="utf-8"><title>Counter</title></head><body>
  <h1 id="h">Count me</h1>
  <p id="p">A paragraph to click into.</p>
  <script>
    window.__keys = 0; window.__clicks = 0
    document.addEventListener('keydown', function(){ window.__keys++ })
    window.addEventListener('keydown', function(){ window.__keys++ })
    document.addEventListener('click', function(){ window.__clicks++ })
  </script></body></html>`

  test("while a caret is in a block the page hears nothing, and hears again after", async ({
    owner,
  }) => {
    const shortId = await publishArtifact(owner, "counter.html", COUNTER, "text/html")
    await openArtifact(owner, shortId)
    // The counter the fixture keeps, read from inside the sandboxed frame.
    const seen = () =>
      doc(owner)
        .locator("body")
        .evaluate(() => (window as unknown as { __keys: number }).__keys)

    // Reading: the page owns its keyboard, exactly as it would without us.
    await doc(owner).locator("#p").click()
    await owner.keyboard.press("ArrowRight")
    await expect.poll(seen).toBeGreaterThan(0)

    // Editing, caret in a block: the page hears nothing at all.
    await owner.getByTestId("artifact-inline-edit").click()
    await expect(owner.getByTestId("inline-edit-bar")).toBeVisible()
    await doc(owner).locator("#p").click()
    const before = await seen()
    await owner.keyboard.type("typed words")
    await owner.keyboard.press("ArrowLeft")
    await owner.keyboard.press("Home")
    expect(await seen()).toBe(before)
    // …and the characters still reached the document: propagation was stopped, the
    // default never was.
    await expect(doc(owner).locator("#p")).toContainText("typed words")

    // Escape drops the caret. The page is listening again immediately.
    await owner.keyboard.press("Escape")
    await owner.keyboard.press("ArrowRight")
    await expect.poll(seen).toBeGreaterThan(before)
  })
})
