import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// WO3 — per-user connected accounts (Sources). Connect once via the broker (the LocalBroker
// auto-authorizes in dev/test), then instructions name the tool. Always bound to one person;
// per-user isolation and least-privilege are the load-bearing properties.
describe("connections (Sources — per-user connected accounts)", () => {
  const owner: TestUser = { id: "u_conn_own", email: "connown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_conn_mem", email: "connmem@derive.test", name: "Member" }
  const { app } = makeAuthedApp("connections", [owner, member], "commenter", {
    deps: { encryptionKey: "test-encryption-key" },
  })
  const connect = (who: string, toolkit: string) =>
    app.request("/v1/connections", jsonAs(as(who), { toolkit }))

  it("connects a toolkit; the local broker auto-authorizes and binds it to the caller", async () => {
    const res = await connect(owner.email, "gmail")
    expect(res.status).toBe(201)
    const cn = await res.json()
    expect(cn).toMatchObject({
      toolkit: "gmail",
      broker: "local",
      status: "active",
      user_id: owner.id,
    })
    expect(cn.connect_url).toContain("local://")
  })

  it("connections are per-user: a member's is invisible to another's mine=1 list", async () => {
    await connect(member.email, "stripe")
    const ownerMine = await (
      await app.request("/v1/connections?mine=1", { headers: as(owner.email) })
    ).json()
    expect(ownerMine.connections.some((x: { toolkit: string }) => x.toolkit === "stripe")).toBe(
      false,
    )
    const memberMine = await (
      await app.request("/v1/connections?mine=1", { headers: as(member.email) })
    ).json()
    expect(memberMine.connections.some((x: { toolkit: string }) => x.toolkit === "stripe")).toBe(
      true,
    )
  })

  it("owner revokes their own connection; a foreign one needs manage", async () => {
    const mine = await (await connect(owner.email, "github")).json()
    const del = await app.request(`/v1/connections/${mine.id}`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(del.status).toBe(204)
    // A commenter member can't revoke the owner's connection.
    const owned = await (await connect(owner.email, "notion")).json()
    const denied = await app.request(`/v1/connections/${owned.id}`, {
      method: "DELETE",
      headers: as(member.email),
    })
    expect([403, 404]).toContain(denied.status)
  })
})
