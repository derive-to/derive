import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import Database from "better-sqlite3"
import { zipSync } from "fflate"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"

// The remote MCP endpoint (/mcp) authenticated by an OAuth bearer. We seed a grant
// straight into the oauth-provider tables (what the consent dance produces), publish
// an artifact as that scoped agent, then drive the MCP JSON-RPC handshake + tools
// over Streamable HTTP and assert the agent sees its own workspace.

const dir = mkdtempSync(join(tmpdir(), "dock-mcp-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function appWithGrant(name: string, scopes: string) {
  const path = join(dir, `${name}.db`)
  const meta = new SqliteMetaStore(path)
  const db = new Database(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT);
    CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
  `)
  db.prepare(
    `INSERT OR IGNORE INTO "user"(id,email,name) VALUES('u_o','owner@x.test','Owner')`,
  ).run()
  db.prepare(`INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli','Claude')`).run()
  db.prepare(
    `INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`,
  ).run(
    sha256(`tok_${name}`),
    "cli",
    "u_o",
    JSON.stringify(scopes.split(/\s+/).filter(Boolean)),
    new Date(Date.now() + 3_600_000).toISOString(),
  )
  db.close()
  const app = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, `${name}-blobs`)),
    baseUrl: "http://dock.test",
    token: "tok",
  })
  return { app, token: `tok_${name}` }
}

type App = ReturnType<typeof createApp>

// POST one JSON-RPC message and return the parsed response, handling both a plain
// JSON body and an SSE-framed (text/event-stream) response.
async function rpc(app: App, token: string | null, body: unknown) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await app.request("/mcp", { method: "POST", headers, body: JSON.stringify(body) })
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  let parsed: { result?: unknown; error?: unknown } | null = null
  if (ct.includes("application/json")) {
    parsed = JSON.parse(txt)
  } else if (ct.includes("text/event-stream")) {
    const dataLine = txt.split("\n").find((l) => l.startsWith("data:"))
    if (dataLine) parsed = JSON.parse(dataLine.slice(5).trim())
  }
  return { status: res.status, ct, txt, parsed, wwwAuth: res.headers.get("www-authenticate") }
}

