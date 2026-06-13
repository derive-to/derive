import { expect, proposeEdit, publishArtifact, test } from "../fixtures"

// A teammate proposes an edit; the owner opens the review overlay and approves it.
test("owner approves a proposed change", async ({ owner, secondUser }) => {
  const shortId = await publishArtifact(owner)
  await proposeEdit(secondUser.page.request, shortId, "Tighten the intro", "# Doc\n\ntighter intro")

  await owner.goto(`/a/${shortId}`)
  await owner.getByTestId("artifact-more").click()
  await owner.getByTestId("artifact-review").click()
  await expect(owner.getByTestId("review-title")).toBeVisible()

  await owner.getByTestId("review-approve").click()
  await owner.getByTestId("review-approve-confirm").click()
  await expect(owner.getByText("Approved", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  })
})
