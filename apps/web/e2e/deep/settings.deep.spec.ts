import { expect, test } from "../fixtures"

// The Settings surface (Workspace › General / Members, Webhooks, Agents) in depth.
// The `owner` fixture is the workspace owner (admin controls are owner-only); the
// `secondUser` fixture supplies a real teammate to add as a member.
test("owner manages workspace, webhooks, and agents through the sections", async ({
  owner,
  secondUser,
}) => {
  // Member / webhook / agent removal confirm via the in-app ConfirmDialog.
  await owner.goto("/settings")

  // --- Workspace › General (Profile is the default; General holds the name) ---
  await owner.getByTestId("settings-tab-general").click()
  await owner.getByTestId("workspace-name").fill("Acme HQ")
  await owner.getByTestId("workspace-save").click()
  await expect(owner.getByTestId("workspace-name")).toHaveValue("Acme HQ")

  // --- Workspace › Members: add the teammate as a Viewer → owner + teammate = 2 rows. ---
  await owner.getByTestId("settings-tab-members").click()
  await owner.getByTestId("member-email").fill(secondUser.email)
  await owner.getByTestId("member-role").click()
  await owner.getByRole("option", { name: "Viewer", exact: true }).click()
  await owner.getByTestId("member-add").click()
  await expect(owner.locator('[data-testid^="member-row-"]')).toHaveCount(2)

  // --- Webhooks tab ---
  await owner.getByTestId("settings-tab-webhooks").click()
  await owner.getByTestId("webhook-url").fill("https://example.com/hook")
  await owner.getByTestId("webhook-add").click()
  await expect(owner.locator('[data-testid^="webhook-row-"]')).toHaveCount(1)
  await owner.locator('[data-testid^="webhook-remove-"]').click()
  await owner.getByTestId("confirm-dialog-confirm").click()
  await expect(owner.locator('[data-testid^="webhook-row-"]')).toHaveCount(0)

  // --- Agents tab ---
  await owner.getByTestId("settings-tab-agents").click()
  await owner.getByTestId("agent-name").fill("Claude")
  await owner.getByTestId("agent-add").click()
  await expect(owner.getByTestId("agent-token")).toBeVisible() // shown exactly once
  await owner.getByTestId("agent-token-done").click()
  await expect(owner.locator('[data-testid^="agent-row-"]')).toHaveCount(1)
  await owner.locator('[data-testid^="agent-remove-"]').click()
  await owner.getByTestId("confirm-dialog-confirm").click()
  await expect(owner.locator('[data-testid^="agent-row-"]')).toHaveCount(0)
})
