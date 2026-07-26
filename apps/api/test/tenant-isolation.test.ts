import { describe, expect, test } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

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
