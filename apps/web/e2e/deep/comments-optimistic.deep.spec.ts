import { expect, test } from "@playwright/test"
import { openArtifact, publishArtifact, signUp } from "../helpers"

// The optimistic comment loop: a comment shows the instant you send it (before the
// server responds) and rolls back out if the post fails. Locks the perf/UX fix so
// the "couldn't tell if it posted" regression can't come back.
test.beforeEach(async ({ page }) => {
  await signUp(page)
  const shortId = await publishArtifact(page, "doc.md", "# Title\n\nThe body paragraph here.")
  await openArtifact(page, shortId)
})

test("a comment appears optimistically, before the server responds", async ({ page }) => {
  // Hold the POST open so the only way the comment can be on screen is the
  // optimistic insert — the server hasn't answered yet.
  let release: () => void = () => {}
  const held = new Promise<void>((r) => {
    release = r
  })
  await page.route("**/v1/artifacts/*/comments", async (route) => {
    if (route.request().method() === "POST") await held
    await route.continue()
  })

  await page.getByTestId("comment-new").click()
  await page.getByTestId("composer-input").fill("Optimistic hello.")
  await page.getByTestId("composer-submit").click()

  // Visible while the POST is still in flight (10s expect timeout >> any real round trip).
  await expect(page.getByText("Optimistic hello.")).toBeVisible()
  release() // let the server finish; the real row reconciles in
  await expect(page.getByText("Optimistic hello.")).toBeVisible()
})

test("a failed post rolls the optimistic comment back out", async ({ page }) => {
  await page.route("**/v1/artifacts/*/comments", async (route) => {
    if (route.request().method() === "POST")
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: '{"error":"nope"}',
      })
    return route.continue()
  })

  await page.getByTestId("comment-new").click()
  await page.getByTestId("composer-input").fill("Doomed comment.")
  await page.getByTestId("composer-submit").click()

  // It may flash in optimistically, but once the post fails it must be gone.
  await expect(page.getByText("Doomed comment.")).toHaveCount(0, { timeout: 10_000 })
})
