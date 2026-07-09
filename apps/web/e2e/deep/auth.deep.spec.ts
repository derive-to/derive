import { expect, signUp, test } from "../fixtures"

// The Login surface in depth: mode toggle, bad-credentials error, and the happy
// create-account path — all driven through stable test-ids on the Card/Input/Button.

test("the toggle switches between sign in and create account", async ({ page }) => {
  await page.goto("/login")
  // Sign-in mode: no name field, the submit reads "Sign in".
  await expect(page.getByTestId("login-name")).toBeHidden()
  await expect(page.getByTestId("login-submit")).toHaveText("Sign in")
  // Switch to create-account.
  await page.getByTestId("login-toggle").click()
  await expect(page.getByTestId("login-name")).toBeVisible()
  await expect(page.getByTestId("login-submit")).toHaveText("Create account")
})

test("a sign-in with unknown credentials shows an error and stays on /login", async ({ page }) => {
  await page.goto("/login")
  await page.getByTestId("login-email").fill("nobody@derive.test")
  await page.getByTestId("login-password").fill("wrong-password-123")
  await page.getByTestId("login-submit").click()
  await expect(page.getByTestId("login-error")).toBeVisible()
  await expect(page).toHaveURL(/\/login/)
})

test("creating an account signs in and leaves the login page", async ({ page }) => {
  await signUp(page) // drives login-toggle / login-name / login-email / login-password / login-submit
  await expect(page).not.toHaveURL(/\/login/)
})

test("password managers are invited on credentials and suppressed elsewhere", async ({ page }) => {
  // Credential fields declare autocomplete/type and must NOT carry the ignore
  // attr — 1Password filling your login is the point.
  await page.goto("/login")
  await expect(page.getByTestId("login-email")).not.toHaveAttribute("data-1p-ignore")

  // Any other field (here: the library filter) suppresses the manager popup.
  await signUp(page)
  await expect(page.getByTestId("library-search")).toHaveAttribute("data-1p-ignore", "true")
})
