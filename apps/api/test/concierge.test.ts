import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// WP7 — the concierge seed: a new user's welcome artifact with a planted comment,
// so their first session can close the loop once. Idempotency is per-user, so
// each scenario uses its own user to avoid cross-contaminating the seed.
describe("concierge seed", () => {
  const ada: TestUser = { id: "u_con_ada", email: "ada@derive.test", name: "Ada" }
  const bo: TestUser = { id: "u_con_bo", email: "bo@derive.test", name: "Bo" }
  const { app } = makeAuthedApp("concierge", [ada, bo], "editor")

  const seed = (email: string) =>
    app.request("/v1/workspace/concierge", { method: "POST", headers: as(email) })
  const comments = async (email: string, shortId: string) =>
    (await app.request(`/v1/artifacts/${shortId}/comments`, { headers: as(email) })).json()

  it("seeds a welcome artifact owned by the user with a planted comment", async () => {
    const res = await seed(ada.email)
    expect(res.status).toBe(201)
    const { short_id, comment_thread } = await res.json()
    expect(short_id).toBeTruthy()
    expect(comment_thread).toBeTruthy()

    const art = await (
      await app.request(`/v1/artifacts/${short_id}`, { headers: as(ada.email) })
    ).json()
    expect(art.title).toBe("Welcome to Derive")

    // The planted comment is on it — the task the loop will close.
    const { comments: list } = await comments(ada.email, short_id)
    expect(list.length).toBeGreaterThan(0)
  })

  it("is idempotent — a second call returns the same seed, not a duplicate", async () => {
    // Ada already seeded above; every re-fire of the welcome flow must resolve to
    // that same artifact rather than planting another.
    const first = await seed(ada.email)
    expect(first.status).toBe(200)
    const one = await first.json()
    expect(one.existing).toBe(true)

    const two = await (await seed(ada.email)).json()
    expect(two.short_id).toBe(one.short_id)
  })

  it("requires a signed-in user", async () => {
    const anon = await app.request("/v1/workspace/concierge", { method: "POST" })
    expect([401, 403]).toContain(anon.status)
  })

  it("the planted comment is authored by the workspace fallback agent when set", async () => {
    // Ada (the workspace owner) registers an agent and makes it the workspace
    // default; Bo — a fresh member seeding for the first time — picks up that
    // fallback authorship on the planted comment.
    const agent = await (
      await app.request("/v1/agents", jsonAs(as(ada.email), { name: "House" }))
    ).json()
    const patched = await app.request("/v1/workspace/settings", {
      ...jsonAs(as(ada.email), { defaultAgentId: agent.id }),
      method: "PATCH",
    })
    expect(patched.status).toBe(200)

    const { short_id } = await (await seed(bo.email)).json()
    const { comments: list } = await comments(bo.email, short_id)
    expect(list.some((c: { author: string }) => c.author === "House")).toBe(true)
  })
})
