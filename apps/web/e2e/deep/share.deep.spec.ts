import { expect, publishArtifact, test } from "../fixtures"

// The artifact share dialog (Dialog primitive + RoleSelect) in depth: a non-owner
// has no share affordance; the owner shares, promotes, and removes a member.
test("owner shares an artifact, changes the role, and removes the member", async ({
  owner,
  secondUser,
}) => {
  const id = await publishArtifact(owner) // owner publishes (link visibility)

  // The non-owner (second user) opens the artifact: no share affordance.
  await secondUser.page.goto(`/a/${id}`)
  await expect(secondUser.page.getByTestId("share-trigger")).toBeHidden()

  // The owner opens the dialog: starts empty.
  await owner.goto(`/a/${id}`)
  await owner.getByTestId("share-trigger").click()
  await expect(owner.getByTestId("share-email")).toBeVisible()
  await expect(owner.getByTestId("share-empty")).toBeVisible()

  // Share with the teammate as a commenter.
  await owner.getByTestId("share-email").fill(secondUser.email)
  await owner.getByTestId("share-role").locator("select").selectOption("commenter")
  await owner.getByTestId("share-add").click()

  const row = owner.locator('[data-testid^="share-member-row-"]')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(secondUser.email)
  await expect(row.locator("select")).toHaveValue("commenter")

  // Promote them to editor.
  await owner.locator('[data-testid^="share-member-role-"] select').selectOption("editor")
  await expect(row.locator("select")).toHaveValue("editor")

  // Remove them: back to the empty state.
  await owner.locator('[data-testid^="share-member-remove-"]').click()
  await expect(owner.getByTestId("share-empty")).toBeVisible()
})
