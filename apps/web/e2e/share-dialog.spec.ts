import { expect, test } from "@playwright/test"
import { publishArtifact, signUp } from "./helpers"

// The artifact share dialog (built on the Dialog primitive + RoleSelect), driven
// through stable test-ids. One self-contained test so the FIRST signup is the
// workspace owner (the share affordance is owner-only) on the throwaway DB.

test("owner shares an artifact, changes the role, and removes the member", async ({
  page,
  browser,
}) => {
  await signUp(page) // first account on the fresh DB = workspace owner

  // A second registered user to share with, created in an isolated session so it
  // doesn't disturb the owner's page (and so it's an editor, not the owner).
  const ctx = await browser.newContext()
  const viewerPage = await ctx.newPage()
  const teammate = await signUp(viewerPage)

  const id = await publishArtifact(page) // owner publishes (link visibility)

  // A non-owner (the editor) opens the artifact: no share affordance.
  await viewerPage.goto(`/a/${id}`)
  await expect(viewerPage.getByTestId("share-trigger")).toBeHidden()

  // The owner opens the dialog: starts empty.
  await page.goto(`/a/${id}`)
  await page.getByTestId("share-trigger").click()
  await expect(page.getByTestId("share-email")).toBeVisible()
  await expect(page.getByTestId("share-empty")).toBeVisible()

  // Share with the teammate as a commenter.
  await page.getByTestId("share-email").fill(teammate)
  await page.getByTestId("share-role").locator("select").selectOption("commenter")
  await page.getByTestId("share-add").click()

  const row = page.locator('[data-testid^="share-member-row-"]')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(teammate)
  await expect(row.locator("select")).toHaveValue("commenter")

  // Promote them to editor.
  await page.locator('[data-testid^="share-member-role-"] select').selectOption("editor")
  await expect(row.locator("select")).toHaveValue("editor")

  // Remove them: back to the empty state.
  await page.locator('[data-testid^="share-member-remove-"]').click()
  await expect(page.getByTestId("share-empty")).toBeVisible()

  await ctx.close()
})
