import { expect, publishArtifact, test } from "../fixtures"

// Deep coverage of the library home: title search, the favorites filter (star →
// filter → un-star drops), and creating a collection from the sidebar. The
// `owner` fixture lands signed in on the library; title defaults to the filename
// (minus extension), and search is a case-insensitive title match server-side.

test("search narrows the grid to the matching title", async ({ owner }) => {
  const alpha = await publishArtifact(owner, "alpha-report.md", "# Alpha\n\nbody")
  const beta = await publishArtifact(owner, "beta-notes.md", "# Beta\n\nbody")

  await owner.goto("/")
  await expect(owner.getByTestId(`library-card-${alpha}`)).toBeVisible()
  await expect(owner.getByTestId(`library-card-${beta}`)).toBeVisible()

  // Typing a title (debounced into a server query) drops the non-match.
  await owner.getByTestId("library-search").fill("alpha")
  await expect(owner.getByTestId(`library-card-${alpha}`)).toBeVisible()
  await expect(owner.getByTestId(`library-card-${beta}`)).toBeHidden()

  // Clearing the search brings both back.
  await owner.getByTestId("library-search").clear()
  await expect(owner.getByTestId(`library-card-${beta}`)).toBeVisible()
})

test("favorite a card, filter to favorites, then un-star to drop it", async ({ owner }) => {
  const id = await publishArtifact(owner, "fav-me.md", "# Fav\n\nbody")
  await owner.goto("/")

  // Star it. The sidebar favorites count reaching 1 confirms the server committed
  // (the summary refreshes after the favorite POST) — a race-free gate.
  await owner.getByTestId(`library-favorite-${id}`).click()
  await expect(owner.getByTestId("nav-favorites")).toContainText("1")

  // The Favorites view shows it.
  await owner.getByTestId("nav-favorites").click()
  await expect(owner.getByTestId(`library-card-${id}`)).toBeVisible()

  // Un-starring inside the Favorites view drops the card from the grid.
  await owner.getByTestId(`library-favorite-${id}`).click()
  await expect(owner.getByTestId(`library-card-${id}`)).toBeHidden()
})

test("create a collection from the sidebar", async ({ owner }) => {
  await owner.goto("/")

  await owner.getByTestId("new-collection").click()
  await owner.getByTestId("collection-name").fill("Specs")
  await owner.getByTestId("collection-name").press("Enter")

  // The new collection appears in the sidebar and is selected, showing its
  // empty-state hint (collections are populated from the artifact 📁 menu).
  await expect(owner.locator('[data-testid^="nav-collection-"]')).toHaveCount(1)
  await expect(owner.getByText(/This collection is empty/)).toBeVisible()
})
