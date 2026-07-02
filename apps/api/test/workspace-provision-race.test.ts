import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, type TestUser } from "./helpers"

// Regression for the duplicate-"…'s Workspace" bug: on first login the SPA fires
// many authed requests in parallel, none carrying a derive_ws cookie. Each runs
// activeWorkspace → listWorkspaces (empty) → provisionPersonal. With a random
// workspace id per call this minted one workspace per request (~24 dupes in prod).
// A deterministic personal-workspace id makes provisionPersonal idempotent, so the
// whole burst collapses to a single workspace + membership.
describe("personal workspace provisioning under concurrent first-login", () => {
  const user: TestUser = { id: "u_ws_race", email: "race@derive.test", name: "Race User" }

  it("a burst of concurrent authed requests yields exactly one workspace", async () => {
    // isolated: the user starts with NO workspace, so the first request provisions.
    const { app, meta } = makeAuthedApp("ws-race", [user], undefined, { isolated: true })

    const N = 25
    const res = await Promise.all(
      Array.from({ length: N }, () => app.request("/v1/me", { headers: as(user.email) })),
    )
    for (const r of res) expect(r.status).toBe(200)

    const mine = await meta.listWorkspaces(user.id)
    expect(mine.length).toBe(1)
    expect(mine[0]?.id).toBe(`ws_${user.id}`)
  })

  it("re-provisioning the same user is idempotent (deterministic id)", async () => {
    const { app, meta } = makeAuthedApp("ws-race-2", [user], undefined, { isolated: true })

    await app.request("/v1/me", { headers: as(user.email) })
    // A second cookieless request would re-enter the provision branch; it must not
    // create a second row.
    await app.request("/v1/me", { headers: as(user.email) })

    const mine = await meta.listWorkspaces(user.id)
    expect(mine.length).toBe(1)
  })
})
