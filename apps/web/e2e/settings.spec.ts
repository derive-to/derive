import { expect, test } from "@playwright/test"
import { signUp } from "./helpers"

// The Settings surface (tabbed: Workspace / Webhooks / Agents), driven through
// stable test-ids. One self-contained test so the FIRST signup is the workspace
// owner (the admin controls are owner-only) on the throwaway DB.

test("owner manages workspace, webhooks, and agents through the tabs", async ({
  page,
  browser,
}) => {
  await signUp(page) // first account on the fresh DB = workspace owner

  // A second registered user to add as a member (isolated session).
  const ctx = await browser.newContext()
  const teammate = await signUp(await ctx.newPage())
  await ctx.close()

  // Member / webhook / agent removal go through a native confirm().
  page.on("dialog", (d) => d.accept())

  await page.goto("/settings")

  // --- Workspace tab (default) ---
  await expect(page.getByTestId("settings-tab-workspace")).toBeVisible()
  await page.getByTestId("workspace-name").fill("Acme HQ")
  await page.getByTestId("workspace-save").click()
  await expect(page.getByTestId("workspace-name")).toHaveValue("Acme HQ")

  // Add the teammate as a Viewer → owner + teammate = 2 member rows.
  await page.getByTestId("member-email").fill(teammate)
  await page.getByTestId("member-role").selectOption("commenter")
  await page.getByTestId("member-add").click()
  await expect(page.locator('[data-testid^="member-row-"]')).toHaveCount(2)

  // --- Webhooks tab ---
  await page.getByTestId("settings-tab-webhooks").click()
  await page.getByTestId("webhook-url").fill("https://example.com/hook")
  await page.getByTestId("webhook-add").click()
  await expect(page.locator('[data-testid^="webhook-row-"]')).toHaveCount(1)
  await page.locator('[data-testid^="webhook-remove-"]').click()
  await expect(page.locator('[data-testid^="webhook-row-"]')).toHaveCount(0)

  // --- Agents tab ---
  await page.getByTestId("settings-tab-agents").click()
  await page.getByTestId("agent-name").fill("Claude")
  await page.getByTestId("agent-add").click()
  await expect(page.getByTestId("agent-token")).toBeVisible() // shown exactly once
  await page.getByTestId("agent-token-done").click()
  await expect(page.locator('[data-testid^="agent-row-"]')).toHaveCount(1)
  await page.locator('[data-testid^="agent-remove-"]').click()
  await expect(page.locator('[data-testid^="agent-row-"]')).toHaveCount(0)
})
