import { expect, openArtifact, publishArtifact, test } from "../fixtures"

// The composer's caret fix: the FIELD's own text is the visible text (so the
// caret can never detach from what you read), and the backdrop is an invisible
// metrics clone that paints only the mention tint boxes. These assert the
// invariants that keep it that way: layer colors, scroll sync through BOTH paths
// (the scroll event and the post-commit re-sync that fixes the clamp race), and
// the tint box actually painting behind a picked mention.

test.describe("composer caret layers", () => {
  test("field text is visible, the clone is transparent, and their scroll stays in sync while typing past the fold", async ({
    owner: page,
  }) => {
    const shortId = await publishArtifact(page)
    await openArtifact(page, shortId)
    await page.getByTestId("comment-new").click()

    const input = page.getByTestId("composer-input")
    await expect(input).toBeVisible()

    // The inversion itself: the textarea paints its text; the clone doesn't.
    const colors = await input.evaluate((el) => ({
      field: getComputedStyle(el).color,
      clone: getComputedStyle(el.previousElementSibling as Element).color,
    }))
    expect(colors.clone).toBe("rgba(0, 0, 0, 0)")
    expect(colors.field).not.toBe("rgba(0, 0, 0, 0)")

    // Overflow the box, then exercise both sync paths: a real scroll event, and
    // typing at the end (value commit → post-commit re-sync — the path whose
    // absence used to leave the visible text permanently one line off).
    await input.fill(Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n"))
    await input.evaluate((el) => {
      el.scrollTop = el.scrollHeight
      el.dispatchEvent(new Event("scroll"))
    })
    await input.press("End")
    await input.pressSequentially(" tail")
    await expect
      .poll(() =>
        input.evaluate((el) => {
          const clone = el.previousElementSibling as HTMLElement
          return Math.abs(el.scrollTop - clone.scrollTop)
        }),
      )
      .toBeLessThan(2)
  })

  test("Enter sends, Shift+Enter breaks the line (desktop chat grammar)", async ({
    owner: page,
  }) => {
    const shortId = await publishArtifact(page)
    await openArtifact(page, shortId)
    await page.getByTestId("comment-new").click()

    const input = page.getByTestId("composer-input")
    await input.pressSequentially("first line")
    await input.press("Shift+Enter")
    await input.pressSequentially("second line")
    await expect(input).toHaveValue("first line\nsecond line")

    await input.press("Enter")
    // Posted: the composer closes and the comment (both lines) renders as a card.
    await expect(page.getByTestId("composer-input")).toHaveCount(0)
    await expect(page.getByTestId("comment-card")).toContainText("first line")
  })

  test("picking a mention paints a tint box in the clone behind the visible tag", async ({
    owner: page,
  }) => {
    const shortId = await publishArtifact(page)
    await openArtifact(page, shortId)
    await page.getByTestId("comment-new").click()

    const input = page.getByTestId("composer-input")
    await input.fill("hey ")
    await input.pressSequentially("@E2E")
    // The directory popover offers the signed-up user; Enter inserts the tag.
    await expect(page.locator('[data-testid^="mention-option-"]').first()).toBeVisible()
    await input.press("Enter")

    const box = await input.evaluate((el) => {
      const span = (el.previousElementSibling as HTMLElement).querySelector(".mention-live")
      if (!span) return null
      const s = getComputedStyle(span)
      return { color: s.color, background: s.backgroundColor }
    })
    expect(box).not.toBeNull()
    expect(box?.color).toBe("rgba(0, 0, 0, 0)") // metrics only — never double-paints text
    expect(box?.background).not.toBe("rgba(0, 0, 0, 0)") // the tint is the visible signal
  })
})
