import { expect, test } from "../fixtures"

// The app chrome (header / user menu / notification bell / theme switcher),
// driven purely through stable test-ids. The `owner` fixture lands us signed in.

test("the user menu switches between themes and the choice persists", async ({ owner }) => {
  const html = owner.locator("html")

  // The menu stays open by design so both themes can be tried in a row.
  // Themes render via the shadcn `.dark`/`.light` class on <html> (next-themes).
  await owner.getByTestId("user-menu-trigger").click()
  for (const theme of ["light", "dark"]) {
    await owner.getByTestId(`theme-option-${theme}`).click()
    await expect(html).toHaveClass(new RegExp(theme))
  }
  // The last choice survives a reload (persisted to localStorage).
  await owner.reload()
  await expect(html).toHaveClass(/dark/)
})

test("the System theme follows the OS preference, live", async ({ owner }) => {
  const html = owner.locator("html")
  await owner.emulateMedia({ colorScheme: "dark" })
  await owner.getByTestId("user-menu-trigger").click()
  await owner.getByTestId("theme-option-system").click()
  await expect(html).toHaveClass(/dark/)
  // Flipping the OS preference retints the app without a reload (next-themes'
  // media-query listener) — and the resolved theme survives one, via the
  // pre-paint boot script's matchMedia fallback.
  await owner.emulateMedia({ colorScheme: "light" })
  await expect(html).toHaveClass(/light/)
  await owner.reload()
  await expect(html).toHaveClass(/light/)
})

test("the notification bell opens an empty panel", async ({ owner }) => {
  await owner.getByTestId("notif-bell").click()
  // Scoped to the popover: the bell row on the rail also carries a "Notifications"
  // label, so an unscoped lookup would match two nodes.
  await expect(
    owner.locator('[data-slot="popover-content"]').getByText("Notifications", { exact: true }),
  ).toBeVisible()
  // exact, so it doesn't collide with the empty library's "Nothing yet. Publish…"
  await expect(owner.getByText("Nothing yet.", { exact: true })).toBeVisible()
})

test("sign out returns to the login screen", async ({ owner }) => {
  await owner.getByTestId("user-menu-trigger").click()
  await owner.getByTestId("menu-signout").click()
  await expect(owner).toHaveURL(/\/login/)
})

// Accessibility: icon-only chrome controls must expose an accessible name (added
// in the a11y pass). Located by ROLE + NAME, so a dropped aria-label fails here.
test("icon-only chrome controls expose accessible names", async ({ owner }) => {
  await expect(owner.getByRole("button", { name: "Search (⌘K)" })).toBeVisible()
  await expect(owner.getByRole("searchbox", { name: "Filter artifacts by title" })).toBeVisible()
})

test("the tab title follows the view", async ({ owner }) => {
  await expect(owner).toHaveTitle("Derive")
  await owner.getByTestId("library-tab-mine").click()
  await expect(owner).toHaveTitle("Created by me · Derive")
  await owner.goto("/people")
  await expect(owner).toHaveTitle("People · Derive")
  await owner.goto("/settings/members")
  await expect(owner).toHaveTitle("Members · Settings · Derive")
  // Back home restores the base title (the hook's unmount contract).
  await owner.goto("/")
  await expect(owner).toHaveTitle("Derive")
})
