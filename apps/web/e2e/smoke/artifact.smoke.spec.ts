import {
  activateThread,
  addComment,
  expect,
  openArtifact,
  publishArtifact,
  test,
} from "../fixtures"

// The core product loop, end to end: publish a doc, open it, comment, resolve.
test("publish, open, comment, and resolve", async ({ owner }) => {
  const shortId = await publishArtifact(owner)
  await openArtifact(owner, shortId)

  await addComment(owner, "Looks good, shipping.")

  // Activate the thread, then resolve it — it collapses into the Resolved section.
  await activateThread(owner, "Looks good, shipping.")
  await owner.getByTestId("comment-resolve").click()
  await expect(owner.getByText(/Resolved \(\d+\)/)).toBeVisible()
})

// A failed comment post must be RECOVERABLE, not silently lost. The optimistic row rolls
// back, but a Retry toast re-sends the exact text — the rejected mutation still holds it.
// (Regression guard for the text-loss this replaced, found by driving the loop under an
// injected 500: submitNew closes the composer optimistically, so a blip used to eat the draft.)
test("a failed comment offers a Retry that recovers the text", async ({ owner }) => {
  const shortId = await publishArtifact(owner)
  await openArtifact(owner, shortId)

  // Fail only the FIRST create-POST; let the Retry through.
  let failNext = true
  await owner.route(
    (url) => url.pathname === `/v1/artifacts/${shortId}/comments`,
    (route) => {
      if (route.request().method() === "POST" && failNext) {
        failNext = false
        return route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
      }
      return route.continue()
    },
  )

  const body = "Don't lose this to a blip."
  await owner.getByTestId("comment-new").click()
  await owner.getByTestId("composer-input").fill(body)
  await owner.getByTestId("composer-submit").click()

  // The optimistic row rolled back; the Retry toast is the recovery path.
  const retry = owner.getByRole("button", { name: "Retry" })
  await expect(retry).toBeVisible()
  await retry.click()

  // One tap re-sends the exact comment — it lands for real.
  await expect(owner.getByText(body)).toBeVisible()
})
