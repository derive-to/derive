import { expect, test } from "@playwright/test"
import { signUp } from "./helpers"

// The app chrome (header / user menu / notification bell), driven purely through
// stable test-ids. The theme test is the one agent-browser couldn't do reliably:
// Playwright dispatches real pointer events, so the Radix dropdown selects.

test("the user menu switches through all four themes", async ({ page }) => {
  await signUp(page)
  const html = page.locator("html")

  // The menu stays open by design so several themes can be tried in a row.
  await page.getByTestId("user-menu-trigger").click()
  for (const theme of ["light", "dark", "dusk", "paper"]) {
    await page.getByTestId(`theme-option-${theme}`).click()
    await expect(html).toHaveAttribute("data-theme", theme)
  }
  // The choice survives a reload (persisted to localStorage).
  await page.reload()
  await expect(html).toHaveAttribute("data-theme", "paper")
})

test("the notification bell opens an empty panel", async ({ page }) => {
  await signUp(page)
  await page.getByTestId("notif-bell").click()
  await expect(page.getByText("Notifications", { exact: true })).toBeVisible()
  // exact, so it doesn't collide with the empty library's "Nothing yet. Publish…"
  await expect(page.getByText("Nothing yet", { exact: true })).toBeVisible()
})

test("sign out returns to the login screen", async ({ page }) => {
  await signUp(page)
  await page.getByTestId("user-menu-trigger").click()
  await page.getByTestId("menu-signout").click()
  await expect(page).toHaveURL(/\/login/)
})
