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
