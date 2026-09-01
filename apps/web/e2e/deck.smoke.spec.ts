import { countSlideElements, DECK_TEMPLATE } from "@derive/core"
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

  test("an editor can visually arrange, add, duplicate, trash, restore, undo, and save slides", async ({
    owner: page,
  }) => {
    const shortId = await seedDeck(page)
    await expect(page.getByTestId("artifact-edit-menu")).toHaveCount(0)
    await expect(page.getByTestId("artifact-inline-edit")).toBeVisible()
    await page.getByTestId("deck-arrange").click()
    await expect(page.getByTestId("deck-organizer")).toBeVisible()
    await expect(page.getByTestId("deck-slide-card-1")).toContainText("New deck")
    await expect(page.getByTestId("deck-slide-card-2")).toContainText(
      "The stage is fixed. Only the scale changes.",
    )

    // Reorder is visible before it is published, and the structural Undo is one click.
    await page.getByTestId("deck-slide-card-1").hover()
    await page.getByTestId("deck-slide-down-1").click()
    await expect(page.getByTestId("deck-slide-card-1")).toContainText("The stage is fixed")
    await page.getByTestId("deck-arrange-undo").click()
    await expect(page.getByTestId("deck-slide-card-1")).toContainText("New deck")

    // The dedicated grab handle supports the same reorder with a visible drop target.
    await page.getByTestId("deck-slide-drag-1").dragTo(page.getByTestId("deck-slide-card-2"))
    await expect(page.getByTestId("deck-slide-card-1")).toContainText("The stage is fixed")
    await page.getByTestId("deck-arrange-undo").click()

    // Add is a real blank slide; Duplicate is a separate exact-copy operation.
    await page.getByTestId("deck-add-slide").click()
    await expect(page.getByTestId("deck-slide-card-2")).toContainText("New slide")
    await expect(page.getByTestId("deck-pending-preview")).toContainText(
      "This blank slide will be ready to edit after you save.",
    )
    await page.getByTestId("deck-slide-more-1").click()
    await page.getByTestId("deck-slide-duplicate-1").click()
    await expect(page.getByTestId("deck-slide-card-2")).toContainText("New deck copy")
    await expect(page.getByTestId("deck-pending-preview")).toContainText(
      "This copy will match its source when you save.",
    )

    // Remove parks the slide in a visible Trash instead of throwing it away.
    await page.getByTestId("deck-slide-more-3").click()
    await page.getByTestId("deck-slide-remove-3").click()
    await page.getByTestId("deck-remove-confirm").click()
    await expect(page.getByTestId("deck-trash-restore")).toBeVisible()
    await page.getByTestId("deck-trash-restore").click()
    await expect(page.getByTestId("deck-trash-restore")).toHaveCount(0)

    await page.getByTestId("deck-arrange-save").click()
    await expect(page.getByTestId("deck-organizer")).toBeHidden()
    await expect(page.getByTestId("deck-position")).toContainText("/ 5")

    const res = await page.request.get(`/v1/artifacts/${shortId}/content`)
    const src = await res.text()
    expect(src).toContain("<h2>New slide</h2>")
    expect(countSlideElements(src)).toBe(5)

    // A phone gets a bottom sheet with persistent finger-sized move controls. Adding
    // another row must scroll the list, never flex-compress the cards into each other.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId("deck-arrange").click()
    await expect(page.getByTestId("deck-slide-down-1")).toBeVisible()
    await page.getByTestId("deck-add-slide").click()
    const overlap = await page.getByTestId(/^deck-slide-card-/).evaluateAll((cards) =>
      cards.flatMap((card, i) => {
        const next = cards[i + 1]
        return next && card.getBoundingClientRect().bottom > next.getBoundingClientRect().top
          ? [i + 1]
          : []
      }),
    )
    expect(overlap).toEqual([])
    await page.getByTestId("deck-arrange-undo").click()
    await page.getByTestId("deck-arrange-close").click()
  })

  test("a comment stays with its slide identity after a class-only deck is rearranged", async ({
    owner: page,
  }) => {
    // Before the first arrange, this deck has no explicit identities. The injected
    // outline predicts the same numeric identities the server stamps, so a comment made
    // now can still disambiguate repeated text after the slides trade places.
    const classOnly = DECK_TEMPLATE.replace(/ data-derive-slide="\d+"/g, "")
      .replace("<h1>New deck</h1>", "<h1>Repeated phrase</h1>")
      .replace("<h2>The stage is fixed. Only the scale changes.</h2>", "<h2>Repeated phrase</h2>")
    const shortId = await publishArtifact(page, "identity-deck.html", classOnly, "text/html")
    const comment = async (body_md: string, anchor?: Record<string, unknown>) => {
      const res = await page.request.post(`/v1/artifacts/${shortId}/comments`, {
        data: { body_md, anchor },
      })
      expect(res.ok(), await res.text()).toBeTruthy()
    }
    await comment("This belongs to the original second slide.", {
      type: "TextQuoteSelector",
      exact: "Repeated phrase",
      slide: 1,
      slide_identity: "1",
    })
    await comment("General note.")

    await openArtifact(page, shortId)
    await page.getByTestId("deck-arrange").click()
    await page.getByTestId("deck-slide-card-2").hover()
    await page.getByTestId("deck-slide-up-2").click()
    await page.getByTestId("deck-arrange-save").click()
    await expect(page.getByTestId("deck-position")).toContainText("1 / 3")

    // Move away, then jump to the anchored comment. Ordinal-only resolution would land
    // on slide 2 (the old position); stable identity takes us back to the moved slide 1.
    await page.getByTestId("deck-next").click()
    await expect(page.getByTestId("deck-position")).toContainText("2 / 3")
    const nextComment = page.getByTestId("comment-nav-next")
    if (!(await nextComment.isVisible())) await page.getByTestId("artifact-show-comments").click()
    await nextComment.click()
    await expect(page.getByTestId("deck-position")).toContainText("1 / 3")
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
    const nextComment = page.getByTestId("comment-nav-next")
    if (!(await nextComment.isVisible())) await page.getByTestId("artifact-show-comments").click()
    await nextComment.click()
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

  test("a deck on the template shelf is handed to the agent as a reference, never opened as source", async ({
    owner: page,
  }) => {
    // A template is an artifact tagged `template`; a deck template is that deck. The
    // handoff names it by short id, and never opens a source editor or a field form.
    const shortId = await publishArtifact(
      page,
      "deck.html",
      `<!doctype html><html><head><meta charset="utf-8"><title>Launch narrative</title></head><body>
  <section class="slide on" data-derive-slide="0"><h1>The change</h1></section>
  <section class="slide" data-derive-slide="1"><h1>The plan</h1></section>
  </body></html>`,
      "text/html",
    )
    const tagged = await page.request.put(`/v1/artifacts/${shortId}/tags`, {
      data: { tags: ["template"] },
    })
    expect(tagged.ok(), await tagged.text()).toBeTruthy()
    await page.goto("/")
    await page.getByTestId("library-new").click()
    await page.getByTestId("library-new-template").click()
    await expect(page).toHaveURL(/\/templates/)
    await page.getByTestId(`template-ask-${shortId}`).click()
    await page
      .getByTestId("template-agent-brief")
      .fill("Make a launch narrative for product leaders that earns approval for the plan.")
    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
    await expect(page.getByTestId("template-agent-copy")).toBeEnabled()
    await expect(page.getByTestId("template-agent-open-codex")).toHaveCount(0)
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

  const STRUCTURAL_DECK = `<!doctype html><html><head><meta charset="utf-8"><title>Structural deck</title>
  <style>
    *{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden;background:#10131a}
    .stage{position:fixed;left:50%;top:50%;width:960px;height:540px;overflow:hidden;transform:translate(-50%,-50%) scale(.72);transform-origin:center}
    .slide{position:absolute;inset:0;opacity:0;pointer-events:none;display:flex;flex-direction:column;gap:18px;padding:48px;background:#fff}
    .slide.on{opacity:1;pointer-events:auto}.board{padding:18px;border:2px solid #94a3b8}.cards{display:flex;flex-direction:row;flex-wrap:nowrap;align-items:flex-start;gap:12px}
    .card{flex:1 1 0;min-width:0;padding:14px;border:2px solid #64748b;background:#f8fafc;overflow:hidden}
  </style></head><body><main class="stage">
    <section class="slide on" data-derive-slide="0" data-derive-region="slide-0" data-derive-layout="stack">
      <h1 data-derive-node="s0-title">Scaled structural deck</h1><p data-derive-node="s0-copy">Advance to edit the hierarchy.</p>
    </section>
    <section class="slide" data-derive-slide="1" data-derive-region="slide-1" data-derive-layout="stack">
      <h2 data-derive-node="s1-title">Editable hierarchy</h2>
      <div id="board" class="board" data-derive-node="s1-board" data-derive-kind="group">
        <div id="cards" class="cards" data-derive-region="s1-cards" data-derive-layout="row" data-derive-owner="s1-board">
          <article id="alpha" class="card" data-derive-node="s1-alpha" data-derive-width="28" data-derive-height="96" style="--derive-structural-width:28%;--derive-structural-height:96px">Alpha</article>
          <article id="beta" class="card" data-derive-node="s1-beta" data-derive-width="32" data-derive-height="112" style="--derive-structural-width:32%;--derive-structural-height:112px">Beta</article>
          <article id="gamma" class="card" data-derive-node="s1-gamma" data-derive-width="36" data-derive-height="128" style="--derive-structural-width:36%;--derive-structural-height:128px">Gamma</article>
        </div>
      </div>
    </section>
    <section class="slide" data-derive-slide="2" data-derive-region="slide-2" data-derive-layout="stack">
      <h2 data-derive-node="s2-title">Isolation sentinel</h2><p id="sentinel" data-derive-node="s2-copy">Nothing on slide two may mutate this slide.</p>
    </section>
  </main><script>
    var slides=[].slice.call(document.querySelectorAll('.slide')),at=0
    function report(){parent.postMessage({source:'derive-deck',type:'state',i:at,total:slides.length},'*')}
    function show(n){at=Math.max(0,Math.min(slides.length-1,n));slides.forEach(function(s,i){s.classList.toggle('on',i===at)});report()}
    addEventListener('message',function(e){var d=e.data;if(!d||d.source!=='derive-host'||d.type!=='deck')return;if(d.action==='next')show(at+1);else if(d.action==='prev')show(at-1);else if(d.action==='goto')show(typeof d.n==='number'?d.n:0)})
    addEventListener('keydown',function(e){if(e.key==='ArrowRight')show(at+1);else if(e.key==='ArrowLeft')show(at-1)})
    report()
  </script></body></html>`

  const doc = (page: Page) => page.frameLocator("iframe[title]")

  async function seedSilentDeck(page: Page) {
    const shortId = await publishArtifact(page, "deck.html", DECK, "text/html")
    await openArtifact(page, shortId)
    await expect(page.getByTestId("deck-bar")).toBeVisible()
    return shortId
  }

  test("a scaled deck supports row movement, hierarchy, resize, history, and persistence", async ({
    owner,
  }) => {
    const shortId = await publishArtifact(
      owner,
      "structural-deck.html",
      STRUCTURAL_DECK,
      "text/html",
    )
    await openArtifact(owner, shortId)
    await expect(owner.getByTestId("deck-position")).toHaveText("1 / 3")
    await owner.getByTestId("deck-next").click()
    await expect(owner.getByTestId("deck-position")).toHaveText("2 / 3")
    await owner.getByTestId("deck-edit").click()

    const frame = doc(owner)
    const beta = frame.locator("#beta")
    await beta.click()
    await expect(
      frame.getByRole("button", { name: "Select containing group (Escape)" }),
    ).toBeVisible()

    // Row order changes locally; the outer hierarchy and inactive slide stay intact.
    await frame.getByRole("button", { name: "Move earlier (Option+Up)" }).click()
    await expect(frame.locator("#cards > [data-derive-node]").nth(0)).toHaveAttribute(
      "data-derive-node",
      "s1-beta",
    )
    await frame.getByRole("button", { name: "Select containing group (Escape)" }).click()
    await frame.getByRole("button", { name: "Move earlier (Option+Up)" }).click()
    await expect(
      frame.locator("[data-derive-region='slide-1'] > [data-derive-node]").nth(0),
    ).toHaveAttribute("data-derive-node", "s1-board")
    await expect(frame.locator("#sentinel")).toHaveText(
      "Nothing on slide two may mutate this slide.",
    )

    await owner.getByTestId("inline-edit-undo").click()
    await owner.getByTestId("inline-edit-undo").click()
    await expect(frame.locator("#cards > [data-derive-node]").nth(1)).toHaveAttribute(
      "data-derive-node",
      "s1-beta",
    )

    // Two-axis sizing remains one transaction inside the scaled stage. Pointer-scale
    // math has its own focused E2E; this deck regression pins the deck integration,
    // row authority, and shared history without making the proof depend on CDP's
    // cross-frame pointer-capture timing.
    await beta.click()
    await frame.getByRole("button", { name: "Set exact width and height" }).click()
    const dimensions = frame.locator(".derive-structure-precision-input")
    await dimensions.nth(0).fill("36")
    await dimensions.nth(1).fill("128")
    await frame.getByRole("button", { name: "Apply exact width and height" }).click()
    await expect(beta).toHaveAttribute("data-derive-width", "36")
    await expect(beta).toHaveAttribute("data-derive-height", "128")

    await owner.getByTestId("inline-edit-undo").click()
    await expect(beta).toHaveAttribute("data-derive-width", "32")
    await expect(beta).toHaveAttribute("data-derive-height", "112")
    await expect(owner.getByTestId("inline-edit-redo")).toBeEnabled()
    await owner.getByTestId("inline-edit-redo").click()
    await expect(beta).toHaveAttribute("data-derive-width", "36")
    await expect(beta).toHaveAttribute("data-derive-height", "128")

    await owner.getByTestId("inline-edit-save").click()
    await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
    await expect(async () => {
      const src = await (await owner.request.get(`/v1/artifacts/${shortId}/content`)).text()
      expect(src).toContain('data-derive-layout="row"')
      expect(src.match(/<article id="beta"[^>]*>/)?.[0]).toContain('data-derive-width="36"')
      expect(src.match(/<article id="beta"[^>]*>/)?.[0]).toContain('data-derive-height="128"')
      expect(src).toContain("Nothing on slide two may mutate this slide.")
    }).toPass({ timeout: 10_000 })
  })

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

    // Enter the mode directly from the deck bar, then click the slide on screen to arm it.
    // `force` because Playwright's actionability check sees the NEXT slide stacked
    // on top of this one (a deck hides slides with opacity, which leaves them
    // hit-testable) and refuses to click. A real click lands fine: the client peels
    // those overlays before it resolves what the pointer is over, which is the
    // whole reason editing a deck works at all.
    await owner.getByTestId("deck-edit").click()
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

  test("deck edit and rearrange are direct actions in the deck bar", async ({ owner }) => {
    await seedDeck(owner)

    // The shared artifact Edit affordance and the deck bar's contextual actions
    // intentionally coexist; both enter the same source-backed edit session.
    await expect(owner.getByTestId("artifact-inline-edit")).toBeVisible()
    await expect(owner.getByTestId("artifact-edit-menu")).toHaveCount(0)
    await expect(owner.getByTestId("deck-edit")).toBeVisible()
    await expect(owner.getByTestId("deck-arrange")).toBeVisible()

    await owner.getByTestId("deck-edit").click()
    await expect(owner.getByTestId("inline-edit-bar")).toBeVisible()
    // Rearrange remains available while content editing is active.
    await expect(owner.getByTestId("deck-arrange")).toBeVisible()

    await owner.getByTestId("deck-arrange").click()
    await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
    await expect(owner.getByTestId("deck-organizer")).toBeVisible()

    await owner.getByTestId("deck-edit").click()
    await expect(owner.getByTestId("deck-organizer")).toBeHidden()
    await expect(owner.getByTestId("inline-edit-bar")).toBeVisible()
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
