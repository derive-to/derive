import { expect, test } from "../fixtures"

// The people layer, browser side. NOTE: the cross-workspace social surfaces this
// file once guarded — a stranger browsing another workspace's public work, a global
// People directory, cross-workspace follow feeds — were removed in the launch social
// cut. A profile is work-awareness for teammates, not a broadcast surface: the work
// grid and People directory are workspace-mates-only, and follow feeds are scoped to
// your active workspace. That teammate-scoped behavior is pinned server-side in
// apps/api/test/profiles.test.ts ("shows work to teammates only") and follows.test.ts;
// what remains worth driving through the real UI is the own-profile affordance.

// A person can't follow themselves: the Follow button never renders on your own profile.
test("the Follow button is absent on your own profile", async ({ owner }) => {
  const me = (await (await owner.request.get("/v1/me")).json()).user as { username: string }
  await owner.goto(`/users/${me.username}`)
  await expect(owner.getByTestId("profile-card")).toBeVisible()
  await expect(owner.getByTestId(`follow-${me.username}`)).toHaveCount(0)
  // …but you can edit your own handle from there.
  await expect(owner.getByTestId("profile-edit")).toBeVisible()
})
