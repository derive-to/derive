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

  it("workspace scope needs manage: owner creates it, a commenter is refused", async () => {
    const denied = await app.request(
      "/v1/connections",
      jsonAs(as(member.email), { toolkit: "github", scope: "workspace" }),
    )
    expect(denied.status).toBe(403)
    const res = await app.request(
      "/v1/connections",
      jsonAs(as(owner.email), { toolkit: "github", scope: "workspace" }),
    )
    expect(res.status).toBe(201)
    const cn = await res.json()
    // user_id survives as provenance ("added by"), but the credential is the workspace's.
    expect(cn).toMatchObject({ scope: "workspace", user_id: owner.id, status: "active" })
  })

  it("mine=1 means MY PERSONAL rows — a workspace row I added is the org's, not mine", async () => {
    await app.request(
      "/v1/connections",
      jsonAs(as(owner.email), { toolkit: "linear", scope: "workspace" }),
    )
    const mine = await (
      await app.request("/v1/connections?mine=1", { headers: as(owner.email) })
    ).json()
    expect(mine.connections.some((x: { toolkit: string }) => x.toolkit === "linear")).toBe(false)
    const ws = await (
      await app.request("/v1/connections?scope=workspace", { headers: as(owner.email) })
    ).json()
    expect(ws.connections.some((x: { toolkit: string }) => x.toolkit === "linear")).toBe(true)
    expect(ws.connections.every((x: { scope: string }) => x.scope === "workspace")).toBe(true)
  })

  it("a workspace connection is admin-managed: even its adder needs manage to revoke", async () => {
    // The owner has manage, so their delete succeeds; the commenter's is refused even
    // though workspace rows are "everyone's" — admin-managed cuts both ways.
    const cn = await (
      await app.request(
        "/v1/connections",
        jsonAs(as(owner.email), { toolkit: "asana", scope: "workspace" }),
      )
    ).json()
    const denied = await app.request(`/v1/connections/${cn.id}`, {
      method: "DELETE",
      headers: as(member.email),
    })
    expect(denied.status).toBe(403)
    const ok = await app.request(`/v1/connections/${cn.id}`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(ok.status).toBe(204)
  })

  it("bind policy: a personal connection can be attached only by its OWNER — even a manager binding someone else's is refused", async () => {
    // The member's personal connection (act-as-me is consensual: nobody routes your
    // account through an automation you didn't attach it to yourself).
    const theirs = await (await connect(member.email, "notion")).json()
    const denied = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        trigger: { kind: "manual" },
        instruction: "Summarize my Notion inbox.",
        connectionIds: [theirs.id],
      }),
    )
    expect(denied.status).toBe(400)
    expect((await denied.json()).error).toContain("its owner")
    // The owner's own personal + a workspace connection bind fine in one automation.
    const mine = await (await connect(owner.email, "calendar")).json()
    const ws = await (
      await app.request(
        "/v1/connections",
        jsonAs(as(owner.email), { toolkit: "sentry", scope: "workspace" }),
      )
    ).json()
    const ok = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        trigger: { kind: "manual" },
        instruction: "Cross-check calendar against Sentry incidents.",
        connectionIds: [mine.id, ws.id],
      }),
    )
    expect(ok.status).toBe(201)
  })

  it("paste-a-secret: stored encrypted, write-only — the credential appears in NO response", async () => {
    const secret = "sk_game_admin_9f3a7b2c1d"
    const res = await app.request(
      "/v1/connections",
      jsonAs(as(owner.email), {
        toolkit: "game-admin",
        kind: "secret",
        secret,
        base_url: "https://api.17-0.game/admin/", // trailing slash normalizes away
        scope: "workspace",
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.text()
    // Write-only is the contract: the raw secret and the encrypted blob both stay out.
    expect(body).not.toContain(secret)
    expect(body).not.toContain("secret_enc")
    const cn = JSON.parse(body)
    expect(cn).toMatchObject({
      kind: "secret",
      broker: "none",
      status: "active",
      base_url: "https://api.17-0.game/admin",
      scopes_label: `…${secret.slice(-4)}`, // hint only, never the credential
    })
    // The list route is equally silent about it.
    const list = await (
      await app.request("/v1/connections?scope=workspace", { headers: as(owner.email) })
    ).text()
    expect(list).not.toContain(secret)
    expect(list).not.toContain("secret_enc")
  })

  it("a secret connection needs no base_url — the host is ours to know, not yours to type", async () => {
    // Credentials are delivered to runs, so nothing confines a pasted key to a host and there
    // is no boundary for a base_url to express. A recognized vendor's host is ours to know; an
    // unrecognized key gets a free-text note instead. So the field is optional, and a
    // connection without one is perfectly valid — it just can't produce tools for the
    // machineless lane (pinned in context-connections.test.ts).
    const res = await app.request(
      "/v1/connections",
      jsonAs(as(owner.email), {
        toolkit: "own-api",
        kind: "secret",
        secret: "sk_no_host_needed_1234",
        scope: "workspace",
      }),
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ kind: "secret", base_url: null, status: "active" })
  })

  it("a secret connection refuses http bases and missing fields", async () => {
    const noFields = await app.request(
      "/v1/connections",
      jsonAs(as(owner.email), { toolkit: "thing", kind: "secret" }),
    )
    expect(noFields.status).toBe(400)
    const insecure = await app.request(
      "/v1/connections",
      jsonAs(as(owner.email), {
        toolkit: "thing",
        kind: "secret",
        secret: "s3cr3t-value",
        base_url: "http://api.example.com",
      }),
    )
    expect(insecure.status).toBe(400)
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
