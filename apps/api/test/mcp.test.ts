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

function appWithGrant(
  name: string,
  scopes: string,
  extra: Partial<Parameters<typeof createApp>[0]> = {},
) {
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
    ...extra,
  })
  return { app, token: `tok_${name}`, meta }
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

  it("initializes (identity in instructions) and lists the consolidated tools", async () => {
    const { app, token } = appWithGrant("init", "openid derive:read derive:publish")
    const init = await rpc(app, token, initBody)
    const result = init.parsed?.result as { serverInfo?: { name: string }; instructions?: string }
    expect(result.serverInfo).toMatchObject({ name: "derive" })
    // Identity rides in the server instructions, not a whoami tool.
    expect(result.instructions).toContain("Claude")
    expect(result.instructions).toContain("editor")
    // The instructions teach the switcher: one login reaches every workspace.
    expect(result.instructions).toContain("list_workspaces")

    const list = await rpc(app, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const names = toolNames(list)
    expect(names.sort()).toEqual([
      "catch_up",
      "comment",
      "list_artifacts",
      "list_workspaces",
      "publish",
      "read",
    ])
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

  it("exposes the workspace's Brandprint as resources + an instructions pointer", async () => {
    const { app, token, meta } = appWithGrant("brandprint", "openid derive:read derive:publish")
    const shortId = (await (await publish(app, token, "How we write Markdown")).json()).short_id
    const art = await meta.getByShortId(shortId)
    if (!art) throw new Error("no artifact")
    // Seed a Brandprint collection containing the convention doc, point the workspace at it.
    const collectionId = "col_bp"
    await meta.createCollection({
      id: collectionId,
      org_id: art.org_id,
      title: "Brandprint",
      created_by: "u_o",
    })
    await meta.addCollectionItem(collectionId, art.id)
    await meta.setOrgSettings(art.org_id, {
      ...(await meta.getOrgSettings(art.org_id)),
      brandprint: { collectionId },
    })

    // Instructions carry the pointer (progressive disclosure — not the full text).
    const init = await rpc(app, token, initBody)
    const result = init.parsed?.result as { instructions?: string }
    expect(result.instructions).toContain("This workspace has a Brandprint:")
    expect(result.instructions).toContain("1 convention doc")
    expect(result.instructions).toContain("derive://brandprint/*")

    // The convention doc is a readable resource, fetched lazily.
    const listed = await rpc(app, token, { jsonrpc: "2.0", id: 3, method: "resources/list" })
    const uris = (
      (listed.parsed?.result as { resources?: { uri: string }[] } | undefined)?.resources ?? []
    ).map((r) => r.uri)
    expect(uris).toContain(`derive://brandprint/${shortId}`)

    const read = await rpc(app, token, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri: `derive://brandprint/${shortId}` },
    })
    const text = (read.parsed?.result as { contents?: { text: string }[] } | undefined)
      ?.contents?.[0]?.text
    expect(text).toContain("How we write Markdown")
  })

  it("serves the build reference and a pending note while the profile is a stub", async () => {
    const { app, token, meta } = appWithGrant(
      "brandprint-pending",
      "openid derive:read derive:publish",
    )
    const srcId = (await (await publish(app, token, "Voice and tone")).json()).short_id
    const profId = (await (await publish(app, token, "Brand profile")).json()).short_id
    const src = await meta.getByShortId(srcId)
    const prof = await meta.getByShortId(profId)
    if (!src || !prof) throw new Error("no artifacts")
    const collectionId = "col_bp_pending"
    await meta.createCollection({
      id: collectionId,
      org_id: src.org_id,
      title: "Brandprint",
      created_by: "u_o",
    })
    await meta.addCollectionItem(collectionId, src.id)
    await meta.addCollectionItem(collectionId, prof.id)
    await meta.setOrgSettings(src.org_id, {
      ...(await meta.getOrgSettings(src.org_id)),
      brandprint: { collectionId, profileId: profId },
    })

    // Factual, user-conditioned pending note — never a solicitation.
    const init = await rpc(app, token, initBody)
    const inst = (init.parsed?.result as { instructions?: string }).instructions ?? ""
    expect(inst).toContain("has not been generated yet")
    expect(inst).toContain("If the user asks")
    expect(inst).toContain(profId)

    // Reference + template are served; the stub is neither a source nor the profile.
    const listed = await rpc(app, token, { jsonrpc: "2.0", id: 3, method: "resources/list" })
    const uris = (
      (listed.parsed?.result as { resources?: { uri: string }[] } | undefined)?.resources ?? []
    ).map((r) => r.uri)
    expect(uris).toContain("derive://brandprint/reference")
    expect(uris).toContain("derive://brandprint/template")
    expect(uris).toContain(`derive://brandprint/${srcId}`)
    expect(uris).not.toContain("derive://brandprint/profile")
    expect(uris).not.toContain(`derive://brandprint/${profId}`)

    const ref = await rpc(app, token, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri: "derive://brandprint/reference" },
    })
    const refText =
      (ref.parsed?.result as { contents?: { text: string }[] } | undefined)?.contents?.[0]?.text ??
      ""
    expect(refText).toContain("for_review")
    expect(refText).toContain("brandprint-tokens")
  })

  it("serves the live profile as the headline resource once it has a real version", async () => {
    const { app, token, meta } = appWithGrant(
      "brandprint-live",
      "openid derive:read derive:publish",
    )
    const profId = (await (await publish(app, token, "Brand profile")).json()).short_id
    const prof = await meta.getByShortId(profId)
    if (!prof) throw new Error("no artifact")
    const collectionId = "col_bp_live"
    await meta.createCollection({
      id: collectionId,
      org_id: prof.org_id,
      title: "Brandprint",
      created_by: "u_o",
    })
    await meta.addCollectionItem(collectionId, prof.id)
    await meta.setOrgSettings(prof.org_id, {
      ...(await meta.getOrgSettings(prof.org_id)),
      brandprint: { collectionId, profileId: profId },
    })

    // The agent's generated profile lands as version 2 — the stub is v1, so v2 flips live.
    const form = new FormData()
    form.append(
      "file",
      new Blob([new TextEncoder().encode("<h1>Acme brand profile</h1>")]),
      "index.html",
    )
    const rep = await app.request(`/v1/artifacts/${profId}/versions`, {
      method: "POST",
      body: form,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(rep.status).toBe(201)

    const init = await rpc(app, token, initBody)
    const inst = (init.parsed?.result as { instructions?: string }).instructions ?? ""
    expect(inst).toContain("Brandprint profile")
    expect(inst).toContain("derive://brandprint/profile")
    expect(inst).not.toContain("has not been generated yet")

    const listed = await rpc(app, token, { jsonrpc: "2.0", id: 3, method: "resources/list" })
    const uris = (
      (listed.parsed?.result as { resources?: { uri: string }[] } | undefined)?.resources ?? []
    ).map((r) => r.uri)
    expect(uris).toContain("derive://brandprint/profile")

    const read = await rpc(app, token, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri: "derive://brandprint/profile" },
    })
    const text = (read.parsed?.result as { contents?: { text: string }[] } | undefined)
      ?.contents?.[0]?.text
    expect(text).toContain("Acme brand profile")
  })

  it("list_artifacts + read see the agent's own published artifact", async () => {
    const { app, token } = appWithGrant("read", "openid derive:read derive:publish")
    const pub = await publish(app, token, "My Plan")
    expect(pub.status).toBe(201)
    const shortId = (await pub.json()).short_id

    const list = await call(app, token, "list_artifacts")
    const listOut = JSON.parse(toolText(list))
    expect(listOut.artifacts.some((a: { short_id: string }) => a.short_id === shortId)).toBe(true)

    // Content reads are a frontmatter header + the markdown body — NOT a JSON envelope.
    const read = toolText(await call(app, token, "read", { short_id: shortId }))
    expect(read).toContain("title: My Plan")
    expect(read).toContain("# My Plan")
    expect(read).not.toContain("\\n")
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

  it("catch_up detailed diffs the markdown conversion, not raw HTML tag noise", async () => {
    const { app, token } = appWithGrant("catchupmd", "openid derive:read derive:publish")
    const v1 =
      "<html><head><style>body{color:red}</style></head><body>" +
      "<h1>Doc</h1><p>alpha bravo charlie</p></body></html>"
    const v2 =
      "<html><head><style>body{color:blue}</style></head><body>" +
      "<h1>Doc</h1><p>alpha BRAVO charlie</p></body></html>"
    const form1 = new FormData()
    form1.append("file", new Blob([new TextEncoder().encode(v1)]), "index.html")
    form1.append("title", "Semantic")
    const shortId = (
      await (
        await app.request("/v1/artifacts", {
          method: "POST",
          body: form1,
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()
    ).short_id
    const form2 = new FormData()
    form2.append("file", new Blob([new TextEncoder().encode(v2)]), "index.html")
    await app.request(`/v1/artifacts/${shortId}/versions`, {
      method: "POST",
      body: form2,
      headers: { authorization: `Bearer ${token}` },
    })
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
    expect(cd.entry_diff).toContain("diff of markdown conversion")
    expect(cd.entry_diff).toContain("BRAVO")
    expect(cd.entry_diff).not.toContain("<p")
    expect(cd.entry_diff).not.toContain("color:")
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

    // No section → outline (the bundle's pages, with per-page headings for text pages).
    const pages = JSON.parse(toolText(await call(app, token, "read", { short_id: shortId })))
    expect(pages.pages.map((p: { path: string }) => p.path)).toEqual(
      expect.arrayContaining(["index.html", "page.html"]),
    )
    // A section → that page's content (frontmatter envelope, converted to markdown).
    const page = toolText(
      await call(app, token, "read", { short_id: shortId, section: "page.html" }),
    )
    expect(page).toContain("section: page.html")
    expect(page).toContain("Page")

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

  it("read: formats, heading sections, and the outline-first threshold", async () => {
    const { app, token } = appWithGrant("readfmt", "openid derive:read derive:publish")
    const html =
      "<!DOCTYPE html><html><head><style>body{color:red}</style></head><body>" +
      "<h1>Doc</h1><p>intro &amp; more</p>" +
      "<h2>Alpha</h2><p>alpha body</p><h2>Beta</h2><p>beta body</p></body></html>"
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode(html)]), "index.html")
    form.append("title", "Fmt Doc")
    const shortId = (
      await (
        await app.request("/v1/artifacts", {
          method: "POST",
          body: form,
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()
    ).short_id

    // Default read: markdown conversion, style noise gone, entities decoded.
    const md = toolText(await call(app, token, "read", { short_id: shortId }))
    expect(md).toContain("format: markdown (converted from text/html)")
    expect(md).toContain("# Doc")
    expect(md).toContain("intro & more")
    expect(md).not.toContain("color:red")

    // format:"html" is the exact stored source.
    const raw = toolText(await call(app, token, "read", { short_id: shortId, format: "html" }))
    expect(raw).toContain(html)

    // format:"text" is the flat visible text (what comment quotes anchor against).
    const flat = toolText(await call(app, token, "read", { short_id: shortId, format: "text" }))
    expect(flat).toContain("alpha body")
    expect(flat).not.toContain("# Doc")

    // A heading slug reads just that section; an unknown slug names the real ones.
    const alpha = toolText(await call(app, token, "read", { short_id: shortId, section: "alpha" }))
    expect(alpha).toContain("## Alpha")
    expect(alpha).toContain("alpha body")
    expect(alpha).not.toContain("beta body")
    const bad = toolText(await call(app, token, "read", { short_id: shortId, section: "nope" }))
    expect(bad).toContain("doc, alpha, beta")

    // page#slug works within a bundle page.
    const bundleHtml = "<h1>Home</h1><h2>Part One</h2><p>one</p><h2>Part Two</h2><p>two</p>"
    const bcreated = JSON.parse(
      toolText(
        await call(app, token, "publish", { title: "B", files: { "index.html": bundleHtml } }),
      ),
    )
    const part = toolText(
      await call(app, token, "read", {
        short_id: bcreated.short_id,
        section: "index.html#part-one",
      }),
    )
    expect(part).toContain("## Part One")
    expect(part).not.toContain("two")

    // A big sectioned doc goes outline-first; section:"*" forces the clipped body.
    const bigBody = Array.from(
      { length: 40 },
      (_, i) => `<h2>Sect ${i}</h2><p>${"lorem ipsum ".repeat(120)}</p>`,
    ).join("")
    const bigForm = new FormData()
    bigForm.append(
      "file",
      new Blob([new TextEncoder().encode(`<html><body><h1>Big</h1>${bigBody}</body></html>`)]),
      "index.html",
    )
    bigForm.append("title", "Big Doc")
    const bigId = (
      await (
        await app.request("/v1/artifacts", {
          method: "POST",
          body: bigForm,
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()
    ).short_id
    const outline = JSON.parse(toolText(await call(app, token, "read", { short_id: bigId })))
    expect(outline.sections.length).toBe(41)
    expect(outline.sections[1]).toMatchObject({ slug: "sect-0", level: 2 })
    expect(outline.doc_chars).toBeGreaterThan(30_000)
    const starred = toolText(await call(app, token, "read", { short_id: bigId, section: "*" }))
    expect(starred).toContain("# Big")
    const one = toolText(await call(app, token, "read", { short_id: bigId, section: "sect-7" }))
    expect(one).toContain("## Sect 7")
    expect(one).toContain("section: sect-7 (9 of 41)")
  })

  it("read: a single section that's itself huge is clipped, not returned unbounded (regression)", async () => {
    const { app, token } = appWithGrant("readhugesection", "openid derive:read derive:publish")
    // One heading whose own content exceeds the 80k MAX_CHARS ceiling on its own —
    // sectionOf runs it to </body>, so a naive return would ship it all unbounded.
    const hugeSection = `<h1>Top</h1><h2>Huge</h2><p>${"lorem ipsum dolor sit amet ".repeat(4000)}</p>`
    const form = new FormData()
    form.append(
      "file",
      new Blob([new TextEncoder().encode(`<html><body>${hugeSection}</body></html>`)]),
      "index.html",
    )
    form.append("title", "Huge Section Doc")
    const shortId = (
      await (
        await app.request("/v1/artifacts", {
          method: "POST",
          body: form,
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()
    ).short_id
    const section = toolText(await call(app, token, "read", { short_id: shortId, section: "huge" }))
    expect(section).toContain("…[truncated")
  })

  it("read: format:text on a deck artifact returns flat visible text, not raw markup (regression)", async () => {
    const { app, token } = appWithGrant("readdeck", "openid derive:read derive:publish")
    // Must NOT start with <html>/<!doctype html> (that sniffs as plain text/html) —
    // real deck content declares the protocol name, which is enough to type-sniff it.
    const deck = "derive-deck\n<h1>Slide</h1><p>hello there</p>"
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode(deck)]), "deck.html")
    form.append("title", "Deck")
    const shortId = (
      await (
        await app.request("/v1/artifacts", {
          method: "POST",
          body: form,
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()
    ).short_id
    const md = toolText(await call(app, token, "read", { short_id: shortId, section: "*" }))
    expect(md).toContain("format: markdown (converted from text/x-derive-deck)")
    expect(md).toContain("# Slide")
    const flat = toolText(
      await call(app, token, "read", { short_id: shortId, format: "text", section: "*" }),
    )
    expect(flat).not.toContain("<h1>")
    expect(flat).toContain("hello there")
  })

  it("read: a bundle page over the outline threshold goes outline-first too, with a #* bypass", async () => {
    const { app, token } = appWithGrant("readbundlebig", "openid derive:read derive:publish")
    const bigPage = Array.from(
      { length: 40 },
      (_, i) => `<h2>Screen ${i}</h2><p>${"lorem ipsum ".repeat(120)}</p>`,
    ).join("")
    const created = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "Big Bundle",
          files: { "index.html": "<h1>Home</h1>", "big.html": `<h1>Big</h1>${bigPage}` },
        }),
      ),
    )
    const outline = JSON.parse(
      toolText(await call(app, token, "read", { short_id: created.short_id, section: "big.html" })),
    )
    expect(Array.isArray(outline.sections)).toBe(true)
    expect(outline.sections.length).toBeGreaterThan(30)
    const forced = toolText(
      await call(app, token, "read", { short_id: created.short_id, section: "big.html#*" }),
    )
    expect(forced).toContain("# Big")
  })

  it("read: an image page returns a real MCP image block, not bytes-as-text", async () => {
    const { app, token } = appWithGrant("readimg", "openid derive:read derive:publish")
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    const created = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "Mockups",
          files: {
            "index.html": '<h1>Screens</h1><img src="shot.png">',
            "shot.png": `data:image/png;base64,${png}`,
          },
        }),
      ),
    )
    const r = await call(app, token, "read", { short_id: created.short_id, section: "shot.png" })
    const content = (
      r.parsed?.result as {
        content: { type: string; text?: string; data?: string; mimeType?: string }[]
      }
    ).content
    expect(content[0]?.type).toBe("text")
    expect(content[0]?.text).toContain("shot.png")
    expect(content[0]?.text).toContain(`/raw/${created.short_id}/v/1/shot.png`)
    expect(content[1]?.type).toBe("image")
    expect(content[1]?.mimeType).toBe("image/png")
    expect(content[1]?.data).toBe(png)
  })

  it("read: a markdown artifact returns its source untouched under the default format", async () => {
    const { app, token } = appWithGrant("readmd", "openid derive:read derive:publish")
    const md = "# Notes\n\nSome *markdown* here.\n\n## Sub\n\ntail\n"
    const created = JSON.parse(
      toolText(
        await call(app, token, "publish", { title: "Notes", content: md, filename: "notes.md" }),
      ),
    )
    const read = toolText(await call(app, token, "read", { short_id: created.short_id }))
    expect(read).toContain("format: markdown (source)")
    expect(read).toContain("Some *markdown* here.")
    const sub = toolText(
      await call(app, token, "read", { short_id: created.short_id, section: "sub" }),
    )
    expect(sub).toContain("## Sub")
    expect(sub).not.toContain("*markdown*")
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
    const read = toolText(await call(app, token, "read", { short_id: shortId }))
    expect(read).toContain("version: 1 (current)")
    expect(read).toContain("Draft")
    expect(read).not.toContain("Revised")
  })

  // The sniffer types by filename first, so a bare index.html fallback silently
  // re-types a markdown artifact as HTML on any revision that omits `filename` —
  // the browser then parses the raw markdown as markup and swallows tag-like text.
  // These three pin every no-filename path: full-content republish, new-artifact
  // sniff, and the proposal route.
  it("publish: a full-content republish without a filename keeps a markdown doc markdown", async () => {
    const { app, token } = appWithGrant("retype", "openid derive:read derive:publish")
    const created = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "Doc",
          content: "# Doc\n\nfirst body\n",
          filename: "doc.md",
        }),
      ),
    )
    await call(app, token, "publish", {
      short_id: created.short_id,
      content: "# Doc\n\nrevised body\n",
    })
    const read = toolText(await call(app, token, "read", { short_id: created.short_id }))
    expect(read).toContain("version: 2 (current)")
    expect(read).toContain("format: markdown (source)")
    expect(read).toContain("revised body")
  })

  it("publish: a new single-file artifact without a filename is sniffed, not defaulted to HTML", async () => {
    const { app, token } = appWithGrant("sniff", "openid derive:read derive:publish")
    const md = JSON.parse(
      toolText(
        await call(app, token, "publish", { title: "Plain", content: "# Plain\n\nno filename\n" }),
      ),
    )
    const readMd = toolText(await call(app, token, "read", { short_id: md.short_id }))
    expect(readMd).toContain("format: markdown (source)")
    // A real HTML document still lands as HTML — the sniff is conservative, not a
    // markdown default.
    const html = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "Page",
          content: "<!doctype html><html><body><h1>Page</h1></body></html>",
        }),
      ),
    )
    const readHtml = toolText(await call(app, token, "read", { short_id: html.short_id }))
    expect(readHtml).toContain("markdown (converted from text/html)")
  })

  it("publish: an approved no-filename proposal keeps a markdown doc markdown", async () => {
    const { app, token } = appWithGrant("retypeprop", "openid derive:read derive:publish")
    const created = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "Spec",
          content: "# Spec\n\ndraft\n",
          filename: "spec.md",
        }),
      ),
    )
    const p = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          short_id: created.short_id,
          content: "# Spec\n\nproposed body\n",
          for_review: true,
        }),
      ),
    )
    const approved = await app.request(
      `/v1/artifacts/${created.short_id}/proposals/${p.proposal_id}/approve`,
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
    )
    expect(approved.status).toBe(200)
    const read = toolText(await call(app, token, "read", { short_id: created.short_id }))
    expect(read).toContain("version: 2 (current)")
    expect(read).toContain("format: markdown (source)")
    expect(read).toContain("proposed body")
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
    const read = toolText(await call(app, token, "read", { short_id: created.short_id }))
    expect(read).toContain("hello world")

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

  it("publish edits: exact-match search/replace instead of resending content", async () => {
    const { app, token } = appWithGrant("pubedits", "openid derive:read derive:publish")
    const created = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "Edit Me",
          content: "<h1>Title</h1><p>alpha beta gamma</p>",
        }),
      ),
    )
    const shortId = created.short_id

    // Happy path: applies in order, second edit sees the first edit's result.
    const edited = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          short_id: shortId,
          edits: [
            { old_str: "beta", new_str: "BETA" },
            { old_str: "alpha BETA", new_str: "x y" },
          ],
        }),
      ),
    )
    expect(edited.published).toBe(true)
    expect(edited.version).toBe(2)
    expect(edited.edits_applied).toBe(2)
    const read = toolText(await call(app, token, "read", { short_id: shortId, format: "html" }))
    expect(read).toContain("x y gamma")

    // 0-match and multi-match are both rejected, naming the failing edit; nothing applies.
    const zero = await call(app, token, "publish", {
      short_id: shortId,
      edits: [{ old_str: "nope-nowhere", new_str: "y" }],
    })
    expect(toolText(zero)).toMatch(/Edit 1 of 1 failed.*not found/)
    const multi = await call(app, token, "publish", {
      short_id: shortId,
      edits: [
        { old_str: "y gamma", new_str: "z" },
        { old_str: "Title", new_str: "T" },
        { old_str: "y gamma", new_str: "again" },
      ],
    })
    expect(toolText(multi)).toMatch(/Edit \d of 3 failed/)
    const afterFailed = toolText(
      await call(app, token, "read", { short_id: shortId, format: "html" }),
    )
    expect(afterFailed).toContain("x y gamma") // unchanged — a failed batch applies nothing

    // base_version conflict: the artifact is at v2, but the agent read v1.
    const stale = await call(app, token, "publish", {
      short_id: shortId,
      base_version: 1,
      edits: [{ old_str: "Title", new_str: "T2" }],
    })
    expect(toolText(stale)).toMatch(/moved to v2/)

    // edits + content is rejected; edits with no short_id is rejected.
    expect(
      toolText(
        await call(app, token, "publish", {
          short_id: shortId,
          edits: [{ old_str: "x", new_str: "y" }],
          content: "<h1>nope</h1>",
        }),
      ),
    ).toContain("not both")
    expect(
      toolText(await call(app, token, "publish", { edits: [{ old_str: "x", new_str: "y" }] })),
    ).toContain("EXISTING artifact")

    // edits on a bundle is rejected.
    const bundle = JSON.parse(
      toolText(
        await call(app, token, "publish", { title: "B", files: { "index.html": "<h1>b</h1>" } }),
      ),
    )
    expect(
      toolText(
        await call(app, token, "publish", {
          short_id: bundle.short_id,
          edits: [{ old_str: "b", new_str: "c" }],
        }),
      ),
    ).toContain("multi-page bundle")

    // edits + for_review files a proposal with the materialized text, not live.
    const proposal = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          short_id: shortId,
          for_review: true,
          edits: [{ old_str: "gamma", new_str: "GAMMA" }],
        }),
      ),
    )
    expect(proposal.published).toBe(false)
    expect(proposal.proposed).toBe(true)
    expect(proposal.edits_applied).toBe(1)
    const stillLive = toolText(
      await call(app, token, "read", { short_id: shortId, format: "html" }),
    )
    expect(stillLive).not.toContain("GAMMA") // the proposal never touched the live version
  })

  it("publish edits: over the workspace storage quota is rejected, same as content/files (regression: the MCP edits path used to skip this check)", async () => {
    const { app, token } = appWithGrant("editsquota", "openid derive:read derive:publish", {
      maxBytes: 200,
    })
    const created = JSON.parse(
      toolText(
        await call(app, token, "publish", { title: "Small", content: "<h1>x</h1><p>y</p>" }),
      ),
    )
    const rejected = await call(app, token, "publish", {
      short_id: created.short_id,
      edits: [{ old_str: "y", new_str: "y".repeat(500) }],
    })
    expect(toolText(rejected)).toMatch(/storage quota/i)
    const stillOriginal = toolText(
      await call(app, token, "read", { short_id: created.short_id, format: "html" }),
    )
    expect(stillOriginal).not.toContain("y".repeat(500))
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
    expect(outline.pages.map((p: { path: string }) => p.path)).toEqual(
      expect.arrayContaining(["index.html", "about.html", "nav.js"]),
    )
    const about = toolText(
      await call(app, token, "read", { short_id: shortId, section: "about.html" }),
    )
    expect(about).toContain("About")

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

  it("publish enqueues a preview render job (parity with the HTTP route)", async () => {
    const { app, token, meta } = appWithGrant("pubrender", "openid derive:read derive:publish", {
      renderPreviews: true,
    })
    const created = JSON.parse(
      toolText(await call(app, token, "publish", { title: "Card", content: "<h1>v1</h1>" })),
    )
    expect(created.published).toBe(true)
    // notifyRender is fire-and-forget — give the enqueue promise a tick to settle.
    await new Promise((r) => setTimeout(r, 20))
    const lease = new Date(Date.now() + 60_000).toISOString()
    const due = await meta.claimDueRenderJobs(new Date().toISOString(), 10, lease)
    expect(due).toHaveLength(1)
    expect(due[0]?.version_n).toBe(1)

    // A republish enqueues for the NEW version.
    await call(app, token, "publish", { short_id: created.short_id, content: "<h1>v2</h1>" })
    await new Promise((r) => setTimeout(r, 20))
    const due2 = await meta.claimDueRenderJobs(new Date().toISOString(), 10, lease)
    expect(due2).toHaveLength(1)
    expect(due2[0]?.version_n).toBe(2)
  })

  it("publish with for_review (a proposal) does NOT enqueue a render job", async () => {
    const { app, token, meta } = appWithGrant("proprender", "openid derive:read derive:publish", {
      renderPreviews: true,
    })
    const created = JSON.parse(
      toolText(await call(app, token, "publish", { title: "Base", content: "<h1>v1</h1>" })),
    )
    await new Promise((r) => setTimeout(r, 20))
    // Drain the publish's own job so the assertion below isolates the proposal.
    const lease = new Date(Date.now() + 60_000).toISOString()
    await meta.claimDueRenderJobs(new Date().toISOString(), 10, lease)

    const proposed = await call(app, token, "publish", {
      short_id: created.short_id,
      content: "<h1>proposed</h1>",
      for_review: true,
    })
    expect(JSON.parse(toolText(proposed)).proposed).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(await meta.claimDueRenderJobs(new Date().toISOString(), 10, lease)).toHaveLength(0)
  })
})
