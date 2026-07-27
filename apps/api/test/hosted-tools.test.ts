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
})
