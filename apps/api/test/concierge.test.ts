import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// WP7 — the concierge seed: a new user's welcome artifact with a planted comment,
// so their first session can close the loop once.
describe("concierge seed", () => {
  const user: TestUser = { id: "u_con", email: "con@derive.test", name: "Ada" }
  const { app } = makeAuthedApp("concierge", [user], "editor")

  const seed = () =>
    app.request("/v1/workspace/concierge", { method: "POST", headers: as(user.email) })

  it("seeds a welcome artifact owned by the user with a planted comment", async () => {
    const res = await seed()
    expect(res.status).toBe(201)
    const { short_id, comment_thread } = await res.json()
    expect(short_id).toBeTruthy()
    expect(comment_thread).toBeTruthy()

    // The artifact exists and is the welcome doc, owned by the user.
    const art = await (
      await app.request(`/v1/artifacts/${short_id}`, { headers: as(user.email) })
    ).json()
    expect(art.title).toBe("Welcome to Derive")

    // The planted comment is on it — the task the loop will close.
    const comments = await (
      await app.request(`/v1/artifacts/${short_id}/comments`, { headers: as(user.email) })
    ).json()
    expect(comments.threads?.length ?? comments.comments?.length ?? 0).toBeGreaterThan(0)
  })

  it("requires a signed-in user", async () => {
    const anon = await app.request("/v1/workspace/concierge", { method: "POST" })
    expect([401, 403]).toContain(anon.status)
  })

  it("the planted comment is authored by the workspace fallback agent when set", async () => {
    // Register an agent and make it the workspace default.
    const agent = await (
      await app.request("/v1/agents", jsonAs(as(user.email), { name: "House" }))
    ).json()
    await app.request("/v1/workspace/settings", {
      ...jsonAs(as(user.email), { defaultAgentId: agent.id }),
      method: "PATCH",
    })
    const { short_id } = await (await seed()).json()
    const comments = await (
      await app.request(`/v1/artifacts/${short_id}/comments`, { headers: as(user.email) })
    ).json()
    const flat =
      comments.threads?.flatMap((t: { comments: unknown[] }) => t.comments) ??
      comments.comments ??
      []
    expect(flat.some((c: { author: string }) => c.author === "House")).toBe(true)
  })
})
