import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { expect, openArtifact, test } from "../fixtures"

// Resolved threads ride to the frame as QUIET anchors: their quote stays a
// working "jump to context" affordance (scroll + one-time flash), but nothing
// paints — a settled thread must not leave a highlight in the document, and
// its ghost must not react to hover or clicks in the text.

const PARAS = Array.from(
  { length: 30 },
  (_, i) => `<p id="p${i}">Paragraph ${i}: the quick brown fox ${i} jumps over the lazy dog.</p>`,
).join("\n")
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Doc</title></head>
<body style="font:17px/1.7 system-ui;padding:40px;max-width:620px">
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

test("a resolved comment's quote jumps to its context, without painting a highlight", async ({
  owner: page,
}) => {
  const shortId = await publishHtml(page, html)
  // One open thread near the top (paints), one resolved far down (quiet).
  const openRes = await page.request.post(`/v1/artifacts/${shortId}/comments`, {
    data: {
      body_md: "Still open",
      anchor: { type: "TextQuoteSelector", exact: "Paragraph 1: the quick brown fox" },
    },
  })
  expect(openRes.ok()).toBeTruthy()
  const resolvedRes = await page.request.post(`/v1/artifacts/${shortId}/comments`, {
    data: {
      body_md: "Settled long ago",
      anchor: { type: "TextQuoteSelector", exact: "Paragraph 25: the quick brown fox" },
    },
  })
  expect(resolvedRes.ok()).toBeTruthy()
  const resolvedId = ((await resolvedRes.json()) as { id: string }).id
  const flip = await page.request.post(`/v1/artifacts/${shortId}/comments/${resolvedId}/resolve`, {
    data: { state: "resolved" },
  })
  expect(flip.ok()).toBeTruthy()

  await openArtifact(page, shortId)

  // Only the OPEN thread paints — the resolved one resolves quietly.
  const frame = page.frames().find((f) => f.url().includes("/raw/"))
  if (!frame) throw new Error("artifact render frame not found")
  await expect
    .poll(
      () =>
        frame.evaluate(
          () =>
            (
              globalThis as unknown as { CSS?: { highlights?: Map<string, { size: number }> } }
            ).CSS?.highlights?.get("derive-hl")?.size ?? -1,
        ),
      { timeout: 5000 },
    )
    .toBe(1)

  // Open the Resolved drawer; the settled thread's quote is a live jump button.
  await page.getByTestId("resolved-section-toggle").click()
  const target = page.frameLocator("iframe").locator("#p25")
  const before = await target.boundingBox()
  await page.getByText("Settled long ago").click() // activate the card
  const jump = page.locator('[data-testid^="comment-jump-"]').last()
  await expect(jump).toBeVisible()
  await jump.click()

  // The document scrolled the resolved comment's paragraph into view.
  await expect
    .poll(
      async () => {
        const box = await target.boundingBox()
        return box ? Math.abs(box.y - (before?.y ?? 0)) : 0
      },
      { timeout: 5000 },
    )
    .toBeGreaterThan(500)
  const after = await target.boundingBox()
  expect(after && after.y > 0 && after.y < 720).toBeTruthy()

  // Still nothing painted for it.
  const painted = await frame.evaluate(
    () =>
      (
        globalThis as unknown as { CSS?: { highlights?: Map<string, { size: number }> } }
      ).CSS?.highlights?.get("derive-hl")?.size ?? -1,
  )
  expect(painted).toBe(1)
})
