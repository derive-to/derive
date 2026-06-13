import { expect, signUp, test } from "../fixtures"

// Auth is the front door: if signup or signout breaks, nothing else is reachable.
// These two run on a plain page (no `owner` fixture) because they ARE the signup.

test("sign up creates an account and lands in the app", async ({ page }) => {
  await signUp(page)
  await expect(page).not.toHaveURL(/\/login/)
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible()
})

test("sign out returns to the login screen", async ({ page }) => {
  await signUp(page)
  await page.getByTestId("user-menu-trigger").click()
  await page.getByTestId("menu-signout").click()
  await expect(page).toHaveURL(/\/login/)
})
