import { describe, expect, it } from "vitest"
import { dispatchPass, type Substrate } from "../src/lib/dispatch"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// P3.5 — a context's connections are its hands in EVERY lane. Before this, connection ids
// lived only on an automation, so credentials attached to a scheduled job and an ask could
// not use a connection at all. The load-bearing property is that both lanes resolve the
// SAME least-privilege list from the same place: a context reaches exactly the same things
// whether a schedule fired it or a person asked it a question.
const SECRET = "test-secret-at-least-16-chars"

describe("context connections (the ask lane gets hands)", () => {
  const owner: TestUser = { id: "u_cc_own", email: "ccown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_cc_mem", email: "ccmem@derive.test", name: "Member" }
  const { app, meta } = makeAuthedApp("context-connections", [owner, member], "editor", {
    deps: { encryptionKey: SECRET },
  })

  const makeConnection = async (body: Record<string, unknown>) =>
    (await (await app.request("/v1/connections", jsonAs(as(owner.email), body))).json()) as {
      id: string
    }

  // Boot every queued session through a fake substrate and hand back the capability token
  // dispatch minted for one of them — the executor's real entry into the ask lane.
  const tokenFor = async (sessionId: string) => {
    const started: { runId: string; token: string; server: string }[] = []
    const substrate: Substrate = {
      name: "fake",
      async start(input) {
        started.push(input)
      },
    }
    await dispatchPass({ meta, substrate, server: "https://derive.test", secret: SECRET })
    return started.find((s) => s.runId === sessionId)?.token ?? ""
  }

  const makeContext = async (name: string, connectionIds?: string[]) => {
    const manifest = await publishAs(app, "# How to answer", { title: name }, as(owner.email))
    const { short_id } = (await manifest.json()) as { short_id: string }
    return (await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name,
          manifest_short_id: short_id,
          ...(connectionIds ? { connection_ids: connectionIds } : {}),
        }),
      )
    ).json()) as { id: string; agent_token: string; connection_ids: string[] }
  }

  it("binds at create, reports them back, and replaces the whole list on set", async () => {
    const stripe = await makeConnection({ toolkit: "stripe" })
    const gmail = await makeConnection({ toolkit: "gmail" })
    const ctx = await makeContext("Support", [stripe.id])
    expect(ctx.connection_ids).toEqual([stripe.id])

    const set = await app.request(
      `/v1/contexts/${ctx.id}/connections`,
      jsonAs(as(owner.email), { connection_ids: [gmail.id] }),
    )
    expect(set.status).toBe(200)
    // Whole-list replace: stripe is gone, not merged.
    expect((await set.json()).connection_ids).toEqual([gmail.id])
    const read = await (
      await app.request(`/v1/contexts/${ctx.id}`, { headers: as(owner.email) })
    ).json()
    expect(read.connection_ids).toEqual([gmail.id])
  })

  it("enforces the same bind policy as an automation: someone else's personal connection is refused", async () => {
    const theirs = (await (
      await app.request("/v1/connections", jsonAs(as(member.email), { toolkit: "notion" }))
    ).json()) as { id: string }
    const manifest = await publishAs(app, "# m", { title: "Bind" }, as(owner.email))
    const { short_id } = (await manifest.json()) as { short_id: string }
    const res = await app.request(
      "/v1/contexts",
      jsonAs(as(owner.email), {
        name: "Nosy",
        manifest_short_id: short_id,
        connection_ids: [theirs.id],
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/owner/i)
  })

  it("a session claim carries the context's tools, and nothing behind them", async () => {
    const secretValue = "fixture-bearer-context-lane"
    const conn = await makeConnection({
      toolkit: "game",
      kind: "secret",
      secret: secretValue,
      base_url: "https://api.game.test",
      scope: "workspace",
    })
    const ctx = await makeContext("Steward", [conn.id])
    const ask = await app.request(
      `/v1/contexts/${ctx.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "Anything odd today?" }),
    )
    const { session } = (await ask.json()) as { session: { id: string } }

    // Dispatch mints the session capability token the executor claims with.
    const token = await tokenFor(session.id)
    expect(token).toBeTruthy()

    const claim = await app.request("/v1/agent/sessions/claim", jsonAs(bearer(token), {}))
    const text = await claim.text()
    // The executor learns the tool NAMES and nothing else — no credential, and none of
    // RunTool's routing fields, exactly as the run lane's claim behaves.
    expect(text).not.toContain(secretValue)
    expect(text).not.toContain("secret_enc")
    expect(text).not.toContain("connectionId")
    const claimed = JSON.parse(text)
    expect(claimed.tools.map((t: { def: { name: string } }) => t.def.name).sort()).toEqual([
      "game.get",
      "game.post",
    ])

    // And the proxy executes for that session, server-side, with the credential attached
    // here rather than anywhere near the executor.
    const calls: { url: string; auth: string | null }[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") })
      return new Response(JSON.stringify({ flagged: 2 }), { status: 200 })
    }) as typeof fetch
    try {
      const call = await app.request(
        `/v1/agent/sessions/${session.id}/tool`,
        jsonAs(bearer(token), { tool: "game.get", args: { path: "/report" } }),
      )
      expect(call.status).toBe(200)
      expect((await call.json()).result).toEqual({ status: 200, body: { flagged: 2 } })
      expect(calls[0]).toMatchObject({
        url: "https://api.game.test/report",
        auth: `Bearer ${secretValue}`,
      })
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("a BYO polling runner gets the same tools, and may spend them with its standing bearer", async () => {
    const secretValue = "fixture-bearer-byo-lane"
    const conn = await makeConnection({
      toolkit: "ops",
      kind: "secret",
      secret: secretValue,
      base_url: "https://api.ops.test",
      scope: "workspace",
    })
    const ctx = await makeContext("BYO", [conn.id])
    const ask = await app.request(
      `/v1/contexts/${ctx.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "status?" }),
    )
    const { session } = (await ask.json()) as { session: { id: string } }

    // The queue is the BYO runner's door, and it carries the same list the hosted claim does.
    const queue = await app.request(`/v1/contexts/${ctx.id}/queue`, {
      headers: bearer(ctx.agent_token),
    })
    const q = await queue.json()
    expect(q.tools.map((t: { def: { name: string } }) => t.def.name).sort()).toEqual([
      "ops.get",
      "ops.post",
    ])

    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: 1 }), { status: 200 })) as typeof fetch
    try {
      // A standing agent bearer spends them for its OWN context's session — the same
      // latitude the run lane gives a standing bearer for its own runs.
      const mine = await app.request(
        `/v1/agent/sessions/${session.id}/tool`,
        jsonAs(bearer(ctx.agent_token), { tool: "ops.get", args: { path: "/health" } }),
      )
      expect(mine.status).toBe(200)

      // Another context's agent gets nothing, standing bearer or not.
      const other = await makeContext("Other")
      const stolen = await app.request(
        `/v1/agent/sessions/${session.id}/tool`,
        jsonAs(bearer(other.agent_token), { tool: "ops.get", args: { path: "/health" } }),
      )
      expect(stolen.status).toBe(404)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("a base_url-less secret contributes NO tools — there is nothing to call it against", async () => {
    // base_url is optional now (nobody types a host), but the machineless lane resolves a
    // path against it and confines to it. A connection without one can only be SPENT by
    // delivery into a run, so advertising `own.get`/`own.post` here would hand the model two
    // tools that throw on every call. Better to expose none and say why.
    const withHost = await makeConnection({
      toolkit: "hosted",
      kind: "secret",
      secret: "fixture-with-a-host",
      base_url: "https://api.hosted.test",
      scope: "workspace",
    })
    const noHost = await makeConnection({
      toolkit: "delivered",
      kind: "secret",
      secret: "fixture-delivery-only",
      scope: "workspace",
    })
    const ctx = await makeContext("Mixed", [withHost.id, noHost.id])
    const ask = await app.request(
      `/v1/contexts/${ctx.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "?" }),
    )
    const { session } = (await ask.json()) as { session: { id: string } }
    const claim = await (
      await app.request("/v1/agent/sessions/claim", jsonAs(bearer(await tokenFor(session.id)), {}))
    ).json()
    // Only the one with a host. The delivery-only connection stays bound and invisible here.
    expect(claim.tools.map((t: { def: { name: string } }) => t.def.name).sort()).toEqual([
      "hosted.get",
      "hosted.post",
    ])
    // And the proxy refuses the tool it never advertised.
    const call = await app.request(
      `/v1/agent/sessions/${session.id}/tool`,
      jsonAs(bearer(await tokenFor(session.id)), {
        tool: "delivered.get",
        args: { path: "/x" },
      }),
    )
    expect(call.status).toBe(403)
  })

  it("a session token reaches only its OWN session's tools", async () => {
    const conn = await makeConnection({ toolkit: "stripe" })
    const mine = await makeContext("Mine", [conn.id])
    const theirs = await makeContext("Theirs", [conn.id])
    const ask = async (id: string) =>
      (
        (await (
          await app.request(
            `/v1/contexts/${id}/sessions`,
            jsonAs(as(owner.email), { body_md: "?" }),
          )
        ).json()) as { session: { id: string } }
      ).session.id
    const mineSession = await ask(mine.id)
    const theirsSession = await ask(theirs.id)

    const mineToken = await tokenFor(mineSession)
    // Aiming this session's token at the other session's tool endpoint is refused before
    // any tool is resolved — the mirror of the run lane's kind check.
    const cross = await app.request(
      `/v1/agent/sessions/${theirsSession}/tool`,
      jsonAs(bearer(mineToken), { tool: "stripe.read", args: {} }),
    )
    expect(cross.status).toBe(403)
  })

  it("a context with no connections exposes no tools and refuses the proxy", async () => {
    const ctx = await makeContext("Bare")
    expect(ctx.connection_ids).toEqual([])
    const ask = await app.request(
      `/v1/contexts/${ctx.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "hello" }),
    )
    const { session } = (await ask.json()) as { session: { id: string } }
    const token = await tokenFor(session.id)
    const claim = await (
      await app.request("/v1/agent/sessions/claim", jsonAs(bearer(token), {}))
    ).json()
    expect(claim.tools).toEqual([])
    const call = await app.request(
      `/v1/agent/sessions/${session.id}/tool`,
      jsonAs(bearer(token), { tool: "anything.get", args: {} }),
    )
    expect(call.status).toBe(403)
  })
})
