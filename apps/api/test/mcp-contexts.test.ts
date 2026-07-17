import { describe, expect, it } from "vitest"
import { sha256 } from "../src/lib/crypto"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The MCP ask surface: list_contexts + ask act for the connection's on-behalf
// human (the token's registrant / the OAuth grantor), gated per call by that
// human's OWN ask-grant — canUserAskContext, the same rule the console enforces.
// The tools are registered on every connection (the surface never differs by
// auth kind); a connection with no known human is refused at call time.
//
// Cast: owner (Admin) registers the agents — the answering one and "OwnerBot",
// the MCP connection under test, whose acting human is therefore OWNER. dev
// (editor) publishes the manifest and creates the context, so dev is the
// CREATOR and owner is a plain member — the interesting side of every policy.

const owner: TestUser = { id: "u_mcx_own", email: "mcxown@derive.test", name: "Owner" }
const dev: TestUser = { id: "u_mcx_dev", email: "mcxdev@derive.test", name: "Dev" }

type Made = ReturnType<typeof makeAuthedApp>
type App = Made["app"]

// A direct tools/call over the stateless /mcp endpoint (mcp-inbox-wait's shape).
// callRaw keeps the text + isError for error assertions; call JSON-parses a
// success payload.
const callRaw = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  const out = ct.includes("application/json")
    ? JSON.parse(txt)
    : JSON.parse(
        (txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
      )
  const r = out?.result as { content?: { text: string }[]; isError?: boolean } | undefined
  const t = r?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text: ${JSON.stringify(out)}`)
  return { text: t, isError: !!r?.isError }
}
const call = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  // biome-ignore lint/suspicious/noExplicitAny: test convenience over a JSON payload
): Promise<any> => JSON.parse((await callRaw(app, token, name, args)).text)

const setup = async (name: string, deps?: Record<string, unknown>) => {
  const made = makeAuthedApp(name, [owner, dev], "editor", deps ? { deps } : undefined)
  const { app, meta } = made
  await app.request("/v1/me", { headers: as(owner.email) })
  await app.request("/v1/me", { headers: as(dev.email) })
  // Agent registration is Admin-only, so owner mints both: the context's
  // answering agent and the MCP caller under test (acting human = owner).
  const answering = await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst" }))
  ).json()
  const ownerBot = await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "OwnerBot" }))
  ).json()
  // dev (editor) authors the manifest and creates the context — dev is creator.
  const manifest = await (
    await publishAs(app, "# Analytics manifest", { title: "Analytics manifest" }, as(dev.email))
  ).json()
  const cx = await (
    await app.request(
      "/v1/contexts",
      jsonAs(as(dev.email), {
        name: "Analytics",
        agent_id: answering.id,
        manifest_short_id: manifest.short_id,
      }),
    )
  ).json()
  return {
    app,
    meta,
    cx,
    manifestShortId: manifest.short_id as string,
    answeringToken: answering.token as string,
    ownerToken: ownerBot.token as string,
  }
}

describe("list_contexts — ask-scoped discovery", () => {
  it("shows only what the acting human may ask; invited admits via the roster", async () => {
    const { app, cx, manifestShortId, ownerToken } = await setup("mcx-list")
    // Default ask_policy is `invited` (creator + roster): owner is a plain
    // member, so OwnerBot sees nothing — and learns nothing exists.
    const before = await call(app, ownerToken, "list_contexts", {})
    expect(before.count).toBe(0)
    // The creator invites owner; the same call now shows the context, offline
    // (its runner has never polled), with the manifest identity attached.
    expect(
      (
        await app.request(
          `/v1/contexts/${cx.id}/askers`,
          jsonAs(as(dev.email), { email: owner.email }),
        )
      ).status,
    ).toBe(201)
    const after = await call(app, ownerToken, "list_contexts", {})
    expect(after.count).toBe(1)
    expect(after.contexts).toMatchObject([
      {
        id: cx.id,
        name: "Analytics",
        online: false,
        manifest: { short_id: manifestShortId, title: "Analytics manifest" },
      },
    ])
    expect(after.your_open_sessions).toEqual([])
  })

  it("workspace policy admits every member; a web-opened session shows as resumable", async () => {
    const { app, cx, ownerToken } = await setup("mcx-list-ws")
    expect(
      (
        await app.request(
          `/v1/contexts/${cx.id}/access`,
          jsonAs(as(dev.email), { ask_policy: "workspace" }),
        )
      ).status,
    ).toBe(200)
    // A session the human opened in the CONSOLE is the same session the agent
    // may resume — the MCP surface is the human's own seat.
    const opened = await (
      await app.request(
        `/v1/contexts/${cx.id}/sessions`,
        jsonAs(as(owner.email), { body_md: "Q?" }),
      )
    ).json()
    const res = await call(app, ownerToken, "list_contexts", {})
    expect(res.count).toBe(1)
    expect(res.your_open_sessions).toMatchObject([
      { id: opened.session.id, context: "Analytics", state: "open" },
    ])
  })

  it("a connection with no acting human is refused at call time, not hidden", async () => {
    const { app, meta } = await setup("mcx-list-nohuman")
    // A pre-column legacy token: a registered agent with no created_by. Only
    // reachable by seeding the store directly — the API always stamps a creator.
    const raw = "dk_agt_mcx_legacy"
    const orgs = await meta.listWorkspaces(owner.id)
    await meta.createAgent({
      id: "ag_mcx_legacy",
      org_id: orgs[0]?.id ?? "",
      name: "Legacy",
      token: sha256(raw),
      role: "editor",
      created_by: null,
    })
    const r = await callRaw(app, raw, "list_contexts", {})
    expect(r.isError).toBe(true)
    expect(r.text).toContain("no acting human")
  })
})
