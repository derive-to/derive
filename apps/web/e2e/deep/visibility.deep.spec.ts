import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"

// The sharing & visibility model through the real UI: the private
// default, the general-access picker (the share dialog's Google-Docs ladder),
// private (invite-only), and profile privacy. Server-side authz is pinned in
// apps/api/test/visibility.test.ts; this drives the surfaces.

// Publish WITHOUT a visibility — the spec subject is the default itself, so
// this deliberately bypasses the helper (which pins a visibility).
async function publishDefault(page: Page, name = "draft.md"): Promise<string> {
  let shortId = ""
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: { file: { name, mimeType: "text/markdown", buffer: Buffer.from("# Draft") } },
    })
    expect(res.ok()).toBeTruthy()
    shortId = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })
  return shortId
}

test("a default publish is private: invisible to another user until the link is opened up", async ({
  owner,
  secondUser,
}) => {
  const id = await publishDefault(owner)

  // The other user (their own workspace) can't open it.
  await secondUser.page.goto(`/artifacts/${id}`)
  await expect(secondUser.page.getByText("Draft")).toBeHidden()

  // The owner widens access to "Public" from the share dialog — the pick
  // applies instantly (no Save button); wait for the PATCH to land.
  await owner.goto(`/artifacts/${id}`)
  await owner.getByTestId("share-trigger").click()
  const saved = owner.waitForResponse((r) => r.url().includes("/visibility") && r.ok())
  await owner.getByTestId("share-visibility").click()
  await owner.getByRole("menuitemradio", { name: "Public", exact: true }).click()
  await saved

  // Now the second user can read it.
  await secondUser.page.reload()
  await expect(secondUser.page.getByText("Draft").first()).toBeVisible()
})

test("copy link puts the canonical URL on the clipboard", async ({ owner }) => {
  await owner.context().grantPermissions(["clipboard-read", "clipboard-write"])
  const id = await publishDefault(owner)
  await owner.goto(`/artifacts/${id}`)
  await owner.getByTestId("share-trigger").click()
  await owner.getByTestId("share-url-copy").click()
  await expect(owner.getByTestId("share-url-copy")).toContainText("Copied")
  const copied = await owner.evaluate(() => navigator.clipboard.readText())
  expect(copied).toMatch(new RegExp(`/artifacts/.*${id}`))
})

test("private hides an artifact from a workspace member until they're invited", async ({
  owner,
  secondUser,
}) => {
  // Publish private via the API, then drive the share dialog: the second user's
  // access flips from 404 to readable the moment they're invited. (Same-workspace
  // exclusion — a teammate who can't see a private draft — is pinned in the API
  // tests; standing up a shared workspace through the UI isn't worth the weight
  // here.)
  let id = ""
  await expect(async () => {
    const res = await owner.request.post("/v1/artifacts", {
      multipart: {
        file: { name: "secret.md", mimeType: "text/markdown", buffer: Buffer.from("# Secret") },
        visibility: "private",
      },
    })
    expect(res.ok()).toBeTruthy()
    id = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })

  await secondUser.page.goto(`/artifacts/${id}`)
  await expect(secondUser.page.getByText("Secret")).toBeHidden()

  // The owner's share dialog shows Private as the current access and them as
  // the owner-member; inviting the teammate opens it up.
  await owner.goto(`/artifacts/${id}`)
  await owner.getByTestId("share-trigger").click()
  await expect(owner.getByTestId("share-visibility")).toContainText("Private")
  await expect(owner.locator('[data-testid^="share-member-row-"]').first()).toContainText("(you)")
  await owner.getByTestId("share-email").fill(secondUser.email)
  await owner.getByTestId("share-add").click()
  await expect(owner.locator('[data-testid^="share-member-row-"]')).toHaveCount(2)

  await secondUser.page.reload()
  await expect(secondUser.page.getByText("Secret").first()).toBeVisible()
})

test("turning off the public profile hides it from strangers", async ({ owner, secondUser }) => {
  const me = (await (await owner.request.get("/v1/me")).json()) as {
    user: { username: string }
  }
  // The stranger can open the profile while it's public…
  await secondUser.page.goto(`/users/${me.user.username}`)
  await expect(secondUser.page.getByTestId("profile-name")).toBeVisible()

  // …the owner flips discoverability off in Settings…
  await owner.goto("/settings")
  const toggle = owner.getByTestId("account-discoverable")
  await toggle.click()
  await expect(toggle).toHaveAttribute("data-state", "unchecked")

  // …and the profile now renders its not-found state for the stranger.
  await secondUser.page.reload()
  await expect(secondUser.page.getByTestId("profile-name")).toBeHidden()
})
