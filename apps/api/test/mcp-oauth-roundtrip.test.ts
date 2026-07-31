import { type ChildProcess, spawn } from "node:child_process"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { afterAll, describe, expect, it } from "vitest"
import { readCredential } from "../src/lib/mcp-oauth"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

/**
 * THE CONSENT ROUND TRIP, against somebody else's OAuth server.
 *
 * Every other test of this flow drives a server written in this repo, which agrees with our
 * reading of the spec by construction — and a misreading shared by the client and its test server
 * is invisible. This one runs the MCP SDK's OWN reference implementation
 * (`examples/server/simpleStreamableHttp --oauth`, the maintainers' `DemoInMemoryAuthProvider`)
 * and drives the whole thing: 401, discovery, dynamic registration, consent, the code exchange,
 * the re-pin, and finally a tool call authorized by the token that came out.
 *
 * NO NETWORK AND NO ACCOUNT, so unlike the `LIVE_MCP=1` suites this runs in CI. The reference
 * provider simulates the login and redirects straight back with a code, which is exactly the step
 * a real vendor needs a human for. What it therefore CANNOT prove is any one vendor's quirks —
 * Stripe's authorization server living on another origin, Linear's scope list — and those are
 * covered separately in live-oauth.test.ts up to the consent screen.
 *
 * The server is deliberately reached the same way a stranger's would be: over real HTTP, on a
 * real port, in another process.
 *
 * `express` is an apps/api devDependency for this and nothing else: the reference server needs it,
 * and it is spawned rather than imported, so knip cannot see the use (hence the ignore in
 * knip.json). Nothing in src/ touches it.
 */

const require = createRequire(import.meta.url)

/** An OS-assigned free port, so two of these can run at once and CI never collides. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

const children: ChildProcess[] = []
afterAll(() => {
  for (const c of children) c.kill("SIGKILL")
})

const startReferenceServer = async () => {
  const mcpPort = await freePort()
  const authPort = await freePort()
  const entry = require.resolve("@modelcontextprotocol/sdk/examples/server/simpleStreamableHttp.js")
  const child = spawn(process.execPath, [entry, "--oauth"], {
    env: { ...process.env, MCP_PORT: String(mcpPort), MCP_AUTH_PORT: String(authPort) },
    stdio: "ignore",
  })
  children.push(child)

  // Poll until it answers rather than sleeping a guessed interval.
  const url = `http://localhost:${mcpPort}/mcp`
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(
        `http://localhost:${mcpPort}/.well-known/oauth-protected-resource/mcp`,
      )
      if (res.ok) return { url, mcpPort, authPort }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("the reference MCP server never came up")
}

// Prefixed like the other suites' keys (hosted-mcp-source, mcp-oauth): long enough for the
// cipher, and shaped so a secret scanner does not have to guess whether it is real.
const SECRET = "zz-roundtrip-test-key-not-a-secret-value"
const owner: TestUser = { id: "u_rt", email: "rt@derive.test", name: "O" }
const { app, meta } = makeAuthedApp("mcp-oauth-roundtrip", [owner], "editor", {
  deps: { encryptionKey: SECRET, baseUrl: "https://derive.test" },
})

describe("signing in, end to end, against the MCP SDK's reference server", () => {
  it("401 → consent → token → re-pin → a tool call that spends it", async () => {
    const server = await startReferenceServer()

    // 1. CONNECT. The server refuses without a token, so the row is parked pending and unpinned.
    const created = await app.request(
      "/v1/connections",
      jsonAs(as(owner.email), { toolkit: "reference", mcp_url: server.url }),
    )
    const conn = (await created.json()) as { id: string; status: string; reason?: string }
    expect(created.status).toBe(201)
    expect(conn.status).toBe("pending")
    expect(conn.reason).toBe("auth_required")

    // 2. AUTHORIZE. Discovery here is genuinely path-aware — this server advertises its metadata
    // at /.well-known/oauth-protected-resource/mcp and its authorization server on another port —
    // and the client registers itself, since nothing was pre-arranged between these two processes.
    const authorize = await app.request(`/v1/connections/${conn.id}/authorize`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(authorize.status).toBe(200)
    const { authorize_url } = (await authorize.json()) as { authorize_url: string }
    const authUrl = new URL(authorize_url)
    expect(authUrl.port).toBe(String(server.authPort))
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256")

    // 3. CONSENT. The reference provider simulates the login and redirects back with a code —
    // the one step a real vendor needs a human for.
    const consent = await fetch(authorize_url, { redirect: "manual" })
    expect([302, 303].includes(consent.status), `consent returned ${consent.status}`).toBe(true)
    const back = new URL(consent.headers.get("location") ?? "")
    expect(back.pathname).toBe("/v1/connections/oauth/callback")
    const code = back.searchParams.get("code")
    const state = back.searchParams.get("state")
    expect(code, "no authorization code came back").toBeTruthy()

    // 4. CALLBACK. The code is exchanged for a real token, against a token endpoint that verifies
    // our PKCE verifier — so a verifier that failed to survive the round trip fails right here.
    const callback = await app.request(
      `/v1/connections/oauth/callback?code=${encodeURIComponent(code ?? "")}&state=${encodeURIComponent(state ?? "")}`,
      { headers: as(owner.email) },
    )
    expect(callback.status, await callback.clone().text()).toBe(302)
    expect(callback.headers.get("location")).toContain("/settings/sources?connected=1")

    // 5. THE ROW IS NOW USABLE, which needs both halves: a stored token, and a pin that could only
    // have been computed by listing the tools with it.
    const [row] = await meta.getConnectionsByIds([conn.id])
    expect(row?.status).toBe("active")
    expect(row?.broker_ref).toMatch(/^mcp:s256-[0-9a-f]{16,}:/)
    const stored = readCredential(row?.secret_enc ?? null, SECRET)
    expect(stored.kind).toBe("oauth")
    if (stored.kind === "oauth") {
      expect(stored.cred.access_token.length).toBeGreaterThan(8)
      expect(stored.cred.token_endpoint).toContain(String(server.authPort))
    }

    // 6. AND IT SPENDS. Everything above could be true of a token nobody ever sent anywhere; the
    // point of the credential is that the server accepts it, so call a tool and require a result.
    // The same server answered 401 to the unauthenticated connect at step 1.
    const { McpBroker } = await import("@derive/broker")
    const broker = new McpBroker(undefined, () =>
      stored.kind === "oauth" ? stored.cred.access_token : undefined,
    )
    const tools = await broker.toolsFor([row?.broker_ref ?? ""])
    expect(tools.length, "no tools came back with the token").toBeGreaterThan(0)

    const greet = tools.find((t) => /greet/i.test(t.name)) ?? tools[0]
    const out = await broker.execute({
      ref: row?.broker_ref ?? "",
      tool: greet?.name ?? "",
      args: { name: "Derive" },
    })
    expect(JSON.stringify(out)).toContain("Derive")
  }, 60_000)
})
