import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, describe, expect, it } from "vitest"
import { readCredential } from "../src/lib/mcp-oauth"
import { requestedScope } from "../src/routes/mcp-oauth"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// Connecting an MCP server by SIGNING IN.
//
// Driven against a fake server that behaves the way Stripe's real one does — verified by fetching
// it: 401 at the root until authorized, protected-resource metadata pointing at an authorization
// server, that server advertising dynamic registration, PKCE S256 and a PUBLIC client
// (`token_endpoint_auth_methods_supported: ["none"]`). A stub that skipped any of those would be
// testing a flow no real server offers.
//
// The protocol itself comes from @modelcontextprotocol/sdk, which is already a dependency and was
// verified to run in workerd. What these tests cover is the part that is ours: the row's state
// machine (pending until consent returns), who is allowed to finish a flow someone else started,
// and the RE-PIN — because a pinned tool list is the whole tool-poisoning defense and an OAuth
// connection cannot be pinned until after the callback.

const SECRET = "mcp-oauth-test-secret-at-least-16-chars"
const owner: TestUser = { id: "u_oa", email: "oa@derive.test", name: "O" }
const other: TestUser = { id: "u_ob", email: "ob@derive.test", name: "B" }
const { app, meta } = makeAuthedApp("mcp-oauth", [owner, other], "editor", {
  deps: { encryptionKey: SECRET, baseUrl: "https://derive.test" },
})

const servers: Server[] = []
afterAll(() => {
  for (const s of servers) s.close()
})

/** A server that is 401 until it sees the token it issued, and a matching authorization server. */
const startOauthServer = async (opts: { issue?: string } = {}) => {
  const token = opts.issue ?? "at_live_1"
  const state = { registered: 0, exchanged: 0, refreshed: 0, lastCodeVerifier: "" }
  const server: Server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => {
      raw += c
    })
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x")
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
      }
      // 127.0.0.1, not localhost, ON PURPOSE: every real MCP host has dots in it
      // (`mcp.stripe.com`), and the signed state is packed by a helper whose field separator is
      // also a dot. A dotless test host would let that mismatch through.
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      // --- discovery -------------------------------------------------------------------------
      if (url.pathname === "/.well-known/oauth-protected-resource")
        return json(200, { resource: base, authorization_servers: [base] })
      // Stripe serves its AS metadata ONLY at the path-aware location; the root is a 404. Mirror
      // that, so a client that only tries the root fails here exactly as it would in production.
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["mcp"],
        })
      if (url.pathname === "/register") {
        state.registered += 1
        return json(201, { client_id: "client_abc", redirect_uris: [] })
      }
      if (url.pathname === "/token") {
        const body = new URLSearchParams(raw)
        state.lastCodeVerifier = body.get("code_verifier") ?? ""
        if (body.get("grant_type") === "refresh_token") {
          state.refreshed += 1
          return json(200, { access_token: "at_refreshed", token_type: "bearer", expires_in: 3600 })
        }
        state.exchanged += 1
        return json(200, {
          access_token: token,
          refresh_token: "rt_1",
          token_type: "bearer",
          expires_in: 3600,
        })
      }

      // --- the MCP surface itself -----------------------------------------------------------
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}"` })
        return res.end(JSON.stringify({ error: "unauthorized" }))
      }
      const msg = JSON.parse(raw || "{}") as { id?: number; method?: string }
      const result =
        msg.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : msg.method === "tools/list"
            ? { tools: [{ name: "get_balance", description: "Account balance." }] }
            : { content: [] }
      return json(200, { jsonrpc: "2.0", id: msg.id, result })
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  servers.push(server)
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const connect = async (body: Record<string, unknown>, who = owner) => {
  const res = await app.request("/v1/connections", jsonAs(as(who.email), body))
  return { status: res.status, body: (await res.json()) as Record<string, string> }
}

