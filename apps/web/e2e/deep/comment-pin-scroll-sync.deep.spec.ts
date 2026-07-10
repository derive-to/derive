import { Buffer } from "node:buffer"
import type { Locator, Page } from "@playwright/test"
import { expect, openArtifact, test } from "../fixtures"

// The pin layer: cards live in DOCUMENT coordinates inside a single layer the
// host translates imperatively on each scroll message — no React render, no
// per-card animation chasing the scroll. These specs pin down the properties
// that rewrite bought: (1) a card tracks its highlight through scrolling and
// aligns without any assumed header math, (2) the mid-compose composer glides
// with its selection instead of parking at a frozen viewport Y, (3) a comment
// anchored in the doc's first pixels — above the zone's top — is reachable by
// wheeling up over the panel, (4) a wheel over an active card's own scrollable
// thread list stays with the list instead of being hijacked into a doc scroll.

// A long document: 40 numbered paragraphs, the top one nearly flush with the
// document's top edge (padding 4px) so its pin lands ABOVE the comments zone.
const PARAS = Array.from(
  { length: 40 },
  (_, i) => `<p id="p${i}">Paragraph ${i} scrolls the quick brown fox ${i} over the lazy dog.</p>`,
).join("\n")
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Long doc</title></head>
<body style="font:18px/1.7 system-ui;padding:4px 40px 40px;max-width:620px">
${PARAS}</body></html>`

async function publishHtml(page: Page, body: string): Promise<string> {
  let shortId = ""
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: { file: { name: "doc.html", mimeType: "text/html", buffer: Buffer.from(body) } },
    })
    expect(res.ok(), `publish failed: ${res.status()}`).toBeTruthy()
    shortId = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })
  return shortId
}

// An anchored comment straight through the API, so we control the exact quoted span.
async function anchorComment(page: Page, shortId: string, body: string, exact: string) {
  const res = await page.request.post(`/v1/artifacts/${shortId}/comments`, {
    data: { body_md: body, anchor: { type: "TextQuoteSelector", exact } },
  })
  expect(res.ok(), `comment failed: ${res.status()}`).toBeTruthy()
  return (await res.json()) as { id: string; thread_id: string }
}

// Top of a locator in MAIN-PAGE coordinates (Playwright folds in the iframe offset).
async function topOf(loc: Locator): Promise<number> {
  const box = await loc.boundingBox()
  expect(box, "element should have a box").toBeTruthy()
  return box?.y ?? 0
}

// Wait for the document's own scrolling (wheel momentum, fastScrollTo) to settle:
// two consecutive frames with the reference paragraph at the same Y.
async function settle(loc: Locator): Promise<number> {
  let last = Number.NaN
  await expect
    .poll(
      async () => {
        const y = await topOf(loc)
        const stable = Math.abs(y - last) < 0.5
        last = y
        return stable
      },
      { timeout: 5000 },
    )
    .toBe(true)
  return last
}

test.describe("comment pins track the document", () => {
  test("a pinned card aligns with its highlight and tracks it through a scroll, with no transition on the layer", async ({
    owner: page,
  }) => {
    const shortId = await publishHtml(page, html)
    await anchorComment(page, shortId, "Mid-doc note", "Paragraph 12 scrolls the quick brown fox")
    await openArtifact(page, shortId)

    const para = page.frameLocator("iframe").locator("#p12")
    const card = page.getByTestId("comment-card")
    await expect(card).toBeVisible()

    // Scroll the paragraph into view first (the card pins wherever it is).
    const frameEl = page.locator("iframe")
    const fb = await frameEl.boundingBox()
    if (!fb) throw new Error("no frame box")
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2)
    await page.mouse.wheel(0, 600)
    const paraY = await settle(para)

    // Aligned: the card's top sits at its highlight's top (single pin — the
    // relaxed layout doesn't move it). The datum is MEASURED, so no assumed
    // header/review-card math can skew this.
    await expect.poll(() => topOf(card), { timeout: 3000 }).toBeGreaterThan(paraY - 6)
    expect(await topOf(card)).toBeLessThan(paraY + 6)

    // Scroll again — the card lands aligned at the new position too.
    await page.mouse.wheel(0, 400)
    const paraY2 = await settle(para)
    expect(paraY2).toBeLessThan(paraY) // the doc actually moved
    await expect.poll(() => topOf(card), { timeout: 3000 }).toBeGreaterThan(paraY2 - 6)
    expect(await topOf(card)).toBeLessThan(paraY2 + 6)

    // The layer itself must not ease: scroll tracking is instant by construction;
    // only the CARDS keep a transform transition (fired on layout changes alone).
    // (transition-property computes to "all" by default — duration is the signal.)
    const cardWrap = page.locator("[data-pin]").first()
    const durations = await cardWrap.evaluate((el) => ({
      layer: getComputedStyle(el.parentElement as Element).transitionDuration,
      card: getComputedStyle(el).transitionDuration,
    }))
    expect(durations.layer).toBe("0s")
    expect(durations.card).toBe("0.2s")
  })

  test("the mid-compose composer glides with its selection when the document scrolls", async ({
    owner: page,
  }) => {
    const shortId = await publishHtml(page, html)
    await openArtifact(page, shortId)

    // Bring a mid-doc paragraph on screen, then select its text programmatically
    // (a synthetic mouseup makes the anchor client emit the selection, exactly as
    // a real drag-select would).
    const frameEl = page.locator("iframe")
    const fb = await frameEl.boundingBox()
    if (!fb) throw new Error("no frame box")
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2)
    await page.mouse.wheel(0, 500)
    const frame = page.frames().find((f) => f.url().includes("/raw/"))
    if (!frame) throw new Error("artifact render frame not found")
    await settle(page.frameLocator("iframe").locator("#p10"))
    await frame.evaluate(() => {
      const p = document.getElementById("p10")
      if (!p?.firstChild) throw new Error("no #p10")
      const r = document.createRange()
      r.setStart(p.firstChild, 0)
      r.setEnd(p.firstChild, 20)
      const s = window.getSelection()
      s?.removeAllRanges()
      s?.addRange(r)
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
    })

    await page.getByTestId("comment-on-selection").click()
    const composer = page.getByTestId("comment-composer")
    await expect(composer).toBeVisible()
    await page.getByTestId("composer-input").fill("thinking about this…")

    // A small scroll first: opening the composer may have nudged the panel's
    // local offset to reveal it (one-shot, unwound by the next scroll — by
    // design). Flush that so the measurement below sees pure tracking.
    const para = page.frameLocator("iframe").locator("#p10")
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2)
    await page.mouse.wheel(0, 60)
    const paraY = await settle(para)
    const composerY = await topOf(composer)

    // Scroll the document while the composer is open: it must move WITH its
    // highlight (same delta), not park at the viewport Y it opened at.
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2)
    await page.mouse.wheel(0, 300)
    const paraY2 = await settle(para)
    const delta = paraY2 - paraY
    expect(Math.abs(delta)).toBeGreaterThan(100) // the doc really moved
    await expect
      .poll(async () => Math.abs((await topOf(composer)) - (composerY + delta)), { timeout: 3000 })
      .toBeLessThan(8)
    // And the draft survived the ride.
    await expect(page.getByTestId("composer-input")).toHaveValue("thinking about this…")
  })

  test("pins stay aligned when a banner sits above the iframe (past-version view — the measured-datum case)", async ({
    owner: page,
  }) => {
    const shortId = await publishHtml(page, html)
    await anchorComment(page, shortId, "Note on v1", "Paragraph 12 scrolls the quick brown fox")
    // Publish v2 so viewing @v1 shows the past-version banner ABOVE the iframe —
    // exactly the offset the old assumed-header-only inset never accounted for.
    const res = await page.request.post(`/v1/artifacts/${shortId}/versions`, {
      multipart: {
        file: { name: "doc.html", mimeType: "text/html", buffer: Buffer.from(html) },
      },
    })
    expect(res.ok(), `republish failed: ${res.status()}`).toBeTruthy()
    await page.goto(`/artifacts/${shortId}@v1`)
    await expect(page.getByText("Viewing an earlier version")).toBeVisible()

    const para = page.frameLocator("iframe").locator("#p12")
    const card = page.getByTestId("comment-card")
    await expect(card).toBeVisible()

    const frameEl = page.locator("iframe")
    const fb = await frameEl.boundingBox()
    if (!fb) throw new Error("no frame box")
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2)
    await page.mouse.wheel(0, 600)
    const paraY = await settle(para)

    // The datum is measured (iframe top vs zone top), so the banner's height
    // can't skew the card off its highlight.
    await expect.poll(() => topOf(card), { timeout: 3000 }).toBeGreaterThan(paraY - 6)
    expect(await topOf(card)).toBeLessThan(paraY + 6)
  })

  test("a comment anchored at the document's very top is reachable by wheeling up over the panel", async ({
    owner: page,
  }) => {
    const shortId = await publishHtml(page, html)
    await anchorComment(page, shortId, "Note on the title line", "Paragraph 0 scrolls")
    await openArtifact(page, shortId)

    // The doc opens at scrollY 0. The first paragraph sits ~8px into the document,
    // but the comments zone starts BELOW the panel header — so this pin's home is
    // above the zone's top edge, clipped. Wheel UP over the panel: with nothing
    // left to forward to the doc, the gesture opens the above-zone band.
    const card = page.getByTestId("comment-card")
    const panel = page.getByText("Comments", { exact: true })
    const pb = await panel.boundingBox()
    if (!pb) throw new Error("no panel box")
    const zoneTop = pb.y + pb.height

    await page.mouse.move(pb.x + 40, zoneTop + 120)
    await page.mouse.wheel(0, -200)
    await expect.poll(() => topOf(card), { timeout: 3000 }).toBeGreaterThan(zoneTop - 2)
  })

  test("wheel over an active card's thread list scrolls the list, not the document", async ({
    owner: page,
  }) => {
    const shortId = await publishHtml(page, html)
    const root = await anchorComment(
      page,
      shortId,
      "Root of a long thread",
      "Paragraph 3 scrolls the quick brown fox",
    )
    // Enough replies that the active card's thread list (max-h + overflow-auto)
    // genuinely overflows and can consume wheel ticks itself.
    for (let i = 0; i < 12; i++) {
      const res = await page.request.post(`/v1/artifacts/${shortId}/comments`, {
        data: {
          body_md: `reply ${i} with a couple of lines of text in it`,
          thread_id: root.thread_id,
        },
      })
      expect(res.ok()).toBeTruthy()
    }
    await openArtifact(page, shortId)

    const card = page.getByTestId("comment-card")
    await expect(card).toBeVisible()
    await card.click()
    await expect(page.getByTestId("comment-resolve")).toBeVisible()

    const list = card.locator("div.overflow-auto").first()
    const para = page.frameLocator("iframe").locator("#p3")
    const paraY = await settle(para)
    const before = await list.evaluate((el) => el.scrollTop)

    const lb = await list.boundingBox()
    if (!lb) throw new Error("no list box")
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2)
    await page.mouse.wheel(0, 200)

    await expect
      .poll(() => list.evaluate((el) => el.scrollTop), { timeout: 3000 })
      .toBeGreaterThan(before)
    // The document held still — the gesture belonged to the list.
    expect(Math.abs((await topOf(para)) - paraY)).toBeLessThan(2)
  })
})
