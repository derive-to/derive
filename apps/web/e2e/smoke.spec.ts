import {
  activateThread,
  addComment,
  expect,
  openArtifact,
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
  // A settled thread folds to one line in the activity stream.
  await expect(owner.getByTestId(/^resolved-thread-/)).toBeVisible()

  // Re-fetch the library home so it picks up the freshly published artifact.
  await owner.goto("/")
  await expect(owner.getByTestId(`artifact-card-open-${shortId}`)).toBeVisible()
})

test("starting a workflow creates a visible, version-pinned run", async ({ owner }) => {
  const manifest = {
    schema: "derive.linked-bundle/v1",
    purpose: "Keep internal docs aligned with code changes.",
    members: [],
    diagrams: [
      {
        id: "docs-update",
        title: "Update internal docs",
        type: "graph",
        nodes: [
          {
            id: "update-docs",
            label: "Update docs",
            state: "pending",
            note: "Inspect the code change and publish the necessary documentation update.",
          },
        ],
        edges: [],
      },
    ],
  }
  const workflow = {
    schema: "derive.workflow/v1",
    purpose: manifest.purpose,
    diagrams: [
      {
        id: "docs-update",
        entry: "update-docs",
        nodes: [
          {
            id: "update-docs",
            kind: "context",
            context_ref: "docs-updater",
            instruction: "Inspect the supplied code change and update the affected internal docs.",
            result: "A published documentation update grounded in the code change",
            terminal: true,
          },
        ],
        routes: [],
        scenarios: [
          {
            id: "expected",
            kind: "expected",
            path: ["update-docs"],
            outcome: "The internal docs reflect the code change",
          },
          {
            id: "failure",
            kind: "failure",
            path: ["update-docs"],
            outcome: "The failed attempt remains visible without changing the docs",
          },
        ],
      },
    ],
  }
  const html =
    `<!doctype html><html><body><h1>Internal docs update</h1>` +
    `<script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify(manifest)}</script>` +
    `<script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify(workflow)}</script>` +
    `</body></html>`
  const shortId = await publishArtifact(owner, "workflow.html", html, "text/html")

  await owner.goto("/settings/automations")
  await expect(owner).toHaveURL(/\/workflows$/)
  await expect(owner.getByTestId("nav-workflows")).toHaveAttribute("aria-current", "page")
  await expect(owner.getByRole("heading", { level: 1, name: "Workflows" })).toHaveCount(1)
  await expect(
    owner.getByRole("heading", { level: 2, name: "Coordinated workflows" }),
  ).toBeVisible()
  await expect(
    owner.getByRole("heading", { level: 2, name: "Single-agent workflows" }),
  ).toBeVisible()
  const directoryRow = owner
    .getByTestId("workflow-row")
    .filter({ hasText: "Keep internal docs aligned with code changes." })
  await expect(directoryRow).toContainText("Keep internal docs aligned with code changes.")
  await expect(directoryRow).toContainText("1 Context step")
  await directoryRow.click()
  await expect(owner).toHaveURL(new RegExp(`/artifacts/.+${shortId}`))
  await expect(owner.getByTestId("workflow-preview")).toBeVisible()
  await expect(owner.getByText("No runs yet.", { exact: false })).toBeVisible()
  await owner.getByTestId("workflow-run-docs-update").click()
  await owner.getByTestId("workflow-run-copy").click()

  const runs = owner.getByTestId("workflow-runs")
  await expect(runs.getByText("Queued", { exact: true })).toBeVisible()
  await expect(runs.getByText("Update internal docs", { exact: true })).toBeVisible()
  await expect(runs.getByText("Definition v1", { exact: true })).toBeVisible()
  await expect(runs.getByText("Local copy", { exact: true })).toBeVisible()
  await expect(runs.getByText("Waiting for an Agent to claim this run.")).toBeVisible()
})

