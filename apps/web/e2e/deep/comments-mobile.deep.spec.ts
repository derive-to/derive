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
  await page.goto(`/artifacts/${shortId}`)
  // Let the sandbox iframe load + the anchor client wire up.
  await page.waitForTimeout(2000)

  // Tap a paragraph in the document; the bottom bar appears with that block quoted.
  await page.frameLocator("iframe").getByText("Second paragraph here").tap()
  const bar = page.getByTestId("mobile-comment-bar")
  await expect(bar).toBeVisible()
  await expect(bar).toContainText("Second paragraph here")

  // Comment opens a COMPACT composer bar (pinned above the keyboard on a real
  // device) with the quote — the document stays visible above it, not a full sheet.
  await page.getByTestId("mobile-comment-start").tap()
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await expect(page.getByText("Second paragraph here", { exact: false }).first()).toBeVisible()
  const vvh = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight)
  await expect
    .poll(
      async () => (await page.getByRole("dialog", { name: "Comments" }).boundingBox())?.height ?? 0,
    )
    .toBeLessThan(vvh * 0.6) // a compact bar, not a full/half-screen sheet

  // Posting lands the anchored comment and opens the full list to show it.
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
  await page.goto(`/artifacts/${shortId}`)
  await page.waitForTimeout(2000)

  await page.frameLocator("iframe").getByText("A paragraph to tap").tap()
  await expect(page.getByTestId("mobile-comment-bar")).toBeVisible()
  await page.getByTestId("mobile-comment-dismiss").tap()
  await expect(page.getByTestId("mobile-comment-bar")).toHaveCount(0)
})

test("collapse the full list to a peek bar, and reopen", async ({ page }) => {
  await signUp(page)
  const shortId = await publishArtifact(page, "m.md", "# Doc\n\nA paragraph to comment on here.")
  await page.goto(`/artifacts/${shortId}`)
  await page.waitForTimeout(2000)

  // Post a comment; the sheet opens to the full list so the new comment shows.
  await page.frameLocator("iframe").getByText("A paragraph to comment").tap()
  await page.getByTestId("mobile-comment-start").tap()
  await page.getByTestId("composer-input").fill("First note.")
  await page.getByTestId("composer-submit").tap()
  await expect(page.getByText("First note.")).toBeVisible()

  // Tap the dimmed strip above the full sheet -> collapse to the peek bar: the list
  // is gone, the header bar stays, and the resize control flips to Expand.
  await page.getByTestId("comments-sheet-backdrop").tap({ position: { x: 180, y: 36 } })
  await expect(page.getByText("First note.")).toHaveCount(0)
  await expect(page.getByText("Comments", { exact: true })).toBeVisible()
  await expect(page.getByTestId("comments-sheet-resize")).toHaveAttribute("aria-label", "Expand")

  // Tap the peek bar's expand control -> the full list returns.
  await page.getByTestId("comments-sheet-resize").tap()
  await expect(page.getByText("First note.")).toBeVisible()
})
