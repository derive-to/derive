import { expect, proposeEdit, publishArtifact, test } from "../fixtures"

// The review overlay (full-screen, tabbed Proposed/Current/Diff + decision bar)
// in depth. The `owner` fixture approves; the `secondUser` (an editor on the
// link-visible artifact) authors the proposals, so owner ≠ author and can decide.
test("owner reviews proposals: toggles views, approves one, requests changes on another", async ({
  owner,
  secondUser,
}) => {
  const id = await publishArtifact(owner)
  await proposeEdit(secondUser.page.request, id, "Tighten the intro", "# Doc\n\ntighter intro")
  await proposeEdit(secondUser.page.request, id, "Fix the footer", "# Doc\n\nbody\n\nfixed footer")

  await owner.goto(`/a/${id}`)
  // The artifact header surfaces a Review button while proposals are open.
  await owner.getByTestId("artifact-review").click()

  // Overlay is up: identity, view toggle, and both proposals in the rail.
  await expect(owner.getByTestId("review-title")).toBeVisible()
  await expect(owner.getByTestId("review-view-proposed")).toBeVisible()
  await expect(owner.locator('[data-testid^="review-proposal-"]')).toHaveCount(2)

  // View toggle: proposed (iframe) → diff (source) → current (iframe).
  await expect(owner.getByTestId("review-frame")).toBeVisible()
  await owner.getByTestId("review-view-diff").click()
  await expect(owner.getByTestId("review-diff")).toBeVisible()
  await owner.getByTestId("review-view-current").click()
  await expect(owner.getByTestId("review-frame")).toBeVisible()
  await owner.getByTestId("review-view-proposed").click()

  // Approve the active proposal → it publishes; its rail badge flips to Approved.
  await owner.getByTestId("review-approve").click()
  await owner.getByTestId("review-approve-confirm").click()
  await expect(owner.getByText("Approved", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  })
  await expect(owner.locator('[data-testid^="review-proposal-"]')).toHaveCount(2) // 1 approved + 1 open

  // Select the still-open proposal (the Awaiting section is first) and request
  // changes on it, with a note.
  await owner.locator('[data-testid^="review-proposal-"]').first().click()
  await expect(owner.getByTestId("review-request-changes")).toBeEnabled()
  await owner.getByTestId("review-request-changes").click()
  await owner.getByTestId("review-note").fill("Use the shared footer component instead.")
  await owner.getByTestId("review-send-request").click()

  // Both decided now: the decision controls are gone and the overlay stays up.
  await expect(owner.getByTestId("review-approve")).toBeHidden()
  await expect(owner.getByTestId("review-close")).toBeVisible()
})