test("a Ready graph exposes a bounded GitHub Actions harness on mobile", async ({ owner }) => {
  const manifest = {
    schema: "derive.linked-bundle/v1",
    purpose: "Settle one reviewed Context step through GitHub Actions.",
    members: [],
    diagrams: [
      {
        id: "github-proof",
        title: "GitHub proof",
        type: "graph",
        nodes: [{ id: "prove", label: "Prove the run", state: "pending" }],
        edges: [],
      },
    ],
  }
  const workflow = {
    schema: "derive.workflow/v1",
    purpose: manifest.purpose,
    diagrams: [
      {
        id: "github-proof",
        entry: "prove",
        nodes: [
          {
            id: "prove",
            kind: "context",
            context_ref: "github-proof-agent",
            instruction: "Publish one proof Artifact.",
            result: "A reviewed proof Artifact",
            terminal: true,
          },
        ],
        routes: [],
        scenarios: [
          {
            id: "expected",
            kind: "expected",
            path: ["prove"],
            outcome: "The proof is published",
          },
          {
            id: "failure",
            kind: "failure",
            path: ["prove"],
            outcome: "The failed Context step is visible and the run stops",
          },
        ],
      },
    ],
  }
  const html =
    `<!doctype html><html><body><h1>GitHub proof</h1>` +
    `<script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify(manifest)}</script>` +
    `<script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify(workflow)}</script>` +
    `</body></html>`
  const shortId = await publishArtifact(owner, "github-proof.html", html, "text/html")
  const gate = await owner.request.patch("/v1/workspace/settings", {
    data: { automateBeta: true },
  })
  expect(gate.ok(), "workspace Automate gate should opt in explicitly").toBeTruthy()

  await owner.route("**/v1/connections?*", async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connections:
          url.searchParams.get("scope") === "workspace"
            ? [
                {
                  id: "con_github_proof",
                  user_id: "workspace",
                  broker: "github_app",
                  toolkit: "github",
                  scope: "workspace",
                  kind: "github_app",
                  scopes_label: "Niftory · selected repositories",
                  status: "active",
                  created_at: "2026-08-31T12:00:00.000Z",
                },
              ]
            : [],
      }),
    })
  })
  await owner.route("**/v1/github", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        connected: true,
        app_slug: "derive",
        app_owner_login: "derive-to",
        app_permissions_state: "ready",
        app_webhook_state: "ready",
        app_settings_url: null,
        can_manage_app: false,
        accounts: [
          {
            installation_id: "9988",
            account_login: "Niftory",
            connection_id: "con_github_proof",
            state: "active",
            permissions_state: "ready",
            permissions_url: null,
          },
        ],
      }),
    }),
  )
  let dispatchBody: Record<string, unknown> | null = null
  await owner.route(`**/v1/artifacts/${shortId}/workflow-run`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    dispatchBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        runId: "wfr_github_proof",
        prompt: "",
        github: {
          runId: "778899",
          url: "https://github.com/Niftory/sift/actions/runs/778899",
        },
      }),
    })
  })

  await owner.setViewportSize({ width: 390, height: 844 })
  await owner.goto(`/artifacts/${shortId}`)
  await owner.getByTestId("workflow-run-github-proof").click()
  await owner.getByTestId("workflow-harness-github").click()
  await expect(owner.getByTestId("workflow-github-setup")).toBeVisible()
  await expect(owner.getByText("No prompt or Derive token is sent")).toBeVisible()
  await expect
    .poll(() => owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true)

  await owner.getByTestId("workflow-github-repository").fill("Niftory/sift")
  await owner.getByTestId("workflow-github-ref").fill("main")
  await owner.getByTestId("workflow-github-workflow").fill("derive-graph-runner.yml")
  await owner.getByTestId("workflow-github-run").click()
  await expect.poll(() => dispatchBody).not.toBeNull()
  expect(dispatchBody).toEqual({
    diagramId: "github-proof",
    delivery: "github",
    github: {
      connectionId: "con_github_proof",
      owner: "Niftory",
      repo: "sift",
      workflow: "derive-graph-runner.yml",
      ref: "main",
    },
  })
  expect(JSON.stringify(dispatchBody)).not.toContain("prompt")
  expect(JSON.stringify(dispatchBody)).not.toContain("GitHub proof")
})

test("a cached screenshot still becomes a visible library thumbnail", async ({ owner }) => {
  const shortId = await publishArtifact(owner, "cached-thumb.md", "# Cached thumbnail")

  // Reproduce the production race: the screenshot is already decoded in the browser
  // cache before the card mounts and its non-bubbling load event is already gone, while
  // the library reports that a static preview exists.
  await owner.addInitScript(() => {
    const addEventListener = HTMLImageElement.prototype.addEventListener
    HTMLImageElement.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === "load") return
      Reflect.apply(addEventListener, this, [type, listener, options])
    }
    Object.defineProperties(HTMLImageElement.prototype, {
      complete: { configurable: true, get: () => true },
      naturalWidth: { configurable: true, get: () => 1200 },
    })
  })
  await owner.route("**/v1/artifacts?**", async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as {
      artifacts: Array<{ short_id: string; has_preview?: boolean }>
      next_cursor: string | null
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        artifacts: body.artifacts.map((artifact) =>
          artifact.short_id === shortId ? { ...artifact, has_preview: true } : artifact,
        ),
      },
    })
  })

  await owner.goto("/")
  const image = owner.locator(`img[src="/v1/og/${shortId}?v=1"]`)
  await expect(image).toBeVisible()
  await expect(image).toHaveCSS("opacity", "1")
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

