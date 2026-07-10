import { addComment, expect, publishArtifact, signUp, test } from "../fixtures"

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
  await owner.getByRole("menuitemradio", { name: "Commenter", exact: true }).click()
  await owner.getByTestId("share-add").click()

  const teammate = rows.filter({ hasNotText: "(you)" })
  await expect(rows).toHaveCount(2)
  await expect(teammate).not.toContainText(secondUser.email) // handle leads; the private email never renders
  await expect(teammate.locator('[data-testid^="share-member-role-"]')).toContainText("Commenter")

  // Promote them to editor.
  await teammate.locator('[data-testid^="share-member-role-"]').click()
  await owner.getByRole("menuitemradio", { name: "Editor", exact: true }).click()
  await expect(teammate.locator('[data-testid^="share-member-role-"]')).toContainText("Editor")

  // Remove them: back to just the owner.
  await teammate.locator('[data-testid^="share-member-remove-"]').click()
  await expect(rows).toHaveCount(1)
})

// Share to an email with NO account: a pending invite row appears and an accept
// link goes out by email; the invitee signs up under that email and one click
// lands them on the document at the granted role (commenter here — they comment).
test("share to an unknown email invites; signup + accept lands on the doc", async ({
  owner,
  browser,
}) => {
  const id = await publishArtifact(owner, "invited.md", "# Invited doc\n\nGrist for a comment.")
  const email = `fool-${Date.now()}@e2e.test`

  await owner.goto(`/artifacts/${id}`)
  await owner.getByTestId("share-trigger").click()
  await owner.getByTestId("share-email").fill(email)
  await owner.getByTestId("share-role").click()
  await owner.getByRole("menuitemradio", { name: "Commenter", exact: true }).click()
  const put = owner.waitForResponse(
    (r) => r.url().includes("/members") && r.request().method() === "PUT",
  )
  await owner.getByTestId("share-add").click()
  const res = (await (await put).json()) as { kind: string; accept_url: string }
  expect(res.kind).toBe("invite")
  // The dialog shows the pending-invite row (with its revoke affordance).
  await expect(owner.locator('[data-testid^="share-invite-row-"]')).toHaveCount(1)
  await expect(owner.locator('[data-testid^="share-invite-row-"]')).toContainText(email)

  // The invitee signs up under the invited email in their own browser, then
  // follows the emailed link. Exact email match: no mismatch warning.
  const ctx = await browser.newContext()
  const invitee = await ctx.newPage()
  await signUp(invitee, "Fool Guest", email)
  await invitee.goto(new URL(res.accept_url).pathname)
  await expect(invitee.getByTestId("invite-accept")).toBeVisible()
  await expect(invitee.getByTestId("invite-mismatch")).toBeHidden()
  await invitee.getByTestId("invite-accept").click()
  await expect(invitee).toHaveURL(new RegExp(`/artifacts/.*${id}`), { timeout: 10_000 })

  // The grant is real: a commenter share lets them comment.
  await addComment(invitee, "Invited and commenting.")

  // Back on the owner's side: reopen the dialog (it stayed open through the
  // invite) so the roster reloads — the pending row became a member row.
  await owner.keyboard.press("Escape")
  await owner.getByTestId("share-trigger").click()
  await expect(owner.locator('[data-testid^="share-invite-row-"]')).toHaveCount(0)
  await expect(owner.locator('[data-testid^="share-member-row-"]')).toHaveCount(2)
  await ctx.close()
})
