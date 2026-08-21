import { describe, expect, it, test } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, pub, publishAs, type TestUser } from "./helpers"

// Cross-tenant isolation regression tests. Each app uses isolated:true, so Alice
// and Bob each provision their own personal workspace; "tok" is the instance
// super-admin (operator) credential. These pin the fixes for the cross-tenant
// findings the authz-coverage guard structurally can't catch (a route gating on
// the caller's workspace while acting on a globally-keyed resource).

const alice: TestUser = { id: "u_alice", email: "alice@a.test", name: "Alice" }
const bob: TestUser = { id: "u_bob", email: "bob@b.test", name: "Bob" }

const setup = (name: string) => makeAuthedApp(name, [alice, bob], undefined, { isolated: true })
type App = ReturnType<typeof setup>["app"]

const publish = async (app: App, who: TestUser): Promise<string> => {
  const res = await publishAs(app, "<h1>doc</h1>", {}, as(who.email))
  expect(res.ok).toBe(true)
  return ((await res.json()) as { short_id: string }).short_id
}
const body = async <T>(res: Response): Promise<T> => (await res.json()) as T

describe.skipIf(process.env.DERIVE_TEST_DB === "pg" && !process.env.TEST_DATABASE_URL)(
  "tenant isolation (multi-workspace)",
  () => {
    test("cannot fold another workspace's artifact into your collection", async () => {
      const { app } = setup("iso-collections")
      const aliceArt = await publish(app, alice)
      const col = await body<{ id: string }>(
        await app.request("/v1/collections", jsonAs(as(bob.email), { title: "Bob's" })),
      )
      // Bob owns the collection, but Alice's artifact is in another workspace.
      const cross = await app.request(`/v1/collections/${col.id}/items/${aliceArt}`, {
        method: "PUT",
        headers: as(bob.email),
      })
      expect(cross.status).toBe(404)
      // Sanity: his own artifact (same workspace, he owns it) goes in fine.
      const bobArt = await publish(app, bob)
      const own = await app.request(`/v1/collections/${col.id}/items/${bobArt}`, {
        method: "PUT",
        headers: as(bob.email),
      })
      expect(own.status).toBe(200)
    })

    test("a workspace admin cannot delete another workspace's agent", async () => {
      const { app } = setup("iso-agents")
      const agent = await body<{ id: string }>(
        await app.request("/v1/agents", jsonAs(as(alice.email), { name: "alice-bot" })),
      )
      // Bob is admin of his own workspace; deleteAgent is keyed by (id, org), so
      // this is a scoped no-op, not a cross-tenant delete.
      await app.request(`/v1/agents/${agent.id}`, { method: "DELETE", headers: as(bob.email) })
      const list = await body<{ agents: { id: string }[] }>(
        await app.request("/v1/agents", { headers: as(alice.email) }),
      )
      expect(list.agents.map((a) => a.id)).toContain(agent.id)
    })

    test("takedown is workspace-scoped for admins, global for the super-admin", async () => {
      const { app } = setup("iso-takedown")
      const aliceArt = await publish(app, alice)
      // Bob (admin of his own workspace) cannot reach Alice's artifact.
      const bobTd = await app.request(
        `/v1/artifacts/${aliceArt}/takedown`,
        jsonAs(as(bob.email), { note: "x" }),
      )
      expect(bobTd.status).toBe(404)
      // The operator (super-admin token) takes down any artifact, globally.
      const opTd = await app.request(`/v1/artifacts/${aliceArt}/takedown`, {
        method: "POST",
        headers: { ...bearer("tok"), "content-type": "application/json" },
        body: JSON.stringify({ note: "abuse" }),
      })
      expect(opTd.status).toBe(200)
    })

    test("webhooks are neither visible nor deletable across workspaces", async () => {
      const { app } = setup("iso-webhooks")
      const wh = await body<{ id: string }>(
        await app.request(
          "/v1/webhooks",
          jsonAs(as(alice.email), { url: "https://example.com/hook" }),
        ),
      )
      const bobList = await body<{ webhooks: { id: string }[] }>(
        await app.request("/v1/webhooks", { headers: as(bob.email) }),
      )
      expect(bobList.webhooks).toHaveLength(0)
      // A cross-workspace delete is a scoped no-op.
      await app.request(`/v1/webhooks/${wh.id}`, { method: "DELETE", headers: as(bob.email) })
      const aliceList = await body<{ webhooks: { id: string }[] }>(
        await app.request("/v1/webhooks", { headers: as(alice.email) }),
      )
      expect(aliceList.webhooks.map((w) => w.id)).toContain(wh.id)
    })

    test("reports are workspace-scoped for admins, global for the super-admin", async () => {
      const { app } = setup("iso-reports")
      const aliceArt = await publish(app, alice)
      const rep = await app.request(`/v1/artifacts/${aliceArt}/report`, {
        method: "POST",
        headers: { "content-type": "application/json", ...as(alice.email) },
        body: JSON.stringify({ reason: "spam" }),
      })
      expect(rep.status).toBe(201)
      // Bob's workspace queue does not surface another tenant's report.
      const bobQueue = await body<{ reports: unknown[] }>(
        await app.request("/v1/reports", { headers: as(bob.email) }),
      )
      expect(bobQueue.reports).toHaveLength(0)
      // The operator sees it in the global queue.
      const opQueue = await body<{ reports: unknown[] }>(
        await app.request("/v1/reports", { headers: bearer("tok") }),
      )
      expect(opQueue.reports.length).toBeGreaterThanOrEqual(1)
    })
  },
)

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
