import { expect, publishArtifact, test } from "../fixtures"

// A published artifact is discoverable in the library grid and opens from it.
test("a published artifact appears in the library and opens", async ({ owner }) => {
  const shortId = await publishArtifact(owner, "library-smoke.md", "# Library Smoke\n\nbody text")

  // Re-fetch the library home so it picks up the freshly published artifact.
  await owner.goto("/")
  const card = owner.getByTestId(`artifact-card-open-${shortId}`)
  await expect(card).toBeVisible()

  await card.click()
  await expect(owner.getByText("Comments", { exact: true })).toBeVisible()
})
