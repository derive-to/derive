import { LocalBroker } from "@derive/broker"
import { describe, expect, it } from "vitest"
import { toolsForRun } from "../src/lib/broker"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// WO4 — least-privilege tool injection. A hosted run sees the tools of its BOUND connections
// only, never the workspace's whole list. This is the load-bearing safety property of the
// hosted path.
describe("hosted tool injection — least privilege (WO4)", () => {
  const owner: TestUser = { id: "u_ht_own", email: "htown@derive.test", name: "O" }
  const { app, meta } = makeAuthedApp("hosted-tools", [owner], "editor", {
    deps: { encryptionKey: "k" },
  })
  const connect = async (toolkit: string) =>
    (await (await app.request("/v1/connections", jsonAs(as(owner.email), { toolkit }))).json()) as {
      id: string
      toolkit: string
    }

  it("a run sees ONLY its bound connections' tools, not the workspace's others", async () => {
    const stripe = await connect("stripe")
    await connect("gmail") // exists in the workspace but is NOT bound to the run
    const tools = await toolsForRun(meta, new LocalBroker(), "default", [stripe.id])
    expect(tools.map((t) => t.def.name).sort()).toEqual(["stripe.read", "stripe.write"])
    // The unbound gmail connection contributes nothing.
    expect(tools.some((t) => t.def.name.startsWith("gmail"))).toBe(false)
    // Each tool carries the connected-account ref it executes through.
    expect(tools.every((t) => t.ref.includes("stripe"))).toBe(true)
  })

  it("a revoked connection contributes no tools", async () => {
    const notion = await connect("notion")
    await app.request(`/v1/connections/${notion.id}`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    const tools = await toolsForRun(meta, new LocalBroker(), "default", [notion.id])
    expect(tools).toHaveLength(0)
  })

  it("a foreign-org caller resolves nothing (cross-tenant isolation)", async () => {
    const stripe = await connect("stripe")
    const tools = await toolsForRun(meta, new LocalBroker(), "other-org", [stripe.id])
    expect(tools).toHaveLength(0)
  })

  it("a departed member's PERSONAL connection stops resolving; a workspace one survives", async () => {
    // A second member connects a personal toolkit and the owner adds a workspace one.
    const gone: TestUser = { id: "u_ht_gone", email: "htgone@derive.test", name: "G" }
    const h = makeAuthedApp("hosted-tools-offboard", [owner, gone], "editor", {
      deps: { encryptionKey: "k" },
    })
    const personal = await (
      await h.app.request("/v1/connections", jsonAs(as(gone.email), { toolkit: "gmail" }))
    ).json()
    const ws = await (
      await h.app.request(
        "/v1/connections",
        jsonAs(as(owner.email), { toolkit: "github", scope: "workspace" }),
      )
    ).json()
    const bound = [personal.id, ws.id]
    // Both resolve while the member is present…
    const before = await toolsForRun(h.meta, new LocalBroker(), "default", bound)
    expect(before.some((t) => t.def.name.startsWith("gmail"))).toBe(true)
    expect(before.some((t) => t.def.name.startsWith("github"))).toBe(true)
    // …then the member leaves: their personal credential must not outlive them,
    // while the workspace credential — org infrastructure — keeps working.
    await h.meta.removeMembership("default", gone.id)
    const after = await toolsForRun(h.meta, new LocalBroker(), "default", bound)
    expect(after.some((t) => t.def.name.startsWith("gmail"))).toBe(false)
    expect(after.some((t) => t.def.name.startsWith("github"))).toBe(true)
  })
})
