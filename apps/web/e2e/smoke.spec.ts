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
  await owner.getByTestId("library-view-collections").click()
  await owner.getByTestId("collections-new").click()
  await owner.getByTestId("collections-new-input").fill(name)
  await owner.getByTestId("collections-new-input").press("Enter")

  // Creating drops you into the new collection, so its header is right here. It is
  // unstarred, so the rail has no Starred group yet.
  await expect(owner.getByTestId("collection-star")).toHaveAttribute("aria-pressed", "false")
  await expect(owner.getByTestId("sidebar-starred")).toHaveCount(0)

  await owner.getByTestId("collection-star").click()
  await expect(owner.getByTestId("collection-star")).toHaveAttribute("aria-pressed", "true")

  // The rail now carries a Starred group holding exactly this one. (Matched by testid,
  // not text: the star button itself reads "Starred" when active.)
  await expect(owner.getByTestId("sidebar-starred")).toBeVisible()
  await expect(owner.getByRole("link", { name })).toHaveCount(1)

  // Unstarring empties the group entirely rather than leaving a bare heading — a
  // workspace with nothing starred opens on two nav rows.
  await owner.getByTestId("collection-star").click()
  await expect(owner.getByTestId("collection-star")).toHaveAttribute("aria-pressed", "false")
  await expect(owner.getByTestId("sidebar-starred")).toHaveCount(0)
  await expect(owner.getByRole("link", { name })).toHaveCount(0)
})

test("Collections is a digest of the week, then an alphabetical index", async ({ owner }) => {
  await owner.goto("/")
  const name = `Shelf ${Date.now()}`
  await owner.getByTestId("library-view-collections").click()
  await owner.getByTestId("collections-new").click()
  await owner.getByTestId("collections-new-input").fill(name)
  await owner.getByTestId("collections-new-input").press("Enter")
  // Creating opens the collection; its header names it.
  await expect(owner.getByTestId("collection-star")).toBeVisible()
  const colId = new URL(owner.url()).searchParams.get("collection")

  await owner.goto("/?view=collections")
  // A brand-new empty collection is one index line — never a digest entry (no activity),
  // and never an apology about its contents.
  await expect(owner.getByTestId("collections-index")).toBeVisible()
  await expect(owner.getByTestId(`index-open-${colId}`)).toBeVisible()
  await expect(owner.getByTestId(`digest-entry-${colId}`)).toHaveCount(0)
  await expect(owner.getByText("Nothing here is visible to you")).toHaveCount(0)

  // The Collections view IS the page: the artifact grid must not render underneath it.
  await expect(owner.locator('[data-testid^="artifact-card-open-"]')).toHaveCount(0)

  // Starring works from the index row, optimistically.
  await owner.getByTestId(`collection-star-${colId}`).click()
  await expect(owner.getByTestId(`collection-star-${colId}`)).toHaveAttribute(
    "aria-pressed",
    "true",
  )

  // The view rides the URL, so it survives a reload and can be linked.
  await owner.reload()
  await expect(owner.getByTestId("collections-index")).toBeVisible()

  // Switching back to Artifacts leaves the Collections view entirely.
  await owner.getByTestId("library-view-artifacts").click()
  await expect(owner.getByTestId("collections-index")).toHaveCount(0)
})

test("a card states three facts, not nine", async ({ owner }) => {
  const id = await publishArtifact(owner, "diet.md", "# Diet\n\nbody")
  await owner.goto("/")
  const card = owner.getByTestId(`artifact-card-open-${id}`)
  await expect(card).toBeVisible()

  // The version number and the type prefix are gone: the state line is the relative
  // time alone. `v1`/`HTML ·` would both match this.
  await expect(card).not.toContainText("v1")
  await expect(card).not.toContainText("·")

  // Every card names its author, yours included. Hiding it on your own work made a
  // missing chip ambiguous — "you made it" and "we don't know who did" looked alike.
  await expect(owner.getByTestId(`artifact-card-author-${id}`)).toBeVisible()

  // No view count, and no separate proposal/comment counts — a quiet document says
  // nothing at all in the meta row.
  await expect(owner.getByTestId("needs-you")).toHaveCount(0)
})

test("Grid or List is a preference the app remembers, not the route's choice", async ({
  owner,
}) => {
  await publishArtifact(owner, "layout.md", "# Layout\n\nbody")
  await owner.goto("/")
  await expect(owner.getByTestId("library-display")).toBeVisible()

  // Grid is the default: the render is the point.
  await owner.getByTestId("library-display").click()
  await owner.getByRole("menuitemradio", { name: "List" }).click()

  // Reload — the choice survives, which is what makes it a preference rather than a
  // per-visit toggle the route can override.
  await owner.reload()
  await owner.getByTestId("library-display").click()
  await expect(owner.getByRole("menuitemradio", { name: "List" })).toHaveAttribute(
    "aria-checked",
    "true",
  )
})

