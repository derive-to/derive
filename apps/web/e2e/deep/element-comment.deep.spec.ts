import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { expect, openArtifact, test } from "../fixtures"

// Commenting on a NON-TEXT element (image / table / chart) via the in-document "💬
// Comment" chip that appears on hover. The chip posts an element `select`; the host
// should surface the comment affordance so you can pin a comment to that element. This
// path had no e2e coverage — this reproduces + guards it.

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Doc</title></head>
<body style="font:18px/1.7 system-ui;padding:40px;max-width:640px">
  <h1>Report</h1>
  <p>Some intro text before the figure.</p>
  <img id="pic" src="https://placehold.co/300x160/png" alt="A sample chart" width="300" height="160">
  <p>Between the two.</p>
  <table id="tbl" border="1"><tr><th>Region</th><th>Rev</th></tr><tr><td>EU</td><td>9</td></tr></table>
</body></html>`

async function publishHtml(page: Page): Promise<string> {
  let shortId = ""
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: { file: { name: "doc.html", mimeType: "text/html", buffer: Buffer.from(html) } },
    })
    expect(res.ok(), `publish failed: ${res.status()}`).toBeTruthy()
    shortId = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })
  return shortId
}

// Hover the element to raise its chip, then click the chip — the real user path.
async function clickElementChip(page: Page, selector: string): Promise<void> {
  const frame = page.frameLocator("iframe")
  await frame.locator(selector).hover()
  const chip = frame.locator(".derive-el-chip")
  await expect(chip, "the 💬 Comment chip should appear on hover").toBeVisible({ timeout: 5000 })
  await chip.click()
}

test.describe("commenting on a non-text element via the hover chip", () => {
  test("clicking the chip on an image opens a composer that pins a comment to it", async ({
    owner: page,
  }) => {
    const shortId = await publishHtml(page)
    await openArtifact(page, shortId)
    await expect(page.frameLocator("iframe").locator("#pic")).toBeVisible()

    await clickElementChip(page, "#pic")

    // The selection affordance must surface (so a comment can be pinned to the image).
    // BUG: a race with emitSelection wipes the element selection, so this never appears.
    await expect(page.getByTestId("comment-on-selection")).toBeVisible({ timeout: 5000 })
    await page.getByTestId("comment-on-selection").click()
    await page.getByTestId("composer-input").fill("This chart needs a label.")
    await page.getByTestId("composer-submit").click()

    // The comment lands and references the element (its snapshot label, not a text quote).
    await expect(page.getByTestId("comment-card")).toHaveCount(1)
    await expect(page.getByText("This chart needs a label.")).toBeVisible()
  })

  test("clicking the chip on a table works too", async ({ owner: page }) => {
    const shortId = await publishHtml(page)
    await openArtifact(page, shortId)
    await expect(page.frameLocator("iframe").locator("#tbl")).toBeVisible()

    await clickElementChip(page, "#tbl")
    await expect(page.getByTestId("comment-on-selection")).toBeVisible({ timeout: 5000 })
  })
})