describe("connecting an MCP server by signing in", () => {
  it("a 401 parks the connection PENDING and offers authorization", async () => {
    const srv = await startOauthServer()
    const created = await connect({ toolkit: "billing", mcp_url: srv.url })
    expect(created.status).toBe(201)
    expect(created.body.status).toBe("pending")
    expect(created.body.reason).toBe("auth_required")

    // Pending means UNUSABLE, not merely unfinished: the ref carries no pin, and an unpinned ref
    // is refused outright — which is what stops a half-connected source reaching a run.
    const [row] = await meta.getConnectionsByIds([created.body.id as string])
    expect(row?.broker_ref.endsWith(":")).toBe(false)
    expect(row?.broker_ref).toContain("mcp::")
    expect(row?.secret_enc ?? null).toBeNull()
  })

  it("authorize → callback stores a token, PINS the tool list, and activates", async () => {
    const srv = await startOauthServer()
    const created = await connect({ toolkit: "billing", mcp_url: srv.url })
    const id = created.body.id as string

    const auth = await app.request(`/v1/connections/${id}/authorize`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(auth.status).toBe(200)
    const { authorize_url } = (await auth.json()) as { authorize_url: string }
    const u = new URL(authorize_url)
    // PKCE and the resource binding are the SDK's job; assert they actually happened.
    expect(u.searchParams.get("code_challenge_method")).toBe("S256")
    expect(u.searchParams.get("code_challenge")).toBeTruthy()
    expect(u.searchParams.get("state")).toBeTruthy()
    expect(srv.state.registered, "registered dynamically, no vendor setup").toBe(1)

    const cb = await app.request(
      `/v1/connections/oauth/callback?code=authcode&state=${encodeURIComponent(u.searchParams.get("state") ?? "")}`,
      { headers: as(owner.email) },
    )
    expect(cb.status).toBe(302)
    expect(srv.state.exchanged).toBe(1)
    expect(srv.state.lastCodeVerifier, "the verifier survived the round trip").toBeTruthy()

    const [row] = await meta.getConnectionsByIds([id])
    expect(row?.status).toBe("active")
    // THE RE-PIN. `connect()` cannot pin an OAuth connection — there is no credential to list
    // with until consent returns — so the callback lists and pins. Without this the ref stays
    // unpinned and every run refuses the source.
    expect(row?.broker_ref).toMatch(/^mcp:s256-[0-9a-f]+:/)
    const stored = readCredential(row?.secret_enc ?? null, SECRET)
    expect(stored.kind).toBe("oauth")
    if (stored.kind === "oauth") {
      expect(stored.cred.access_token).toBe("at_live_1")
      expect(stored.cred.refresh_token).toBe("rt_1")
      expect(stored.cred.expires_at).toBeGreaterThan(Date.now())
    }
  })

  it("asks for the narrowest scopes the server offers, never everything", async () => {
    // Caught on a real consent screen: Linear advertises `read write openid email`, and asking
    // for all of it made "Derive is requesting access" say Read, WRITE, Identity, Email — for a
    // feature whose own description is "your agents can read from it".
    expect(requestedScope(["read", "write", "openid", "email"])).toBe("read openid email")
    expect(requestedScope(["org:read", "project:write", "team:write", "event:write"])).toBe(
      "org:read",
    )
    // A single opaque scope is not a privilege claim we can second-guess — Stripe's is just "mcp".
    expect(requestedScope(["mcp"])).toBe("mcp")
    expect(requestedScope(["default"])).toBe("default")
    // Nothing recognisably narrow, and nothing advertised at all, both defer to the server's own
    // default rather than inventing a request.
    expect(requestedScope(["write"])).toBeUndefined()
    expect(requestedScope([])).toBeUndefined()
    expect(requestedScope(undefined)).toBeUndefined()
  })

  it("registers ONCE per server, however many times you press Sign in", async () => {
    // Registration is not idempotent: Linear hands back a fresh client_id for byte-identical
    // metadata every time. So a Sign in pressed three times, or a consent screen abandoned twice
    // before someone finishes, would leave three OAuth clients at the provider -- on an endpoint
    // that is a standing rate-limit and abuse target.
    const srv = await startOauthServer()
    const created = await connect({ toolkit: "billing", mcp_url: srv.url })
    const id = created.body.id as string

    const clientIds = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const auth = await app.request(`/v1/connections/${id}/authorize`, {
        method: "POST",
        headers: as(owner.email),
      })
      expect(auth.status).toBe(200)
      const { authorize_url } = (await auth.json()) as { authorize_url: string }
      clientIds.add(new URL(authorize_url).searchParams.get("client_id") ?? "")
    }
    expect(srv.state.registered).toBe(1)
    expect(clientIds.size, "the same client every time").toBe(1)

    // And finishing still works on the reused client — the reuse must not have cost the flow
    // anything, which is the failure mode a registration-count assertion alone would miss.
    const auth = await app.request(`/v1/connections/${id}/authorize`, {
      method: "POST",
      headers: as(owner.email),
    })
    const { authorize_url } = (await auth.json()) as { authorize_url: string }
    const state = new URL(authorize_url).searchParams.get("state") ?? ""
    const cb = await app.request(
      `/v1/connections/oauth/callback?code=authcode&state=${encodeURIComponent(state)}`,
      { headers: as(owner.email) },
    )
    expect(cb.status).toBe(302)
    const [row] = await meta.getConnectionsByIds([id])
    expect(row?.status).toBe("active")
    expect(readCredential(row?.secret_enc ?? null, SECRET).kind).toBe("oauth")
  })

  it("someone else cannot finish a flow you started, even holding the link", async () => {
    // Signed state proves who STARTED it and rides in a URL, so it is replayable inside its
    // window. Only a live session can prove who FINISHES it.
    const srv = await startOauthServer()
    const created = await connect({ toolkit: "billing", mcp_url: srv.url })
    const auth = await app.request(`/v1/connections/${created.body.id}/authorize`, {
      method: "POST",
      headers: as(owner.email),
    })
    const { authorize_url } = (await auth.json()) as { authorize_url: string }
    const state = new URL(authorize_url).searchParams.get("state") ?? ""

    const stolen = await app.request(
      `/v1/connections/oauth/callback?code=authcode&state=${encodeURIComponent(state)}`,
      { headers: as(other.email) },
    )
    expect(stolen.status).toBe(403)
    const [row] = await meta.getConnectionsByIds([created.body.id as string])
    expect(row?.status, "and the connection is untouched").toBe("pending")
  })

  it("a tampered or expired state is refused", async () => {
    const res = await app.request("/v1/connections/oauth/callback?code=x&state=not-a-real-state", {
      headers: as(owner.email),
    })
    expect(res.status).toBe(400)
    expect(String(((await res.json()) as { error: string }).error)).toMatch(/expired|invalid/i)
  })

  it("a pasted-key connection is untouched by any of this", async () => {
    // The two credential shapes coexist forever: plenty of MCP servers offer no OAuth at all.
    const srv = await startOauthServer({ issue: "at_live_1" })
    const created = await connect({
      toolkit: "pasted",
      mcp_url: srv.url,
      mcp_secret: "at_live_1",
    })
    expect(created.status).toBe(201)
    expect(created.body.status).toBe("active")
    const [row] = await meta.getConnectionsByIds([created.body.id as string])
    expect(readCredential(row?.secret_enc ?? null, SECRET)).toEqual({
      kind: "bearer",
      token: "at_live_1",
    })
  })
})
