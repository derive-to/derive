import { devices, expect, test } from "@playwright/test"
import { publishArtifact, signUp } from "../helpers"

// Mobile commenting: a tap on a paragraph (no fiddly drag-select fighting the iOS
// menu) anchors a comment there and surfaces the bottom action bar, which opens
// the sheet composer pinned to that block. Pixel 7 = a chromium touch profile, the
// same touch + mobile-viewport path real phones hit.
test.use({ ...devices["Pixel 7"] })

test("tap a paragraph to comment: bar + composer, anchored to the block", async ({ page }) => {
  await signUp(page)
  const shortId = await publishArtifact(
    page,
    "m.md",
    "# Mobile\n\nFirst paragraph, short.\n\nSecond paragraph here with enough text to anchor a comment onto cleanly on a phone.",
  )
  await page.goto(`/a/${shortId}`)
  // Let the sandbox iframe load + the anchor client wire up.
  await page.waitForTimeout(2000)

  // Tap a paragraph in the document; the bottom bar appears with that block quoted.
  await page.frameLocator("iframe").getByText("Second paragraph here").tap()
  const bar = page.getByTestId("mobile-comment-bar")
  await expect(bar).toBeVisible()
  await expect(bar).toContainText("Second paragraph here")

  // Comment opens the sheet composer, quoting the tapped block.
  await page.getByTestId("mobile-comment-start").tap()
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await expect(page.getByText("Second paragraph here", { exact: false }).first()).toBeVisible()

  // Posting lands the anchored comment.
  await page.getByTestId("composer-input").fill("Looks good on mobile.")
  await page.getByTestId("composer-submit").tap()
  await expect(page.getByText("Looks good on mobile.")).toBeVisible()
})

test("the bottom bar dismisses without commenting", async ({ page }) => {
  await signUp(page)
  const shortId = await publishArtifact(
    page,
    "m.md",
    "# Doc\n\nA paragraph to tap and then dismiss.",
  )
  await page.goto(`/a/${shortId}`)
  await page.waitForTimeout(2000)

  await page.frameLocator("iframe").getByText("A paragraph to tap").tap()
  await expect(page.getByTestId("mobile-comment-bar")).toBeVisible()
  await page.getByTestId("mobile-comment-dismiss").tap()
  await expect(page.getByTestId("mobile-comment-bar")).toHaveCount(0)
})