type RpcOut = Awaited<ReturnType<typeof rpc>>
// The text payload of a tools/call result (throws with context if absent).
const toolText = (r: RpcOut): string => {
  const t = (r.parsed?.result as { content?: { text: string }[] } | undefined)?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text in response: ${JSON.stringify(r.parsed)}`)
  return t
}
const toolNames = (r: RpcOut): string[] =>
  ((r.parsed?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((t) => t.name)

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "1.0.0" },
  },
}

const publish = (app: App, token: string, title: string) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(`<h1>${title}</h1>`)]), "index.html")
  form.append("title", title)
  form.append("visibility", "link")
  return app.request("/v1/artifacts", {
    method: "POST",
    body: form,
    headers: { authorization: `Bearer ${token}` },
  })
}

describe("remote MCP endpoint (/mcp)", () => {
  it("rejects an unauthenticated connect with 401 + WWW-Authenticate", async () => {
    const { app } = appWithGrant("noauth", "openid dock:read")
    const r = await rpc(app, null, initBody)
    expect(r.status).toBe(401)
    expect(r.wwwAuth).toContain("oauth-protected-resource")
  })

  it("initializes (identity in instructions) and lists the consolidated tools", async () => {
    const { app, token } = appWithGrant("init", "openid dock:read dock:publish")
    const init = await rpc(app, token, initBody)
    const result = init.parsed?.result as { serverInfo?: { name: string }; instructions?: string }
    expect(result.serverInfo).toMatchObject({ name: "dock" })
    // Identity rides in the server instructions, not a whoami tool.
    expect(result.instructions).toContain("Claude")
    expect(result.instructions).toContain("editor")

    const list = await rpc(app, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const names = toolNames(list)
    expect(names).toEqual(
      expect.arrayContaining([
        "list_artifacts",
        "catch_me_up",
        "read",
        "diff",
        "list_comments",
        "list_versions",
        "propose",
      ]),
    )
    // Consolidated away: no whoami / read_artifact / read_section.
    expect(names).not.toContain("whoami")
    expect(names).not.toContain("read_artifact")
    expect(names).not.toContain("read_section")
  })

  const call = (app: App, token: string, name: string, args: Record<string, unknown> = {}) =>
    rpc(app, token, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name, arguments: args },
    })

  it("list_artifacts + read see the agent's own published artifact", async () => {
    const { app, token } = appWithGrant("read", "openid dock:read dock:publish")
    const pub = await publish(app, token, "My Plan")
    expect(pub.status).toBe(201)
    const shortId = (await pub.json()).short_id

    const list = await call(app, token, "list_artifacts")
    const listOut = JSON.parse(toolText(list))
    expect(listOut.artifacts.some((a: { short_id: string }) => a.short_id === shortId)).toBe(true)

    const read = await call(app, token, "read", { short_id: shortId })
    const readOut = JSON.parse(toolText(read))
    expect(readOut.title).toBe("My Plan")
    expect(readOut.content).toContain("My Plan")
  })

  it("diff + catch_me_up report what changed between versions", async () => {
    const { app, token } = appWithGrant("diff", "openid dock:read dock:publish")
    const shortId = (await (await publish(app, token, "V1 Title")).json()).short_id

    // Republish a second version with different content.
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>V2 Title</h1>")]), "index.html")
    form.append("name", "rev 2")
    const rep = await app.request(`/v1/artifacts/${shortId}/versions`, {
      method: "POST",
      body: form,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(rep.status).toBe(201)

    const d = JSON.parse(
      toolText(await call(app, token, "diff", { short_id: shortId, from: 1, to: 2 })),
    )
    expect(d.entry_diff).toContain("V2 Title")

    const c = JSON.parse(
      toolText(await call(app, token, "catch_me_up", { short_id: shortId, since_version: 1 })),
    )
    expect(c.head).toBe(2)
    expect(c.new_versions.map((v: { n: number }) => v.n)).toContain(2)
    expect(c.summary).toContain("v2") // prose summary up top
    expect(c.caught_up).toBe(false)
    expect(c.entry_diff).not.toContain("V2 Title") // omitted by default (token-light)

    // 'detailed' includes the line diff inline.
    const cd = JSON.parse(
      toolText(
        await call(app, token, "catch_me_up", {
          short_id: shortId,
          since_version: 1,
          response_format: "detailed",
        }),
      ),
    )
    expect(cd.entry_diff).toContain("V2 Title")
  })

  it("read + catch_me_up handle multi-page bundles", async () => {
    const { app, token } = appWithGrant("bundle", "openid dock:read dock:publish")
    const enc = (s: string) => new TextEncoder().encode(s)
    const postZip = (
      files: Record<string, Uint8Array>,
      fields: Record<string, string>,
      id?: string,
    ) => {
      const form = new FormData()
      form.append("file", new Blob([zipSync(files)]), "site.zip")
      for (const [k, v] of Object.entries(fields)) form.append(k, v)
      return app.request(id ? `/v1/artifacts/${id}/versions` : "/v1/artifacts", {
        method: "POST",
        body: form,
        headers: { authorization: `Bearer ${token}` },
      })
    }
    const pj = await (
      await postZip(
        { "index.html": enc("<h1>Home</h1>"), "page.html": enc("<h1>Page</h1>") },
        { title: "Site", visibility: "link" },
      )
    ).json()
    expect(pj.kind).toBe("bundle")
    const shortId = pj.short_id

    // No section → outline (the bundle's pages).
    const pages = JSON.parse(toolText(await call(app, token, "read", { short_id: shortId })))
    expect(pages.pages).toEqual(expect.arrayContaining(["index.html", "page.html"]))
    // A section → that page's content.
    const page = JSON.parse(
      toolText(await call(app, token, "read", { short_id: shortId, section: "page.html" })),
    )
    expect(page.content).toContain("Page")

    // Republish with a new page; catch_me_up reports it under pages_changed.added.
    await postZip(
      {
        "index.html": enc("<h1>Home</h1>"),
        "page.html": enc("<h1>Page</h1>"),
        "new.html": enc("<h1>New</h1>"),
      },
      { name: "rev 2" },
      shortId,
    )
    const cu = JSON.parse(
      toolText(await call(app, token, "catch_me_up", { short_id: shortId, since_version: 1 })),
    )
    expect(cu.pages_changed.added).toContain("new.html")
  })

  it("propose stages a revision for review without going live", async () => {
    // Editor grant so the setup publish works; over MCP even an editor only gets
    // `propose` (no direct-publish tool), so the candidate still never auto-goes-live.
    const { app, token } = appWithGrant("propose", "openid dock:read dock:publish")
    const shortId = (await (await publish(app, token, "Draft")).json()).short_id

    const p = JSON.parse(
      toolText(
        await call(app, token, "propose", {
          short_id: shortId,
          content: "<h1>Revised draft</h1>",
          message: "tightened the intro",
        }),
      ),
    )
    expect(p.proposed).toBe(true)
    expect(p.proposal_id).toBeTruthy()
    expect(p.base_version).toBe(1)

    // The live version is untouched — a proposal is not a publish.
    const read = JSON.parse(toolText(await call(app, token, "read", { short_id: shortId })))
    expect(read.version).toBe(1)
    expect(read.content).toContain("Draft")
    expect(read.content).not.toContain("Revised")
  })

  it("surfaces outdated feedback after a republish drops the quoted text", async () => {
    const { app, token } = appWithGrant("stale", "openid dock:read dock:comment dock:publish")
    const shortId = (await (await publish(app, token, "alpha beta gamma")).json()).short_id

    // A comment anchored to "beta".
    await app.request(`/v1/artifacts/${shortId}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        body_md: "tighten this",
        anchor: { type: "TextQuoteSelector", exact: "beta", prefix: "alpha ", suffix: " gamma" },
      }),
    })

    // Republish without "beta" — the sweep should mark the thread outdated.
    const form = new FormData()
    form.append(
      "file",
      new Blob([new TextEncoder().encode("<h1>alpha gamma delta</h1>")]),
      "index.html",
    )
    form.append("name", "rev 2")
    await app.request(`/v1/artifacts/${shortId}/versions`, {
      method: "POST",
      body: form,
      headers: { authorization: `Bearer ${token}` },
    })

    // list_comments reports the new state + the quoted text the thread targets.
    const all = JSON.parse(toolText(await call(app, token, "list_comments", { short_id: shortId })))
    expect(all.comments[0].state).toBe("outdated")
    expect(all.comments[0].quote).toBe("beta")
    const onlyStale = JSON.parse(
      toolText(await call(app, token, "list_comments", { short_id: shortId, state: "outdated" })),
    )
    expect(onlyStale.count).toBe(1)

    // catch_me_up leads with it so the agent knows its edits touched commented text.
    const cu = JSON.parse(
      toolText(await call(app, token, "catch_me_up", { short_id: shortId, since_version: 1 })),
    )
    expect(cu.summary).toContain("outdated")
    expect(cu.outdated_comments).toHaveLength(1)
    expect(cu.outdated_comments[0].quote).toBe("beta")
  })

  it("propose with `addresses` marks the cited threads addressed (pending review)", async () => {
    const { app, token } = appWithGrant("addr", "openid dock:read dock:comment dock:publish")
    const shortId = (await (await publish(app, token, "headline to fix")).json()).short_id
    const cm = await (
      await app.request(`/v1/artifacts/${shortId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ body_md: "fix the headline" }),
      })
    ).json()

    const p = JSON.parse(
      toolText(
        await call(app, token, "propose", {
          short_id: shortId,
          content: "<h1>fixed headline</h1>",
          message: "fixed it",
          addresses: [cm.thread_id],
        }),
      ),
    )
    expect(p.proposed).toBe(true)
    expect(p.addressed).toEqual([cm.thread_id])

    // The thread is now addressed — off the open list, listed under `addressed`.
    const open = JSON.parse(
      toolText(await call(app, token, "list_comments", { short_id: shortId, state: "open" })),
    )
    expect(open.count).toBe(0)
    const addr = JSON.parse(
      toolText(await call(app, token, "list_comments", { short_id: shortId, state: "addressed" })),
    )
    expect(addr.count).toBe(1)
    expect(addr.comments[0].state).toBe("addressed")

    // catch_me_up flags it so the agent won't re-propose the same fix.
    const cu = JSON.parse(toolText(await call(app, token, "catch_me_up", { short_id: shortId })))
    expect(cu.summary).toContain("addressed")
  })

  // Regression guard for the "Needs Auth" outage: a remote MCP client (Claude
  // Code / claude.ai), because it sends an RFC 8707 `resource` indicator, gets a
  // SIGNED JWT access token rather than the opaque token. The server must verify
  // it against the JWKS read from Better Auth's store on this instance — NOT by
  // HTTP-fetching its own /api/auth/jwks, which a Cloudflare Worker can't do.
  // This mints a real JWT, exposes the public key via a getJwks() stub, and
  // asserts /mcp accepts it. It FAILS against a createRemoteJWKSet (self-fetch)
  // implementation, so it pins the verification path in place.
  it("authenticates an OAuth JWT access token via the local JWKS", async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true })
    const kid = "test-jwt-kid"
    const jwk = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" }

    // Seed the granting user + client the JWT claims will resolve to, then build
    // an app whose auth exposes the matching public JWKS (no network).
    const path = join(dir, "jwtauth.db")
    const meta = new SqliteMetaStore(path)
    const seed = new Database(path)
    seed.exec(`
      CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT);
      CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
    `)
    seed
      .prepare(`INSERT OR IGNORE INTO "user"(id,email,name) VALUES('u_jwt','j@x.test','Jay')`)
      .run()
    seed.prepare(`INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli','Claude')`).run()
    seed.close()

    const app = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, "jwtauth-blobs")),
      baseUrl: "http://dock.test",
      token: "tok",
      auth: {
        handler: async () => new Response(null, { status: 404 }),
        api: { getJwks: async () => ({ keys: [jwk] }) },
      } as unknown as Parameters<typeof createApp>[0]["auth"],
    })

    const mint = (over: Record<string, unknown> = {}) =>
      new SignJWT({ scope: "openid dock:read dock:publish", azp: "cli", ...over })
        .setProtectedHeader({ alg: "EdDSA", kid })
        .setSubject("u_jwt")
        .setIssuer("http://dock.test/api/auth")
        .setExpirationTime("1h")
        .sign(privateKey)

    // A valid JWT authenticates and resolves the agent's role from its scopes.
    const ok = await rpc(app, await mint(), initBody)
    expect(ok.status).toBe(200)
    expect((ok.parsed?.result as { instructions?: string }).instructions).toContain("editor")

    // A tampered signature is rejected (401), not silently trusted.
    const good = await mint()
    const tampered = `${good.slice(0, -6)}AAAAAA`
    const bad = await rpc(app, tampered, initBody)
    expect(bad.status).toBe(401)

    // Wrong issuer is rejected too (the verify pins `issuer`).
    const wrongIss = await new SignJWT({ scope: "openid dock:read", azp: "cli" })
      .setProtectedHeader({ alg: "EdDSA", kid })
      .setSubject("u_jwt")
      .setIssuer("http://evil.test/api/auth")
      .setExpirationTime("1h")
      .sign(privateKey)
    expect((await rpc(app, wrongIss, initBody)).status).toBe(401)
  })

  it("publish creates a NEW artifact (first publish) and then a new version of it", async () => {
    const { app, token } = appWithGrant("pub", "openid dock:read dock:publish")

    // First publish — no short_id, so it creates a brand-new artifact.
    const created = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "My First Doc",
          content: "<h1>hello world</h1>",
        }),
      ),
    )
    expect(created.published).toBe(true)
    expect(created.version).toBe(1)
    expect(created.title).toBe("My First Doc")
    expect(created.short_id).toBeTruthy()
    expect(created.url).toContain(created.short_id)
    expect(created.visibility).toBe("org") // workspace-private by default

    // It's really there: list_artifacts + read see it live.
    const list = JSON.parse(toolText(await call(app, token, "list_artifacts")))
    expect(list.artifacts.some((a: { short_id: string }) => a.short_id === created.short_id)).toBe(
      true,
    )
    const read = JSON.parse(
      toolText(await call(app, token, "read", { short_id: created.short_id })),
    )
    expect(read.content).toContain("hello world")

    // Publishing again WITH the short_id pushes a new version (not a second artifact).
    const v2 = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          short_id: created.short_id,
          content: "<h1>hello again</h1>",
          message: "tweak",
        }),
      ),
    )
    expect(v2.short_id).toBe(created.short_id)
    expect(v2.version).toBe(2)
  })

  it("publish needs a title to create, and a publish-capable grant", async () => {
    // A new-artifact publish with no title is refused.
    const { app, token } = appWithGrant("pub2", "openid dock:read dock:publish")
    const noTitle = await call(app, token, "publish", { content: "<h1>x</h1>" })
    expect(toolText(noTitle)).toContain("title")

    // A comment-only grant can't publish at all — steered to propose.
    const weak = appWithGrant("pub3", "openid dock:read dock:comment")
    const denied = await call(weak.app, weak.token, "publish", {
      title: "Nope",
      content: "<h1>x</h1>",
    })
    expect(toolText(denied)).toContain("propose")
  })

  it("publish creates and republishes a multi-page bundle via the files map", async () => {
    const { app, token } = appWithGrant("pubbundle", "openid dock:read dock:publish")

    // A files map (no short_id) creates a new BUNDLE — index.html is the entry.
    const created = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "My Site",
          files: {
            "index.html": "<h1>Home</h1>",
            "about.html": "<h1>About</h1>",
            "nav.js": "/* nav */",
          },
        }),
      ),
    )
    expect(created.published).toBe(true)
    expect(created.kind).toBe("bundle")
    const shortId = created.short_id

    // read returns the outline (its pages), and a section returns that page.
    const outline = JSON.parse(toolText(await call(app, token, "read", { short_id: shortId })))
    expect(outline.pages).toEqual(expect.arrayContaining(["index.html", "about.html", "nav.js"]))
    const about = JSON.parse(
      toolText(await call(app, token, "read", { short_id: shortId, section: "about.html" })),
    )
    expect(about.content).toContain("About")

    // Republishing the full files map (with an added page) pushes version 2.
    const v2 = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          short_id: shortId,
          files: {
            "index.html": "<h1>Home</h1>",
            "about.html": "<h1>About</h1>",
            "nav.js": "/* nav */",
            "new.html": "<h1>New</h1>",
          },
          message: "add new page",
        }),
      ),
    )
    expect(v2.version).toBe(2)
    const cu = JSON.parse(
      toolText(await call(app, token, "catch_me_up", { short_id: shortId, since_version: 1 })),
    )
    expect(cu.pages_changed.added).toContain("new.html")
  })

  it("publish steers between content and files by kind", async () => {
    const { app, token } = appWithGrant("pubkind", "openid dock:read dock:publish")

    // content + files together is rejected.
    const both = await call(app, token, "publish", {
      title: "x",
      content: "<h1>x</h1>",
      files: { "index.html": "<h1>x</h1>" },
    })
    expect(toolText(both)).toContain("not both")

    // A single-file artifact can't be republished as a bundle.
    const file = JSON.parse(
      toolText(await call(app, token, "publish", { title: "Doc", content: "<h1>doc</h1>" })),
    )
    const asBundle = await call(app, token, "publish", {
      short_id: file.short_id,
      files: { "index.html": "<h1>doc</h1>" },
    })
    expect(toolText(asBundle)).toContain("single-file")

    // A bundle can't be republished with a single `content` string.
    const bundle = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "Site",
          files: { "index.html": "<h1>home</h1>" },
        }),
      ),
    )
    const asFile = await call(app, token, "publish", {
      short_id: bundle.short_id,
      content: "<h1>home</h1>",
    })
    expect(toolText(asFile)).toContain("bundle")
  })
})
