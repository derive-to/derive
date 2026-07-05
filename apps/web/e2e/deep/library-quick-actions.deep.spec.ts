import { expect, publishArtifact, test } from "../fixtures"

// Deep coverage of the card ⋯ quick-actions menu: tag, add to a collection, and
// delete straight from the library, without opening the artifact. The menu is
// role-gated per item off the list payload's my_role — the regression this pins
// is the list endpoint dropping my_role, which silently hides tags/delete.

test("tag from the card menu; un-tagging on the tag view drops the card", async ({ owner }) => {
  const id = await publishArtifact(owner, "quick-tag.md", "# Quick tag\n\nbody")
  await owner.goto("/")

  await owner.getByTestId(`artifact-card-more-${id}`).click()
  await owner.getByTestId(`artifact-card-tags-${id}`).click()
  await owner.getByTestId("tag-new-input").fill("quick")
  await owner.getByTestId("tag-add").click()
  await expect(owner.getByTestId("tag-remove-quick")).toBeVisible() // server round-trip done
  await owner.keyboard.press("Escape")

  // The chip lands on the card without a reload (the list cache is patched).
  await expect(owner.getByTestId("artifact-card-tag-quick")).toBeVisible()

  // On the tag view, removing the active tag refetches the list and the card drops.
  await owner.getByTestId("artifact-card-tag-quick").click()
  await expect(owner.getByTestId(`artifact-card-open-${id}`)).toBeVisible()
  await owner.getByTestId(`artifact-card-more-${id}`).click()
  await owner.getByTestId(`artifact-card-tags-${id}`).click()
  await owner.getByTestId("tag-remove-quick").click()
  await owner.keyboard.press("Escape")
  await expect(owner.getByTestId(`artifact-card-open-${id}`)).toBeHidden()
})

test("add to a new collection from the card menu", async ({ owner }) => {
  const id = await publishArtifact(owner, "quick-col.md", "# Quick col\n\nbody")
  await owner.goto("/")

  await owner.getByTestId(`artifact-card-more-${id}`).click()
  await owner.getByTestId(`artifact-card-collections-${id}`).click()
  await owner.getByTestId("collection-new-input").fill("Quick picks")
  await owner.getByTestId("collection-add").click()
  // Created + joined in one step: the row appears checked.
  await expect(owner.getByRole("button", { name: "Quick picks" })).toBeVisible()
  await owner.keyboard.press("Escape")

  // The sidebar picks the collection up (collections cache invalidated); the
  // collection view lists the card.
  await owner.locator('[data-testid^="sidebar-collection-"]', { hasText: "Quick picks" }).click()
  await expect(owner.getByTestId(`artifact-card-open-${id}`)).toBeVisible()
})

test("delete from the card menu stays confirm-gated", async ({ owner }) => {
  const id = await publishArtifact(owner, "quick-del.md", "# Quick del\n\nbody")
  await owner.goto("/")

  await owner.getByTestId(`artifact-card-more-${id}`).click()
  await owner.getByTestId(`artifact-card-delete-${id}`).click()
  // Nothing is deleted until the ConfirmDialog is accepted.
  await expect(owner.getByTestId(`artifact-card-open-${id}`)).toBeVisible()
  await owner.getByTestId("library-delete-confirm").click()
  await expect(owner.getByTestId(`artifact-card-open-${id}`)).toBeHidden()
})
