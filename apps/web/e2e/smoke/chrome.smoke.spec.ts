import { expect, test } from "../fixtures"

// App chrome: the theme system (design-token canary) and the notification panel.

test("a theme switch applies and persists across reload", async ({ owner }) => {
  const html = owner.locator("html")
  await owner.getByTestId("user-menu-trigger").click()
  await owner.getByTestId("theme-option-dark").click()
  await expect(html).toHaveClass(/dark/)

  // The choice is persisted to localStorage and survives a reload.
  await owner.reload()
  await expect(html).toHaveClass(/dark/)
})

test("the notification bell opens its panel", async ({ owner }) => {
  await owner.getByTestId("notif-bell").click()
  // Scoped to the popover: the bell row itself also carries a "Notifications"
  // label (clipped in the collapsed rail, but still in the DOM).
  await expect(
    owner.locator('[data-slot="popover-content"]').getByText("Notifications", { exact: true }),
  ).toBeVisible()
})
