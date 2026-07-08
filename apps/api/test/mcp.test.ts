import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { zipSync } from "fflate"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"

// The remote MCP endpoint (/mcp) authenticated by an OAuth bearer. We seed a grant
// straight into the oauth-provider tables (what the consent dance produces), publish
// an artifact as that scoped agent, then drive the MCP JSON-RPC handshake + tools
// over Streamable HTTP and assert the agent sees its own workspace. The tool surface
// is the consolidated five: list_artifacts, read, catch_up, comment, publish.

const dir = mkdtempSync(join(tmpdir(), "derive-mcp-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function appWithGrant(name: string, scopes: string) {
  const path = join(dir, `${name}.db`)
  const meta = new SqliteMetaStore(path)
  const db = new Database(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT);
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
    baseUrl: "http://derive.test",
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

const call = (app: App, token: string, name: string, args: Record<string, unknown> = {}) =>
  rpc(app, token, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name, arguments: args },
  })

describe("remote MCP endpoint (/mcp)", () => {
  it("rejects an unauthenticated connect with 401 + WWW-Authenticate", async () => {
    const { app } = appWithGrant("noauth", "openid derive:read")
    const r = await rpc(app, null, initBody)
    expect(r.status).toBe(401)
    expect(r.wwwAuth).toContain("oauth-protected-resource")
  })

  it("initializes (identity in instructions) and lists the five consolidated tools", async () => {
    const { app, token } = appWithGrant("init", "openid derive:read derive:publish")
    const init = await rpc(app, token, initBody)
    const result = init.parsed?.result as { serverInfo?: { name: string }; instructions?: string }
    expect(result.serverInfo).toMatchObject({ name: "derive" })
    // Identity rides in the server instructions, not a whoami tool.
    expect(result.instructions).toContain("Claude")
    expect(result.instructions).toContain("editor")

    const list = await rpc(app, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const names = toolNames(list)
    expect(names.sort()).toEqual(["catch_up", "comment", "list_artifacts", "publish", "read"])
    // Consolidated away — folded into catch_up / comment / publish.
    for (const gone of [
      "whoami",
      "catch_me_up",
      "diff",
      "list_comments",
      "list_versions",
      "propose",
      "read_artifact",
      "read_section",
    ])
      expect(names).not.toContain(gone)
  })

  it("list_artifacts + read see the agent's own published artifact", async () => {
    const { app, token } = appWithGrant("read", "openid derive:read derive:publish")
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

  it("catch_up reports what changed, with the line diff folded in", async () => {
    const { app, token } = appWithGrant("catchup", "openid derive:read derive:publish")
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

    // Default summary: delta + history, line diff omitted (token-light).
    const c = JSON.parse(
      toolText(await call(app, token, "catch_up", { short_id: shortId, since_version: 1 })),
    )
    expect(c.head).toBe(2)
    expect(c.to).toBe(2)
    expect(c.new_versions.map((v: { n: number }) => v.n)).toContain(2)
    expect(c.versions.map((v: { n: number }) => v.n)).toEqual([2, 1]) // full history, newest-first
    expect(c.summary).toContain("v2")
    expect(c.caught_up).toBe(false)
    expect(c.entry_diff).not.toContain("V2 Title")

    // 'detailed' folds in the exact line diff — this is what `diff` used to do.
    const cd = JSON.parse(
      toolText(
        await call(app, token, "catch_up", {
          short_id: shortId,
          since_version: 1,
          to_version: 2,
          response_format: "detailed",
        }),
      ),
    )
    expect(cd.entry_diff).toContain("V2 Title")
  })

  it("read + catch_up handle multi-page bundles", async () => {
    const { app, token } = appWithGrant("bundle", "openid derive:read derive:publish")
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
        { title: "Site", visibility: "public" },
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

    // Republish with a new page; catch_up reports it under pages_changed.added.
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
      toolText(await call(app, token, "catch_up", { short_id: shortId, since_version: 1 })),
    )
    expect(cu.pages_changed.added).toContain("new.html")
  })

  it("comment leaves anchored feedback, replies, and resolves — all via one tool", async () => {
    const { app, token } = appWithGrant(
      "comment",
      "openid derive:read derive:comment derive:publish",
    )
    const shortId = (await (await publish(app, token, "Tighten Me")).json()).short_id

    // Leave a new anchored comment.
    const made = JSON.parse(
      toolText(
        await call(app, token, "comment", {
          short_id: shortId,
          body: "this header is weak",
          quote: "Tighten Me",
        }),
      ),
    )
    expect(made.thread).toBeTruthy()
    expect(made.comment_id).toBeTruthy()
    expect(made.anchored_to).toBe("Tighten Me")
    const thread = made.thread

    // It shows up as open feedback in catch_up's queue.
    const open = JSON.parse(
      toolText(await call(app, token, "catch_up", { short_id: shortId, comments: "open" })),
    )
    expect(open.count).toBe(1)
    expect(open.comments[0].body).toContain("weak")
    expect(open.comments[0].quote).toBe("Tighten Me")

    // Reply in the same thread.
    const reply = JSON.parse(
      toolText(
        await call(app, token, "comment", { short_id: shortId, body: "agreed", reply_to: thread }),
      ),
    )
    expect(reply.thread).toBe(thread)
    expect(reply.note).toContain("Replied")

    // Resolve the thread (body optional when only changing state).
    const resolved = JSON.parse(
      toolText(
        await call(app, token, "comment", {
          short_id: shortId,
          reply_to: thread,
          set_state: "resolved",
        }),
      ),
    )
    expect(resolved.state).toBe("resolved")
    const stillOpen = JSON.parse(
      toolText(await call(app, token, "catch_up", { short_id: shortId, comments: "open" })),
    )
    expect(stillOpen.count).toBe(0)
    // Both rows in the thread (the comment + its reply) move to resolved.
    const done = JSON.parse(
      toolText(await call(app, token, "catch_up", { short_id: shortId, comments: "resolved" })),
    )
    expect(done.count).toBe(2)
  })

  it("publish with for_review stages a proposal instead of going live", async () => {
    // Even with an editor grant, for_review:true files a proposal that never auto-goes-live.
    const { app, token } = appWithGrant("review", "openid derive:read derive:publish")
    const shortId = (await (await publish(app, token, "Draft")).json()).short_id

    const p = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          short_id: shortId,
          content: "<h1>Revised draft</h1>",
          message: "tightened the intro",
          for_review: true,
        }),
      ),
    )
    expect(p.published).toBe(false)
    expect(p.proposed).toBe(true)
    expect(p.proposal_id).toBeTruthy()
    expect(p.base_version).toBe(1)

    // Delegation provenance: the agent proposed on behalf of the human who authorized the
    // grant (Owner / u_o), so the review surface can show "Claude on behalf of Owner."
    const list = await (
      await app.request(`/v1/artifacts/${shortId}/proposals`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()
    expect(list.proposals[0].on_behalf_of).toMatchObject({ name: "Owner" })

    // The live version is untouched — a proposal is not a publish.
    const read = JSON.parse(toolText(await call(app, token, "read", { short_id: shortId })))
    expect(read.version).toBe(1)
    expect(read.content).toContain("Draft")
    expect(read.content).not.toContain("Revised")
  })

  it("surfaces outdated feedback after a republish drops the quoted text", async () => {
    const { app, token } = appWithGrant("stale", "openid derive:read derive:comment derive:publish")
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

    // catch_up's `comments` filter is the feedback queue — outdated threads + their quote.
    const onlyStale = JSON.parse(
      toolText(await call(app, token, "catch_up", { short_id: shortId, comments: "outdated" })),
    )
    expect(onlyStale.count).toBe(1)
    expect(onlyStale.comments[0].state).toBe("outdated")
    expect(onlyStale.comments[0].quote).toBe("beta")

    // The default delta leads with it so the agent knows its edits touched commented text.
    const cu = JSON.parse(
      toolText(await call(app, token, "catch_up", { short_id: shortId, since_version: 1 })),
    )
    expect(cu.summary).toContain("outdated")
    expect(cu.outdated_comments).toHaveLength(1)
    expect(cu.outdated_comments[0].quote).toBe("beta")
  })

  it("publish for_review with `addresses` marks the cited threads addressed (pending review)", async () => {
    const { app, token } = appWithGrant("addr", "openid derive:read derive:comment derive:publish")
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
        await call(app, token, "publish", {
          short_id: shortId,
          content: "<h1>fixed headline</h1>",
          message: "fixed it",
          for_review: true,
          addresses: [cm.thread_id],
        }),
      ),
    )
    expect(p.proposed).toBe(true)
    expect(p.addressed).toEqual([cm.thread_id])

    // The thread is now addressed — off the open list, listed under `addressed`.
    const open = JSON.parse(
      toolText(await call(app, token, "catch_up", { short_id: shortId, comments: "open" })),
    )
    expect(open.count).toBe(0)
    const addr = JSON.parse(
      toolText(await call(app, token, "catch_up", { short_id: shortId, comments: "addressed" })),
    )
    expect(addr.count).toBe(1)
    expect(addr.comments[0].state).toBe("addressed")

    // catch_up flags it so the agent won't re-address the same fix.
    const cu = JSON.parse(toolText(await call(app, token, "catch_up", { short_id: shortId })))
    expect(cu.summary).toContain("addressed")
  })

  it("a live publish with `addresses` resolves those threads directly", async () => {
    const { app, token } = appWithGrant(
      "liveaddr",
      "openid derive:read derive:comment derive:publish",
    )
    const shortId = (await (await publish(app, token, "fix the headline here")).json()).short_id
    const cm = await (
      await app.request(`/v1/artifacts/${shortId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ body_md: "fix it" }),
      })
    ).json()

    const p = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          short_id: shortId,
          content: "<h1>headline fixed</h1>",
          message: "done",
          addresses: [cm.thread_id],
        }),
      ),
    )
    expect(p.published).toBe(true)
    expect(p.resolved).toEqual([cm.thread_id])
    const done = JSON.parse(
      toolText(await call(app, token, "catch_up", { short_id: shortId, comments: "resolved" })),
    )
    expect(done.count).toBe(1)
  })

  // Regression guard for the "Needs Auth" outage: a remote MCP client (Claude
  // Code / claude.ai), because it sends an RFC 8707 `resource` indicator, gets a
  // SIGNED JWT access token rather than the opaque token. The server must verify
  // it against the JWKS read from Better Auth's store on this instance — NOT by
  // HTTP-fetching its own /api/auth/jwks, which a Cloudflare Worker can't do.
  it("authenticates an OAuth JWT access token via the local JWKS", async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true })
    const kid = "test-jwt-kid"
    const jwk = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" }

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
      baseUrl: "http://derive.test",
      token: "tok",
      auth: {
        handler: async () => new Response(null, { status: 404 }),
        api: { getJwks: async () => ({ keys: [jwk] }) },
      } as unknown as Parameters<typeof createApp>[0]["auth"],
    })

    // A realistic MCP token carries an `aud` = the resource the client bound it to (RFC
    // 8707). The provider only mints JWTs when a resource is sent, so a real one always has
    // this claim; the RS validates it.
    const mint = (over: Record<string, unknown> = {}) =>
      new SignJWT({ scope: "openid derive:read derive:publish", azp: "cli", ...over })
        .setProtectedHeader({ alg: "EdDSA", kid })
        .setSubject("u_jwt")
        .setIssuer("http://derive.test/api/auth")
        .setAudience("http://derive.test/mcp")
        .setExpirationTime("1h")
        .sign(privateKey)

    const ok = await rpc(app, await mint(), initBody)
    expect(ok.status).toBe(200)
    expect((ok.parsed?.result as { instructions?: string }).instructions).toContain("editor")

    const good = await mint()
    const tampered = `${good.slice(0, -6)}AAAAAA`
    const bad = await rpc(app, tampered, initBody)
    expect(bad.status).toBe(401)

    const wrongIss = await new SignJWT({ scope: "openid derive:read", azp: "cli" })
      .setProtectedHeader({ alg: "EdDSA", kid })
      .setSubject("u_jwt")
      .setIssuer("http://evil.test/api/auth")
      .setAudience("http://derive.test/mcp")
      .setExpirationTime("1h")
      .sign(privateKey)
    expect((await rpc(app, wrongIss, initBody)).status).toBe(401)

    // MCP-spec MUST: a token this AS signed but minted for a DIFFERENT resource (audience)
    // is rejected — the server only accepts tokens issued for it (RFC 8707 audience binding).
    const wrongAud = await new SignJWT({ scope: "openid derive:read", azp: "cli" })
      .setProtectedHeader({ alg: "EdDSA", kid })
      .setSubject("u_jwt")
      .setIssuer("http://derive.test/api/auth")
      .setAudience("https://someone-elses-server.example/mcp")
      .setExpirationTime("1h")
      .sign(privateKey)
    expect((await rpc(app, wrongAud, initBody)).status).toBe(401)
  })

  it("publish creates a NEW artifact (first publish) and then a new version of it", async () => {
    const { app, token } = appWithGrant("pub", "openid derive:read derive:publish")

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
    expect(created.listed).toBe("none") // the team-draft default: out of every feed until promoted

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

  it("publish needs a title to create, and routes a non-publisher to review", async () => {
    // A new-artifact publish with no title is refused.
    const { app, token } = appWithGrant("pub2", "openid derive:read derive:publish")
    const noTitle = await call(app, token, "publish", { content: "<h1>x</h1>" })
    expect(toolText(noTitle)).toContain("title")

    // A comment-only grant can't publish live — and can't create a NEW artifact even
    // via review (a proposal revises an existing one). Steered to publish rights.
    const weak = appWithGrant("pub3", "openid derive:read derive:comment")
    const denied = await call(weak.app, weak.token, "publish", {
      title: "Nope",
      content: "<h1>x</h1>",
    })
    expect(toolText(denied)).toContain("publish rights")
  })

  it("publish creates and republishes a multi-page bundle via the files map", async () => {
    const { app, token } = appWithGrant("pubbundle", "openid derive:read derive:publish")

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

    const outline = JSON.parse(toolText(await call(app, token, "read", { short_id: shortId })))
    expect(outline.pages).toEqual(expect.arrayContaining(["index.html", "about.html", "nav.js"]))
    const about = JSON.parse(
      toolText(await call(app, token, "read", { short_id: shortId, section: "about.html" })),
    )
    expect(about.content).toContain("About")

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
      toolText(await call(app, token, "catch_up", { short_id: shortId, since_version: 1 })),
    )
    expect(cu.pages_changed.added).toContain("new.html")
  })

  it("a bundle can't be filed for review (single-file proposals only)", async () => {
    const { app, token } = appWithGrant("bundlereview", "openid derive:read derive:publish")
    const created = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "Site",
          files: { "index.html": "<h1>home</h1>" },
        }),
      ),
    )
    const r = await call(app, token, "publish", {
      short_id: created.short_id,
      files: { "index.html": "<h1>home v2</h1>" },
      for_review: true,
    })
    expect(toolText(r)).toContain("bundles can't be proposed")
  })

  it("publish steers between content and files by kind", async () => {
    const { app, token } = appWithGrant("pubkind", "openid derive:read derive:publish")

    const both = await call(app, token, "publish", {
      title: "x",
      content: "<h1>x</h1>",
      files: { "index.html": "<h1>x</h1>" },
    })
    expect(toolText(both)).toContain("not both")

    const file = JSON.parse(
      toolText(await call(app, token, "publish", { title: "Doc", content: "<h1>doc</h1>" })),
    )
    const asBundle = await call(app, token, "publish", {
      short_id: file.short_id,
      files: { "index.html": "<h1>doc</h1>" },
    })
    expect(toolText(asBundle)).toContain("single-file")

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
