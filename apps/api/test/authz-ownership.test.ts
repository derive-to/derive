import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, pub, publishAs, type TestUser } from "./helpers"

// Regression for the cross-ownership authority leak: an agent (registered token or
// OAuth-consent grant) carries its role ONLY within its own workspace. Because
// short_ids are global, an agent could resolve a foreign workspace's artifact and,
// before the fix, its home-workspace editor role was applied to it — letting it
// publish/comment/share on artifacts it doesn't own. actorFor now binds the agent's
// orgRole to the artifact's workspace (ag.org_id === a.org_id), exactly like a human.
describe("authz: an agent cannot act on artifacts outside its own workspace", () => {
  const alice: TestUser = { id: "u_authz_alice", email: "alice@authz.test", name: "Alice" }
  const bob: TestUser = { id: "u_authz_bob", email: "bob@authz.test", name: "Bob" }
  // isolated → each user owns a SEPARATE personal workspace (no shared team seed).
  const { app } = makeAuthedApp("authz-ownership", [alice, bob], undefined, { isolated: true })

  it("scopes an editor agent to its home workspace; cross-workspace writes are refused", async () => {
    // Provision both personal workspaces (first /v1/me makes each user their owner).
    await app.request("/v1/me", { headers: as(alice.email) })
    await app.request("/v1/me", { headers: as(bob.email) })

    // Alice registers an EDITOR agent in HER workspace; it returns a bearer once.
    const reg = await app.request(
      "/v1/agents",
      jsonAs(as(alice.email), { name: "Helper", role: "editor" }),
    )
    expect(reg.status).toBe(201)
    const agentToken = (await reg.json()).token as string

    // Bob publishes an artifact in HIS workspace.
    const bobId = (
      await (await publishAs(app, "<h1>Bob's</h1>", { visibility: "org" }, as(bob.email))).json()
    ).short_id

    // The agent (workspace A, editor) must NOT mutate Bob's artifact (workspace B):
    // republishing a version and commenting are both refused — its home-workspace
    // role does not reach a foreign workspace's artifact.
    expect((await pub(app, "<h1>hijacked</h1>", {}, bobId, bearer(agentToken))).status).toBe(403)
    expect(
      (
        await app.request(
          `/v1/artifacts/${bobId}/comments`,
          jsonAs(bearer(agentToken), { body_md: "mine now" }),
        )
      ).status,
    ).toBe(403)
    // Bob's artifact is untouched — still at version 1.
    const after = await (
      await app.request(`/v1/artifacts/${bobId}`, { headers: as(bob.email) })
    ).json()
    expect(after.current_version).toBe(1)

    // No over-reach: the SAME agent CAN still act in its OWN workspace.
    const aliceId = (
      await (
        await publishAs(app, "<h1>Alice's</h1>", { visibility: "org" }, as(alice.email))
      ).json()
    ).short_id
    expect(
      (await pub(app, "<h1>v2</h1>", { message: "bump" }, aliceId, bearer(agentToken))).ok,
    ).toBe(true)
    const own = await (
      await app.request(`/v1/artifacts/${aliceId}`, { headers: as(alice.email) })
    ).json()
    expect(own.current_version).toBe(2)
  })
})
