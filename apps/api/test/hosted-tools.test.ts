import { LocalBroker } from "@derive/broker"
import { describe, expect, it } from "vitest"
import { executeHttpTool, toolsForRun } from "../src/lib/broker"
import { encryptSecret } from "../src/lib/crypto"
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

  it("a secret connection exposes get/post tools and executes CONFINED to its base_url", async () => {
    const key = "k"
    const secret = "game-admin-token-123456"
    const created = await (
      await app.request(
        "/v1/connections",
        jsonAs(as(owner.email), {
          toolkit: "game",
          kind: "secret",
          secret,
          base_url: "https://api.game.test/admin",
        }),
      )
    ).json()
    // The tool surface mirrors the broker's naming, so the shim treats both kinds alike.
    const tools = await toolsForRun(meta, new LocalBroker(), "default", [created.id])
    expect(tools.map((t) => t.def.name).sort()).toEqual(["game.get", "game.post"])
    // How the proxy knows to execute these itself rather than asking the broker.
    expect(tools.every((t) => t.kind === "secret" && t.connectionId === created.id)).toBe(true)

    // Execution: the server joins the path, attaches the decrypted bearer, returns the body.
    const [cn] = await meta.getConnectionsByIds([created.id])
    if (!cn) throw new Error("connection not found")
    const calls: { url: string; auth: string | null; method: string }[] = []
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      calls.push({ url: String(url), auth: h.get("authorization"), method: init?.method ?? "GET" })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    const out = await executeHttpTool(
      meta,
      cn,
      "game.get",
      { path: "/report?days=30" },
      key,
      fakeFetch,
    )
    expect(out).toEqual({ status: 200, body: { ok: true } })
    expect(calls[0]).toMatchObject({
      url: "https://api.game.test/admin/report?days=30",
      auth: `Bearer ${secret}`,
      method: "GET",
    })

    // Confinement. The path comes from the model, so it is attacker-influenced: the
    // credential must only ever be offered to the base it was pasted for.
    await expect(
      executeHttpTool(meta, cn, "game.get", { path: "https://evil.test/x" }, key, fakeFetch),
    ).rejects.toThrow(/start with/)
    await expect(
      executeHttpTool(meta, cn, "game.get", { path: "/../secrets" }, key, fakeFetch),
    ).rejects.toThrow(/escapes/)
    // A sibling path that merely shares the base's prefix: /admin must not be satisfied by
    // /administrator. Comparing hrefs without the trailing slash accepts this one.
    await expect(
      executeHttpTool(meta, cn, "game.get", { path: "/../administrator/x" }, key, fakeFetch),
    ).rejects.toThrow(/escapes/)
    expect(calls).toHaveLength(1) // none of the hostile paths reached fetch
  })

  it("the claim response carries tool defs and refs only — never the connection record", async () => {
    const created = await (
      await app.request(
        "/v1/connections",
        jsonAs(as(owner.email), {
          toolkit: "vault",
          kind: "secret",
          secret: "super-secret-value-xyz",
          base_url: "https://api.vault.test",
        }),
      )
    ).json()
    const auto = await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          trigger: { kind: "manual" },
          instruction: "Read the vault.",
          connectionIds: [created.id],
        }),
      )
    ).json()
    await app.request(`/v1/automations/${auto.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    const claim = await app.request("/v1/agent/runs/claim", {
      method: "GET",
      headers: { authorization: `Bearer ${auto.agent_token}` },
    })
    const text = await claim.text()
    expect(text).not.toContain("super-secret-value-xyz")
    expect(text).not.toContain("secret_enc")
    // The routing fields RunTool carries for the proxy stop at the wire, too.
    expect(text).not.toContain("connectionId")
    const [run] = JSON.parse(text).runs
    expect(run.tools.map((t: { def: { name: string } }) => t.def.name).sort()).toEqual([
      "vault.get",
      "vault.post",
    ])
  })

  it("slack: backed by the workspace's existing install, storing no credential of its own", async () => {
    const h = makeAuthedApp("conn-slack", [owner], "editor", { deps: { encryptionKey: "k" } })
    // Refused until the workspace has actually connected Slack — this endpoint starts no
    // OAuth, it only gives an existing install a tool surface.
    const early = await h.app.request("/v1/connections", jsonAs(as(owner.email), { kind: "slack" }))
    expect(early.status).toBe(400)
    expect((await early.json()).error).toMatch(/connect Slack/i)

    await h.meta.setSlackInstall({
      org_id: "default",
      team_id: "T123",
      team_name: "Derive HQ",
      bot_token: encryptSecret("xoxb-real-bot-token", "k"),
      bot_user_id: "U1",
      default_channel: null,
      needs_reauth: 0,
      created_at: new Date().toISOString(),
    })
    const res = await h.app.request("/v1/connections", jsonAs(as(owner.email), { kind: "slack" }))
    expect(res.status).toBe(201)
    const body = await res.text()
    expect(body).not.toContain("xoxb-real-bot-token")
    const cn = JSON.parse(body)
    // Workspace-scoped by construction — the install belongs to the org, not the wirer.
    expect(cn).toMatchObject({ kind: "slack", scope: "workspace", toolkit: "slack" })

    const [rec] = await h.meta.getConnectionsByIds([cn.id])
    if (!rec) throw new Error("connection not found")
    expect(rec.secret_enc).toBeNull() // nothing stored here to leak or rotate
    const calls: { auth: string | null }[] = []
    const fakeFetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ auth: new Headers(init?.headers).get("authorization") })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    await executeHttpTool(h.meta, rec, "slack.get", { path: "/conversations.list" }, "k", fakeFetch)
    // The bearer came from the install, resolved at call time.
    expect(calls[0]?.auth).toBe("Bearer xoxb-real-bot-token")

    // An install flagged for re-auth refuses rather than calling with a dead token.
    const install = await h.meta.getSlackInstall("default")
    if (install) await h.meta.setSlackInstall({ ...install, needs_reauth: 1 })
    await expect(
      executeHttpTool(h.meta, rec, "slack.get", { path: "/x" }, "k", fakeFetch),
    ).rejects.toThrow(/reconnect/i)
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
