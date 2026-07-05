import { expect, publishArtifact, test } from "../fixtures"

// Owner shares an artifact with a teammate; the member row lands in the dialog.
test("owner shares an artifact and the member appears", async ({ owner, secondUser }) => {
  const shortId = await publishArtifact(owner)
  await owner.goto(`/artifacts/${shortId}`)

  await owner.getByTestId("share-trigger").click()
  // The roster opens with the publisher's own owner row.
  const rows = owner.locator('[data-testid^="share-member-row-"]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("(you)")

  await owner.getByTestId("share-email").fill(secondUser.email)
  await owner.getByTestId("share-role").click()
  await owner.getByRole("option", { name: "Commenter", exact: true }).click()
  await owner.getByTestId("share-add").click()

  const row = rows.filter({ hasText: "Second User" })
  await expect(rows).toHaveCount(2)
  // You still share BY email (the input above), but the member row identifies people
  // by name / @handle and never echoes the email back (read-path PII hardening).
  await expect(row).toHaveCount(1)
  await expect(row).not.toContainText(secondUser.email)
})
