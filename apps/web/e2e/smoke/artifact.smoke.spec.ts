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
