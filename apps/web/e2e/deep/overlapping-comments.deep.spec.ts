import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { expect, openArtifact, test } from "../fixtures"

// Overlapping text comments — two threads whose quoted spans intersect. The old
// <mark> DOM-wrapping nested awkwardly here; the CSS Custom Highlight API rewrite
// paints them without mutating the artifact's DOM, darkens the shared region, and
// hit-tests a click to the most specific (smallest) comment. Both threads stay
// reachable as pinned cards. This is the first coverage of the overlap case.

const PARA = "The quick brown fox jumps over the lazy dog near the river bank."
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Doc</title></head>
<body style="font:18px/1.7 system-ui;padding:40px;max-width:620px">
<p id="p">${PARA}</p></body></html>`

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
}

// The sandboxed render iframe (its src is /raw/<id>/v/<n>/…). Playwright reaches it
// over CDP regardless of the iframe's opaque-origin sandbox.
async function highlightCounts(page: Page): Promise<{ base: number; overlap: number }> {
  const frame = page.frames().find((f) => f.url().includes("/raw/"))
  if (!frame) throw new Error("artifact render frame not found")
  return frame.evaluate(() => {
    const reg = (globalThis as unknown as { CSS?: { highlights?: Map<string, { size: number }> } })
      .CSS?.highlights
    return {
      base: reg?.get("derive-hl")?.size ?? -1,
      overlap: reg?.get("derive-hl-overlap")?.size ?? -1,
    }
  })
}

test.describe("overlapping text comments", () => {
  test("both overlapping comments resolve, paint (with a darker shared region), and hit-test on click", async ({
    owner: page,
  }) => {
    const shortId = await publishHtml(page, html)
    // A = "quick brown fox jumps" (front), B = "brown fox jumps over the lazy" (back).
    // They share "brown fox jumps" — the overlap. A is the shorter (more specific) span.
    await anchorComment(page, shortId, "Comment A on the front", "quick brown fox jumps")
    await anchorComment(page, shortId, "Comment B on the back", "brown fox jumps over the lazy")
    await openArtifact(page, shortId)

    // Both threads resolve and pin as cards (neither orphaned into the general drawer).
    await expect(page.getByTestId("comment-card")).toHaveCount(2)

    // The Custom Highlight API painted BOTH ranges, plus an overlap layer for the
    // shared span — proof the overlap renders as its own (darker) region rather than
    // one comment clobbering the other.
    await expect.poll(async () => (await highlightCounts(page)).base, { timeout: 5000 }).toBe(2)
    expect((await highlightCounts(page)).overlap).toBeGreaterThanOrEqual(1)

    // Clicking the highlighted text in the document hit-tests to a thread and opens it
    // (there are no <mark> elements to catch the click — this exercises the caret
    // hit-test path). The paragraph's center sits inside the overlap.
    await page.frameLocator("iframe").locator("#p").click()
    await expect(page.getByTestId("comment-resolve")).toBeVisible({ timeout: 5000 })
  })
})