test("a signed-in link holder gets guest chrome and can copy into their workspace", async ({
  owner,
  secondUser,
}) => {
  const shortId = await publishArtifact(owner, "guest.md", "# Someone else's document")
  await secondUser.page.goto(`/artifacts/${shortId}`)

  await expect(secondUser.page.getByTestId("artifact-make-copy")).toBeVisible()
  await expect(secondUser.page.getByTestId("share-trigger")).toHaveCount(0)
  await expect(secondUser.page.getByTestId("artifact-inline-edit")).toHaveCount(0)
  await expect(secondUser.page.getByTestId("artifact-show-comments")).toHaveCount(0)
  await expect(secondUser.page.getByTestId("library-menu")).toHaveCount(0)

  await secondUser.page.getByTestId("artifact-more").click()
  await expect(secondUser.page.getByTestId("artifact-report")).toBeVisible()
  await expect(secondUser.page.getByTestId("artifact-create-from")).toHaveCount(0)
  await expect(secondUser.page.getByTestId("artifact-collections")).toHaveCount(0)
  await expect(secondUser.page.getByTestId("artifact-insights")).toHaveCount(0)
  await secondUser.page.keyboard.press("Escape")

  await secondUser.page.getByTestId("artifact-make-copy").click()
  await expect(secondUser.page).not.toHaveURL(new RegExp(shortId))
  await expect(secondUser.page.getByTestId("share-trigger")).toBeVisible()
  await expect(secondUser.page.getByTestId("artifact-make-copy")).toHaveCount(0)
})

test("guest comment and edit links keep only their granted collaboration", async ({
  owner,
  secondUser,
}) => {
  const shortId = await publishArtifact(
    owner,
    "guest-roles.html",
    "<h1>Guest roles</h1>",
    "text/html",
  )
  const setLinkRole = async (linkRole: "commenter" | "editor") => {
    const response = await owner.request.patch(`/v1/artifacts/${shortId}/access`, {
      data: { linkRole },
    })
    expect(response.ok(), `access patch: ${response.status()}`).toBeTruthy()
  }

  await setLinkRole("commenter")
  await secondUser.page.goto(`/artifacts/${shortId}`)
  await expect(secondUser.page.getByTestId("artifact-show-comments")).toBeVisible()
  // A commenter gets no edit affordance — suggesting a change is a comment.
  await expect(secondUser.page.getByTestId("artifact-inline-edit")).toHaveCount(0)
  await expect(secondUser.page.getByTestId("share-trigger")).toHaveCount(0)

  await setLinkRole("editor")
  await secondUser.page.reload()
  await expect(secondUser.page.getByTestId("artifact-inline-edit")).toContainText("Edit")
  await expect(secondUser.page.getByTestId("share-trigger")).toHaveCount(0)
})

