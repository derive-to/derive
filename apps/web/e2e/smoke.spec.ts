import {
  activateThread,
  addComment,
  expect,
  openArtifact,
  proposeEdit,
  publishArtifact,
  signUp,
  test,
} from "./fixtures"

/**
 * The whole product's smoke suite, one file: a fast, broad pass over the core
 * loop (auth, publish/comment/resolve, share, settings/theme). Each test is
 * independent — a fresh `owner`/`secondUser` via the fixtures, per the
 * project's isolation model — so the file still runs fully parallel. This is
 * the post-merge gate; anything deeper belongs in its own focused test file,
 * not back in a tiered smoke/deep split.
 */

test("sign up creates an account and sign out returns to login", async ({ page }) => {
  await signUp(page)
  await expect(page).not.toHaveURL(/\/login/)
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible()

  await page.getByTestId("user-menu-trigger").click()
  await page.getByTestId("menu-signout").click()
  await expect(page).toHaveURL(/\/login/)
})

test("publish, comment, resolve, and find it in the library", async ({ owner }) => {
  const shortId = await publishArtifact(owner, "smoke.md", "# Smoke\n\nbody text")
  await openArtifact(owner, shortId)

  await addComment(owner, "Looks good, shipping.")
  await activateThread(owner, "Looks good, shipping.")
  await owner.getByTestId("comment-resolve").click()
  await expect(owner.getByText(/Resolved \(\d+\)/)).toBeVisible()

  // Re-fetch the library home so it picks up the freshly published artifact.
  await owner.goto("/")
  await expect(owner.getByTestId(`artifact-card-open-${shortId}`)).toBeVisible()
})

test("owner shares an artifact and the member appears", async ({ owner, secondUser }) => {
  const shortId = await publishArtifact(owner)
  await owner.goto(`/artifacts/${shortId}`)

  await owner.getByTestId("share-trigger").click()
  await owner.getByTestId("share-email").fill(secondUser.email)
  await owner.getByTestId("share-role").click()
  await owner.getByRole("menuitemradio", { name: "Commenter", exact: true }).click()
  await owner.getByTestId("share-add").click()

  await expect(owner.locator('[data-testid^="share-member-row-"]')).toHaveCount(2)
})

test("brandprint 'Review & comment' opens the pending profile proposal", async ({ owner }) => {
  // The profile hand-off state, seeded through the real API: a v1 profile stub, a
  // workspace Brandprint pointing at it, and an open proposal standing in for the
  // agent's build.
  const profileId = await publishArtifact(
    owner,
    "index.html",
    "<h1>Brand profile</h1><p>Not generated yet.</p>",
    "text/html",
  )
  const col = await (
    await owner.request.post("/v1/collections", { data: { title: "Brandprint" } })
  ).json()
  // Write the pointer and read it back: a fresh account's personal workspace is
  // provisioned lazily, so the first write can land before the page's workspace is the
  // one it reads (publishArtifact retries for the same reason).
  await expect(async () => {
    const res = await owner.request.patch("/v1/workspace/settings", {
      data: { brandprint: { collectionId: col.id, profileId } },
    })
    expect(res.ok(), `settings patch: ${res.status()}`).toBeTruthy()
    const echo = await (await owner.request.get("/v1/workspace/settings")).json()
    expect(echo.brandprint?.profileId).toBe(profileId)
  }).toPass({ timeout: 10_000 })
  await proposeEdit(owner.request, profileId, "the build", "<h1>Proposed profile</h1>")

  // That seeding went around the app, and workspace settings are Infinity-fresh in the
  // query cache the app restores from IndexedDB on boot (lib/persist.ts) — so drop the
  // persisted entry before the app starts, or it paints the pre-seed state and never
  // refetches. Real flows write through the app's mutations, which invalidate.
  await owner.addInitScript(() => indexedDB.deleteDatabase("keyval-store"))
  await owner.goto("/brandprint")
  await owner.getByTestId("brandprint-profile-review").click()
  // The link names the proposal, and the overlay opens on it — landing on the live
  // version would show the reviewer the v1 stub they came here to replace.
  await expect(owner).toHaveURL(/review=p_/)
  await expect(owner.getByTestId("review-title")).toBeVisible()
  await expect(owner.getByTestId("review-frame")).toHaveAttribute("src", /\/p\//)
})

test("settings save and theme switch persist", async ({ owner }) => {
  await owner.goto("/settings")
  await owner.getByTestId("settings-tab-general").click()
  await owner.getByTestId("workspace-name").fill("Acme HQ")
  await owner.getByTestId("workspace-save").click()
  await expect(owner.getByTestId("workspace-name")).toHaveValue("Acme HQ")

  await owner.getByTestId("user-menu-trigger").click()
  await owner.getByTestId("theme-option-dark").click()
  await expect(owner.locator("html")).toHaveClass(/dark/)
  await owner.reload()
  await expect(owner.locator("html")).toHaveClass(/dark/)
})

test("Brandprint and People live in Settings, and their old paths still resolve", async ({
  owner,
}) => {
  // The rail is down to the two destinations that are places. Everything else is a
  // filter, a setting, or reachable from the surface it belongs to.
  await owner.goto("/")
  await expect(owner.getByTestId("sidebar-all")).toBeVisible()
  await expect(owner.getByTestId("nav-people")).toHaveCount(0)
  await expect(owner.getByTestId("nav-brandprint")).toHaveCount(0)

  // Both are settings sections now, reachable by their own path.
  await owner.goto("/settings/brandprint")
  await expect(owner.getByTestId("settings-tab-brandprint")).toHaveAttribute("aria-current", "page")
  await owner.goto("/settings/people")
  await expect(owner.getByTestId("settings-tab-people")).toHaveAttribute("aria-current", "page")
  await expect(owner.getByTestId("people-search")).toBeVisible()

  // The old paths keep working — bookmarks, and links agents have already emitted.
  await owner.goto("/brandprint")
  await expect(owner).toHaveURL(/\/settings\/brandprint$/)
  await owner.goto("/people")
  await expect(owner).toHaveURL(/\/settings\/people$/)
})

test("starring a collection pins it to the sidebar's Starred group", async ({ owner }) => {
  await owner.goto("/")
  const name = `Shelf ${Date.now()}`
  await owner.getByTestId("sidebar-new-collection").click()
  await owner.getByTestId("sidebar-new-collection-input").fill(name)
  await owner.getByTestId("sidebar-new-collection-input").press("Enter")

  // It lands in Collections, not Starred — the app's list, until you say otherwise.
  const row = owner.getByRole("link", { name }).first()
  await expect(row).toBeVisible()
  await row.click()

  await owner.getByTestId("collection-star").click()
  await expect(owner.getByTestId("collection-star")).toHaveAttribute("aria-pressed", "true")

  // The rail now carries a Starred group holding it, and it appears ONCE — the
  // Collections group below must not list it a second time. (Matched by testid, not
  // text: the star button itself reads "Starred" when active.)
  await expect(owner.getByTestId("sidebar-starred")).toBeVisible()
  await expect(owner.getByRole("link", { name })).toHaveCount(1)

  // Unstarring puts it back rather than losing it.
  await owner.getByTestId("collection-star").click()
  await expect(owner.getByTestId("collection-star")).toHaveAttribute("aria-pressed", "false")
  await expect(owner.getByTestId("sidebar-starred")).toHaveCount(0)
  await expect(owner.getByRole("link", { name })).toHaveCount(1)
})
