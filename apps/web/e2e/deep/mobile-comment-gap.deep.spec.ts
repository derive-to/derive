import { devices, expect, test } from "@playwright/test"
import { publishArtifact, signUp } from "../helpers"

// Regression: after posting a comment on a phone the document column must not
// reserve more bottom space than the comment sheet actually occupies. A static
// `pb-[50vh]` reservation left a large black dead-band below the document
// whenever the sheet rested at its slim "peek" height (the state you land in
// after submit / collapse). The reservation must track the sheet's real height.
test.use({ ...devices["Pixel 7"] })

// How much empty space sits between where the document column ends (its reserved
// padding) and the top of the comment sheet. This IS the black band.
async function deadBandPx(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const iframe = document.querySelector("iframe")
    // Walk up from the document to the flex column that carries the reservation.
    let el: HTMLElement | null = iframe?.parentElement ?? null
    let paddingBottom = 0
    while (el) {
      const pb = Number.parseFloat(getComputedStyle(el).paddingBottom) || 0
      if (pb > 24) {
        paddingBottom = pb
        break
      }
      el = el.parentElement
    }
    const sheet = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Comments"]')
    const sheetHeight = sheet ? sheet.getBoundingClientRect().height : 0
    return { paddingBottom, sheetHeight, band: Math.max(0, paddingBottom - sheetHeight) }
  })
}

test("no black dead-band under the document after commenting on mobile", async ({ page }) => {
  await signUp(page)
  // A short doc makes the reserved bottom space impossible to hide behind scroll.
  const shortId = await publishArtifact(page, "m.md", "# Doc\n\nA paragraph to comment on here.")
  await page.goto(`/artifacts/${shortId}`)
  await page.waitForTimeout(2000)

  // Post a comment; the sheet opens to the full list to show it.
  await page.frameLocator("iframe").getByText("A paragraph to comment").tap()
  await page.getByTestId("mobile-comment-start").tap()
  await page.getByTestId("composer-input").fill("First note.")
  await page.getByTestId("composer-submit").tap()
  await expect(page.getByText("First note.")).toBeVisible()

  // Collapse to the peek bar — the resting state you're left in after commenting.
  await page.getByTestId("comments-sheet-backdrop").tap({ position: { x: 180, y: 36 } })
  await expect(page.getByTestId("comments-sheet-resize")).toHaveAttribute("aria-label", "Expand")
  await page.waitForTimeout(400) // let the padding transition settle

  const { paddingBottom, sheetHeight, band } = await deadBandPx(page)
  // The reserved padding should hug the sheet's real height, not overshoot it.
  // Allow a small tolerance for the grip/rounding; the bug reserved ~50vh (~380px
  // of black) above a ~74px peek bar.
  expect(band, `padding-bottom ${paddingBottom}px vs sheet ${sheetHeight}px`).toBeLessThan(48)
})
