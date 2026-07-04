import { expect, publishArtifact, test } from "../fixtures"

// The artifact share dialog (Dialog primitive + RoleSelect) in depth: a non-owner
// has no share affordance; the owner shares, promotes, and removes a member.
test("owner shares an artifact, changes the role, and removes the member", async ({
  owner,
  secondUser,
}) => {
  const id = await publishArtifact(owner) // owner publishes (link visibility)

  // The non-owner (second user) opens the artifact: no share affordance.
  await secondUser.page.goto(`/artifacts/${id}`)
  await expect(secondUser.page.getByTestId("share-trigger")).toBeHidden()

  // The owner opens the dialog: the roster starts with themselves — the
  // publisher is written as the owner-member at creation.
  await owner.goto(`/artifacts/${id}`)
  await owner.getByTestId("share-trigger").click()
  await expect(owner.getByTestId("share-email")).toBeVisible()
  const rows = owner.locator('[data-testid^="share-member-row-"]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("(you)")

  // Share with the teammate as a commenter.
  await owner.getByTestId("share-email").fill(secondUser.email)
  await owner.getByTestId("share-role").click()
  await owner.getByRole("option", { name: "Commenter", exact: true }).click()
  await owner.getByTestId("share-add").click()

  const teammate = rows.filter({ hasNotText: "(you)" })
  await expect(rows).toHaveCount(2)
  await expect(teammate).not.toContainText(secondUser.email) // handle leads; the private email never renders
  await expect(teammate.locator('[data-testid^="share-member-role-"]')).toContainText("Commenter")

  // Promote them to editor.
  await teammate.locator('[data-testid^="share-member-role-"]').click()
  await owner.getByRole("option", { name: "Editor", exact: true }).click()
  await expect(teammate.locator('[data-testid^="share-member-role-"]')).toContainText("Editor")

  // Remove them: back to just the owner.
  await teammate.locator('[data-testid^="share-member-remove-"]').click()
  await expect(rows).toHaveCount(1)
})