test("brandprint panel flips from the hand-off brief to live when the build lands", async ({
  owner,
}) => {
  // The profile hand-off state, seeded through the real API: a v1 profile stub and a
  // workspace Brandprint pointing at it. v1 is always the intake's stub; the agent's
  // publish (v2) IS the reveal.
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

  // That seeding went around the app, and workspace settings are Infinity-fresh in the
  // query cache the app restores from IndexedDB on boot (lib/persist.ts) — so drop the
  // persisted entry before the app starts, or it paints the pre-seed state and never
  // refetches. Real flows write through the app's mutations, which invalidate.
  await owner.addInitScript(() => indexedDB.deleteDatabase("keyval-store"))
  await owner.goto("/brandprint")
  await expect(owner.getByTestId("brandprint-handoff")).toBeVisible()

  // The build lands as v2 — live, like every agent write now. The panel polls the
  // artifact and flips to the live state without a reload.
  const built = await owner.request.post(`/v1/artifacts/${profileId}/versions`, {
    multipart: {
      file: {
        name: "index.html",
        mimeType: "text/html",
        buffer: Buffer.from("<h1>Built profile</h1>"),
      },
      message: "the build",
    },
  })
  expect(built.ok(), `build publish: ${built.status()}`).toBeTruthy()
  await expect(owner.getByTestId("brandprint-profile-live")).toBeVisible({ timeout: 15_000 })
  await expect(owner.getByTestId("brandprint-profile-frame")).toBeVisible()
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

test("settings destinations and their retired paths resolve", async ({ owner }) => {
  // The rail is down to the two destinations that are places. Everything else is a
  // filter, a setting, or reachable from the surface it belongs to.
  await owner.goto("/")
  await expect(owner.getByTestId("sidebar-all")).toBeVisible()
  await expect(owner.getByTestId("nav-people")).toHaveCount(0)
  await expect(owner.getByTestId("nav-brandprint")).toHaveCount(0)

  // Brandprint is a settings section, reachable by its own path.
  await owner.goto("/settings/brandprint")
  await expect(owner.getByTestId("settings-tab-brandprint")).toHaveAttribute("aria-current", "page")

  // People is a standalone directory page; its retired settings path redirects out.
  await owner.goto("/people")
  await expect(owner).toHaveURL(/\/people$/)
  await expect(owner.getByTestId("people-search")).toBeVisible()
  await owner.goto("/settings/people")
  await expect(owner).toHaveURL(/\/people$/)
  await expect(owner.getByTestId("people-search")).toBeVisible()

  // The old Brandprint path keeps working — bookmarks, and links agents have already emitted.
  await owner.goto("/brandprint")
  await expect(owner).toHaveURL(/\/settings\/brandprint$/)

  // GitHub is a standard integration now. Its retired standalone settings path lands on the
  // shared connection surface, with no repository-mirroring controls or collection workflow.
  await owner.goto("/settings/github")
  await expect(owner).toHaveURL(/\/settings\/integrations$/)
  await expect(owner.getByRole("heading", { name: "GitHub", exact: true })).toBeVisible()
  await expect(owner.getByTestId("github-setup")).toBeVisible()
  await expect(owner.getByTestId("toggle-github-post")).toHaveCount(0)
  await expect(owner.getByTestId("toggle-github-mirror")).toHaveCount(0)
  await expect(owner.getByTestId("toggle-github-preview-link")).toHaveCount(0)
})

test("Artifacts is the front door and Archived remains one of its filters", async ({ owner }) => {
  await owner.goto("/")
  await expect(owner.getByTestId("sidebar-all")).toContainText("Artifacts")
  await expect(owner.getByRole("heading", { name: /^Artifacts\b/ })).toBeVisible()
  await expect(owner.getByTestId("library-view")).toHaveAttribute("aria-label", "Artifact views")
  await expect(owner.getByTestId("library-view-artifacts")).toHaveText("All")
  await expect(owner.getByTestId("library-view-collections")).toHaveText("Collections")
  await expect(owner).toHaveTitle("Artifacts · Derive")
  await expect(owner.getByTestId("nav-archived")).toHaveCount(0)

  await owner.getByTestId("library-filter").click()
  await owner.getByTestId("library-filter-archived").click()
  await expect(owner).toHaveURL(/\/archived$/)
  await expect(owner.getByRole("heading", { name: /^Artifacts\b/ })).toBeVisible()
  await expect(owner.getByTestId("library-filter")).toHaveAttribute(
    "aria-label",
    "Filter: Archived",
  )
  await expect(owner.getByTestId("library-view-artifacts")).toHaveAttribute("data-state", "on")

  await owner.getByTestId("library-filter").click()
  await owner.getByTestId("library-filter-all").click()
  await expect(owner).toHaveURL(/\/$|\/\?/)
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
  await expect(owner).toHaveTitle("Collections · Derive")
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

  // Switching back to All leaves the Collections view entirely.
  await owner.getByTestId("library-view-artifacts").click()
  await expect(owner.getByTestId("collections-index")).toHaveCount(0)
  await expect(owner).toHaveTitle("Artifacts · Derive")
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

  // No view count, and no separate comment counts — a quiet document says
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
  await expect(home).toHaveText("Artifacts")
  await home.click()
  await expect(owner).toHaveURL(/\/$|\/\?/)
  await expect(owner.getByTestId("collection-share")).toHaveCount(0)
  // The chip it replaced is gone rather than living alongside it.
  await expect(owner.getByTestId("library-clear-filter")).toHaveCount(0)
})

test("Artifacts is a drop target, and + New never hides", async ({ owner }) => {
  await owner.goto("/")
  // The one primary action is STABLE: visible even while the connect-agent card shows
  // (a fresh workspace used to have no visible way to create anything by hand).
  await expect(owner.getByTestId("library-new")).toBeVisible()

  // Drag a file over the window: the whole app says "drop it".
  const drag = (type: "dragenter" | "drop", withFile: boolean) =>
    owner.evaluate(
      ([t, f]) => {
        const dt = new DataTransfer()
        if (f)
          dt.items.add(
            new File(["# dropped\n\nvia drag"], "dropped-note.md", { type: "text/markdown" }),
          )
        window.dispatchEvent(new DragEvent(t as string, { dataTransfer: dt, bubbles: true }))
      },
      [type, withFile] as const,
    )
  await drag("dragenter", true)
  await expect(owner.getByTestId("library-drop-overlay")).toBeVisible()
  await drag("drop", true)
  await expect(owner.getByTestId("library-drop-overlay")).toHaveCount(0)
  // The drop published for real: the artifact lands in the grid.
  await expect(owner.getByText("dropped-note")).toBeVisible()

  // A text drag (no files) never summons the overlay.
  await drag("dragenter", false)
  await expect(owner.getByTestId("library-drop-overlay")).toHaveCount(0)
})
