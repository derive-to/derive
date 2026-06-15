import { expect, publishArtifact, test } from "../fixtures"

// Owner shares an artifact with a teammate; the member row lands in the dialog.
test("owner shares an artifact and the member appears", async ({ owner, secondUser }) => {
  const shortId = await publishArtifact(owner)
  await owner.goto(`/a/${shortId}`)

  await owner.getByTestId("share-trigger").click()
  await expect(owner.getByTestId("share-empty")).toBeVisible()

  await owner.getByTestId("share-email").fill(secondUser.email)
  await owner.getByTestId("share-role").locator("select").selectOption("commenter")
  await owner.getByTestId("share-add").click()

  const row = owner.locator('[data-testid^="share-member-row-"]')
  await expect(row).toHaveCount(1)
  // You still share BY email (the input above), but the member row identifies people
  // by name / @handle and never echoes the email back (read-path PII hardening).
  await expect(row).toContainText("Second User")
  await expect(row).not.toContainText(secondUser.email)
})