test("a shelf with fresh work leads the digest, covers and all", async ({ owner }) => {
  const shortId = await publishArtifact(owner, "cover.md", "# Cover\n\nbody")
  await owner.goto("/")
  const name = `Shelf ${Date.now()}`
  await owner.getByTestId("library-view-collections").click()
  await owner.getByTestId("collections-new").click()
  await owner.getByTestId("collections-new-input").fill(name)
  await owner.getByTestId("collections-new-input").press("Enter")
  await expect(owner.getByTestId("collection-star")).toBeVisible()
  const colId = new URL(owner.url()).searchParams.get("collection")
  const put = await owner.request.put(`/v1/collections/${colId}/items/${shortId}`)
  expect(put.ok(), `add item: ${put.status()}`).toBeTruthy()

  await owner.goto("/?view=collections")
  // Fresh work this week ⇒ a digest entry with the artifact's actual cover on it.
  const entry = owner.getByTestId(`digest-entry-${colId}`)
  await expect(entry).toBeVisible()
  await expect(entry.locator(`iframe[src*="${shortId}"], img[src*="${shortId}"]`)).toHaveCount(1)

  // The index carries the ledger line for the same shelf: a count, not a claim.
  await expect(owner.getByTestId(`index-open-${colId}`)).toBeVisible()

  // One shape, no knobs: the Display menu does not render on this view.
  await expect(owner.getByTestId("library-display")).toHaveCount(0)
})

test("the current page keeps its selected state under the pointer", async ({ owner }) => {
  await owner.goto("/")
  const bgOf = (l: ReturnType<typeof owner.getByTestId>) =>
    l.evaluate((el) => getComputedStyle(el.closest("a,button") ?? el).backgroundColor)

  const current = owner.getByTestId("sidebar-all")
  await expect(current).toBeVisible()
  const currentRest = await bgOf(current)

  // The bug this pins: `hover:bg-*` outranks `data-active:bg-*` on specificity — the
  // `:where()` Tailwind wraps data variants in contributes none — so the rail used to
  // repaint the current page's raised chip with the idle-row grey the moment you
  // pointed at it. Reordering can't fix that; the hover has to be scoped
  // (`not-data-active:`). See apps/web/src/lib/interaction.ts.
  //
  // Read the SETTLED colour, not a polled one: the row transitions over 100ms, and a
  // retrying matcher passes on the first frame — before the (wrong) colour lands.
  await current.hover()
  await owner.waitForTimeout(400)
  expect(await bgOf(current), "the active row changed colour on hover").toBe(currentRest)

  // …and the scoping didn't just disable hover everywhere: an idle row still washes.
  const idle = owner.getByTestId("nav-contexts")
  const idleRest = await bgOf(idle)
  await idle.hover()
  await owner.waitForTimeout(400)
  expect(await bgOf(idle), "an idle row stopped responding to hover").not.toBe(idleRest)
})

test("a collection says where you are, and the way back is the trail", async ({ owner }) => {
  const shortId = await publishArtifact(owner, "in-col.md", "# In a collection\n\nbody")
  await owner.goto("/")
  await owner.getByTestId("library-view-collections").click()
  await owner.getByTestId("collections-new").click()
  await owner.getByTestId("collections-new-input").fill(`Shelf ${Date.now()}`)
  await owner.getByTestId("collections-new-input").press("Enter")
  await expect(owner.getByTestId("collection-share")).toBeVisible()
  const colId = new URL(owner.url()).searchParams.get("collection")
  const put = await owner.request.put(`/v1/collections/${colId}/items/${shortId}`)
  expect(put.ok(), `add item: ${put.status()}`).toBeTruthy()

  // The header answers "where am I" AND "how do I get out". It used to answer only the
  // first, with the way out an `×` chip over in the toolbar.
  await owner.goto(`/?collection=${colId}`)
  const home = owner.getByTestId("crumb-0")
  await expect(home).toHaveText("Library")
  await home.click()
  await expect(owner).toHaveURL(/\/$|\/\?/)
  await expect(owner.getByTestId("collection-share")).toHaveCount(0)
  // The chip it replaced is gone rather than living alongside it.
  await expect(owner.getByTestId("library-clear-filter")).toHaveCount(0)
})
