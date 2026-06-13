import { Buffer } from "node:buffer"
import { type APIRequestContext, expect, test } from "@playwright/test"
import { publishArtifact, signUp } from "./helpers"

// Propose a candidate version on `shortId` (commenter+; an editor teammate here).
async function propose(req: APIRequestContext, shortId: string, message: string, body: string) {
  const res = await req.post(`/v1/artifacts/${shortId}/proposals`, {
    multipart: {
      file: { name: "edit.md", mimeType: "text/markdown", buffer: Buffer.from(body) },
      message,
    },
  })
  expect(res.ok(), `propose failed: ${res.status()}`).toBeTruthy()
}

// The review overlay (full-screen, tabbed Proposed/Current/Diff + decision bar),
// driven through stable test-ids. One self-contained test so the FIRST signup is
// the workspace owner (only an editor/owner can approve).
test("owner reviews proposals: toggles views, approves one, requests changes on another", async ({
  page,
  browser,
}) => {
  await signUp(page) // first account = workspace owner

  // An editor teammate authors the proposals (owner ≠ author, so owner can approve).
  const ctx = await browser.newContext()
  const teammatePage = await ctx.newPage()
  await signUp(teammatePage)

  const id = await publishArtifact(page)
  await propose(teammatePage.request, id, "Tighten the intro", "# Doc\n\ntighter intro")
  await propose(teammatePage.request, id, "Fix the footer", "# Doc\n\nbody\n\nfixed footer")
  await ctx.close()

  await page.goto(`/a/${id}`)
  // The artifact header surfaces a Review button while proposals are open.
  await page.getByRole("button", { name: /Review/ }).click()

  // Overlay is up: identity, view toggle, and both proposals in the rail.
  await expect(page.getByTestId("review-title")).toBeVisible()
  await expect(page.getByTestId("review-view-proposed")).toBeVisible()
  await expect(page.locator('[data-testid^="review-proposal-"]')).toHaveCount(2)

  // View toggle: proposed (iframe) → diff (source) → current (iframe).
  await expect(page.getByTestId("review-frame")).toBeVisible()
  await page.getByTestId("review-view-diff").click()
  await expect(page.getByTestId("review-diff")).toBeVisible()
  await page.getByTestId("review-view-current").click()
  await expect(page.getByTestId("review-frame")).toBeVisible()
  await page.getByTestId("review-view-proposed").click()

  // Approve the active proposal → it publishes; its rail badge flips to Approved.
  await page.getByTestId("review-approve").click()
  await page.getByTestId("review-approve-confirm").click()
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-testid^="review-proposal-"]')).toHaveCount(2) // 1 approved + 1 open

  // Select the still-open proposal (the Awaiting section is first) and request
  // changes on it, with a note.
  await page.locator('[data-testid^="review-proposal-"]').first().click()
  await expect(page.getByTestId("review-request-changes")).toBeEnabled()
  await page.getByTestId("review-request-changes").click()
  await page.getByTestId("review-note").fill("Use the shared footer component instead.")
  await page.getByTestId("review-send-request").click()

  // Both decided now: the decision controls are gone and the overlay stays up.
  await expect(page.getByTestId("review-approve")).toBeHidden()
  await expect(page.getByTestId("review-close")).toBeVisible()
})
