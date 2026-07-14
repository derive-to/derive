import { Buffer } from "node:buffer"
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
  // Seed the profile hand-off state through the real API: a v1 profile stub, a
  // workspace Brandprint pointing at it, and an open proposal standing in for the
  // agent's build.
  const profileId = await publishArtifact(
    owner,
    "index.html",
    "<h1>Brand profile</h1><p>Not generated yet.</p>",
    "text/html",
  )
  const colRes = await owner.request.post("/v1/collections", { data: { title: "Brandprint" } })
  expect(colRes.ok(), `collection create: ${colRes.status()} ${await colRes.text()}`).toBeTruthy()
  const col = await colRes.json()
  const setRes = await owner.request.patch("/v1/workspace/settings", {
    data: { brandprint: { collectionId: col.id, profileId } },
  })
  expect(setRes.ok(), `settings patch: ${setRes.status()} ${await setRes.text()}`).toBeTruthy()
  const echo = await (await owner.request.get("/v1/workspace/settings")).json()
  expect(
    echo.brandprint?.profileId,
    `settings round-trip: ${JSON.stringify(echo.brandprint ?? null)}`,
  ).toBe(profileId)
  const propRes = await owner.request.post(`/v1/artifacts/${profileId}/proposals`, {
    multipart: {
      file: {
        name: "index.html",
        mimeType: "text/html",
        buffer: Buffer.from("<h1>Proposed profile</h1>"),
      },
    },
  })
  expect(propRes.ok(), `proposal: ${propRes.status()} ${await propRes.text()}`).toBeTruthy()

  // The seeding above went around the app, so the persisted query cache (settings
  // are Infinity-fresh) still holds the pre-seed state. Clear it BEFORE the app
  // boots on the next load — an in-page clear races the persister's throttled
  // flush. Real flows write through the app's mutations, which invalidate.
  await owner.addInitScript(() => window.localStorage.clear())
  await owner.goto("/brandprint")
  await owner.getByTestId("brandprint-profile-review").click()
  // The ?review deep link must open the review overlay on the proposal — not strand
  // the reviewer on the live version, which for a pending profile is the v1 stub.
  await expect(owner).toHaveURL(/review=true/)
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
