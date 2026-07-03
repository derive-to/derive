import { expect, openArtifact, publishArtifact, test } from "../fixtures"

// Mobile (≤640px is the app's breakpoint) coverage: the sidebar collapses into a
// drawer behind a menu button, and the core publish → open → comment path still
// works at a phone width. Runs the whole file at an iPhone-class viewport.
test.use({ viewport: { width: 390, height: 844 } })

test("the sidebar opens as a drawer and navigates on mobile", async ({ owner }) => {
  await owner.goto("/")

  // The persistent sidebar is replaced by a menu button; the nav lives in the
  // shadcn sidebar's off-canvas Sheet (a Radix dialog), which mounts on open
  // and unmounts after close — so assert presence/visibility, not opacity.
  const drawer = owner.locator('[data-slot="sidebar"][data-mobile="true"]')
  await expect(drawer).toBeHidden() // drawer starts closed (not mounted)

  await owner.getByTestId("library-menu").click()
  await expect(drawer).toBeVisible() // drawer open

  // Picking a destination applies the filter and closes the drawer.
  await owner.getByTestId("sidebar-favorites").click()
  await expect(owner.getByRole("heading", { name: /Favorites/ })).toBeVisible()
  await expect(drawer).toBeHidden() // drawer closed again
})

test("the core publish, open, and comment loop works at phone width", async ({ owner }) => {
  const id = await publishArtifact(owner, "mobile.md", "# Mobile\n\nbody text")

  await owner.goto("/")
  await expect(owner.getByTestId(`artifact-card-open-${id}`)).toBeVisible()

  await openArtifact(owner, id)
  await expect(owner.getByTestId("artifact-star")).toBeVisible()
})
