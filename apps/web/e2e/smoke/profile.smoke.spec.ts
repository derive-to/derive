import { Buffer } from "node:buffer"
import { expect, test } from "../fixtures"

// The people layer end-to-end: an author's public work shows on their profile, a second
// person (in their OWN workspace) can follow them, and that follow flows the author's
// public work into the follower's activity feed — across workspaces. This is the path
// the cross-workspace feed bug lived on, so it's a smoke-level regression guard.
test("follow a person → their public work shows on the profile and in the follower's feed", async ({
  owner,
  secondUser,
}) => {
  const bob = secondUser.page

  // Maya (owner) — read her auto-assigned handle and publish a PUBLIC artifact.
  const maya = (await (await owner.request.get("/v1/me")).json()).user as { username: string }
  const published = await owner.request.post("/v1/artifacts", {
    multipart: {
      file: { name: "q3-plan.md", mimeType: "text/markdown", buffer: Buffer.from("# Q3 Plan") },
      title: "Q3 Plan",
      visibility: "public",
    },
  })
  expect(published.ok()).toBeTruthy()
  const shortId = ((await published.json()) as { short_id: string }).short_id

  // Bob visits Maya's profile (he's in a different workspace) — her public work is listed.
  await bob.goto(`/u/${maya.username}`)
  await expect(bob.getByTestId("profile-card")).toBeVisible()
  await expect(bob.getByTestId(`profile-work-${shortId}`)).toBeVisible()

  // Follow her — the button flips to the followed state and the follower count ticks up.
  const followBtn = bob.getByTestId(`follow-${maya.username}`)
  await expect(followBtn).toHaveAttribute("aria-pressed", "false")
  await followBtn.click()
  await expect(followBtn).toHaveAttribute("aria-pressed", "true")
  await expect(bob.getByTestId("profile-stat-followers")).toContainText("1")

  // Her public work now appears in Bob's Following feed — even though it lives in Maya's
  // workspace, not Bob's (the cross-workspace people-follow path).
  await bob.goto("/?scope=following")
  await expect(bob.getByTestId(`artifact-card-open-${shortId}`)).toBeVisible()

  // The follow persists across a reload (it's server state, not just local).
  await bob.goto(`/u/${maya.username}`)
  await expect(bob.getByTestId(`follow-${maya.username}`)).toHaveAttribute("aria-pressed", "true")
})

// Ambient follow: you can follow a person straight from the command-palette people
// search, without going to their profile first.
test("follow a person from the command-palette people search", async ({ owner, secondUser }) => {
  const bob = secondUser.page
  const maya = (await (await owner.request.get("/v1/me")).json()).user as { username: string }

  await bob.goto("/")
  await bob.getByTestId("open-command-palette").click()
  // Owner's display name is "E2E Tester" (secondUser is "Second User"), so "Tester"
  // resolves to exactly one discoverable person.
  await bob.getByPlaceholder(/Search artifacts, people/).fill("Tester")

  const followBtn = bob.getByTestId(`follow-${maya.username}`)
  await expect(followBtn).toBeVisible()
  await expect(followBtn).toHaveAttribute("aria-pressed", "false")
  await followBtn.click()
  await expect(followBtn).toHaveAttribute("aria-pressed", "true")

  // And the follow really landed: it shows on the person's profile.
  await bob.goto(`/u/${maya.username}`)
  await expect(bob.getByTestId(`follow-${maya.username}`)).toHaveAttribute("aria-pressed", "true")
})

// A person can't follow themselves: the Follow button never renders on your own profile.
test("the Follow button is absent on your own profile", async ({ owner }) => {
  const me = (await (await owner.request.get("/v1/me")).json()).user as { username: string }
  await owner.goto(`/u/${me.username}`)
  await expect(owner.getByTestId("profile-card")).toBeVisible()
  await expect(owner.getByTestId(`follow-${me.username}`)).toHaveCount(0)
  // …but you can edit your own handle from there.
  await expect(owner.getByTestId("profile-edit")).toBeVisible()
})
