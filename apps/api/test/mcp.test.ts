import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BlobStore, MetaStore, VersionRecord } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { zipSync } from "fflate"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"
import {
  MAX_INDEX_TEXT,
  reindexSearchBatch,
  searchMatcher,
  searchWorkspace,
  versionIndexText,
} from "../src/lib/search"

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
  const blobs = new FsBlobStore(join(dir, `${name}-blobs`))
  const app = createApp({
    meta,
    blobs,
    baseUrl: "http://derive.test",
    token: "tok",
    ...extra,
  })
  return { app, token: `tok_${name}`, meta, blobs }
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

// Publish arbitrary bytes under a chosen filename (so the sniffer types it), for the
// search/windowed-read tests that need real multi-line source, not an `<h1>` stub.
const publishRaw = (app: App, token: string, content: string, filename: string, title: string) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), filename)
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
      "search",
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

  it("delivers a Brandprint SKILL member with its own name/description, stripped body, and file footer", async () => {
    const { app, token, meta } = appWithGrant("bpskill", "openid derive:read derive:publish")
    // A real skill bundle: SKILL.md entry (no html ⇒ derive/skill) plus an aux script.
    const created = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "ignored — frontmatter name wins",
          files: {
            "SKILL.md":
              "---\nname: chart-style\ndescription: How this workspace builds charts.\n---\n\n# Chart style\n\nUse the house palette and Space Grotesk.\n",
            "scripts/build.sh": "#!/usr/bin/env bash\necho chart\n",
          },
        }),
      ),
    )
    const art = await meta.getByShortId(created.short_id)
    if (!art) throw new Error("no artifact")
    expect(art.current_content_type).toBe("derive/skill")

    const collectionId = "col_bp_skill"
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

    // The resource descriptor carries the skill's OWN identity, not a generic label.
    const listed = await rpc(app, token, { jsonrpc: "2.0", id: 3, method: "resources/list" })
    const resource = (
      (
        listed.parsed?.result as {
          resources?: { uri: string; title?: string; description?: string }[]
        }
      )?.resources ?? []
    ).find((r) => r.uri === `derive://brandprint/${created.short_id}`)
    expect(resource?.title).toBe("chart-style")
    expect(resource?.description).toBe("How this workspace builds charts.")

    // The body is the SKILL.md sans frontmatter, plus a footer pointing at the aux files.
    const read = await rpc(app, token, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri: `derive://brandprint/${created.short_id}` },
    })
    const body = (read.parsed?.result as { contents?: { text: string }[] } | undefined)
      ?.contents?.[0]?.text
    expect(body).toContain("# Chart style")
    expect(body).toContain("Use the house palette")
    expect(body).not.toContain("name: chart-style") // frontmatter stripped
    expect(body).toContain("scripts/build.sh") // aux files announced
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

  it("list_artifacts marks skills and filters to them with skills:true", async () => {
    const { app, token } = appWithGrant("listskills", "openid derive:read derive:publish")
    const doc = (await (await publish(app, token, "A plain doc")).json()).short_id
    const skill = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "A skill",
          files: {
            "SKILL.md": "---\nname: my-skill\ndescription: does a thing.\n---\n\n# My skill\n",
          },
        }),
      ),
    ).short_id

    // Unfiltered: both present; is_skill distinguishes them.
    const all = JSON.parse(toolText(await call(app, token, "list_artifacts")))
    const rowOf = (id: string) =>
      all.artifacts.find((a: { short_id: string }) => a.short_id === id) as
        | { is_skill: boolean }
        | undefined
    expect(rowOf(skill)?.is_skill).toBe(true)
    expect(rowOf(doc)?.is_skill).toBe(false)

    // Filtered: only the skill.
    const onlySkills = JSON.parse(
      toolText(await call(app, token, "list_artifacts", { skills: true })),
    )
    const ids = onlySkills.artifacts.map((a: { short_id: string }) => a.short_id)
    expect(ids).toContain(skill)
    expect(ids).not.toContain(doc)
  })

  it("publish fires the version.published webhook — parity with the HTTP route", async () => {
    // The bug this guards against: an MCP publish that skips the webhook outbox because its
    // side-effect chain drifted from the HTTP route's. Both now share lib/after-publish.ts.
    const { app, token, meta } = appWithGrant("mcpwebhook", "openid derive:read derive:publish")
    await rpc(app, token, initBody)
    // Publish once to discover the agent's workspace, subscribe a webhook there, then
    // republish — the republish is the event we assert reaches the outbox.
    const first = await call(app, token, "publish", { title: "Hook Me", content: "<h1>v1</h1>" })
    const shortId = JSON.parse(toolText(first)).short_id as string
    const art = await meta.getByShortId(shortId)
    if (!art) throw new Error("published artifact not found")
    await meta.createWebhook({
      id: "wh_mcp",
      org_id: art.org_id,
      url: "http://example.com/hook",
      secret: "s",
      kind: "generic",
      events: "version.published",
    })
    await call(app, token, "publish", { short_id: shortId, content: "<h1>v2</h1>", message: "v2" })

    const due = await meta.claimDueDeliveries(
      new Date(Date.now() + 1000).toISOString(),
      10,
      new Date(Date.now() + 60_000).toISOString(),
    )
    const forThis = due.filter((d) => JSON.parse(d.payload).artifact.short_id === shortId)
    expect(forThis.length).toBe(1)
    expect(forThis[0]?.event_type).toBe("version.published")
    expect(forThis[0]?.url).toBe("http://example.com/hook")
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

  it("catch_up wait blocks until a NEW VERSION lands (no review round involved) — live co-editing", async () => {
    const { app, token } = appWithGrant("waitver", "openid derive:read derive:publish")
    const shortId = (await (await publish(app, token, "V1")).json()).short_id

    const t0 = Date.now()
    // Start a long-poll (no pending review exists) — race it against a publish that
    // lands shortly after, well inside the wait window, and confirm it wakes fast
    // rather than sitting out the full timeout.
    const waited = call(app, token, "catch_up", { short_id: shortId, since_version: 1, wait: 20 })
    await new Promise((r) => setTimeout(r, 30))
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>V2</h1>")]), "index.html")
    const rep = await app.request(`/v1/artifacts/${shortId}/versions`, {
      method: "POST",
      body: form,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(rep.status).toBe(201)

    const c = JSON.parse(toolText(await waited))
    const elapsedMs = Date.now() - t0
    expect(elapsedMs).toBeLessThan(15_000) // woke on the event, not the 20s timeout
    expect(c.head).toBe(2) // sees the version that landed while it was waiting
    expect(c.new_versions.map((v: { n: number }) => v.n)).toContain(2)
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

  it("search: literal matches with line numbers, context, case, and regex", async () => {
    const { app, token } = appWithGrant("search", "openid derive:read derive:publish")
    const md = [
      "# Plan",
      "",
      "alpha line",
      "beta line with Pricing",
      "gamma line",
      "more pricing here",
    ].join("\n")
    const id = (await (await publishRaw(app, token, md, "plan.md", "Plan")).json()).short_id

    // Literal, case-insensitive by default: both "Pricing" and "pricing" lines match.
    const hit = toolText(await call(app, token, "search", { short_id: id, query: "pricing" }))
    expect(hit).toContain("2 matches")
    expect(hit).toContain("4: beta line with Pricing")
    expect(hit).toContain("6: more pricing here")

    // Case-sensitive narrows to the capital-P line only.
    const cs = toolText(
      await call(app, token, "search", { short_id: id, query: "Pricing", case_sensitive: true }),
    )
    expect(cs).toContain("1 match")
    expect(cs).toContain("4: beta line with Pricing")
    expect(cs).not.toContain("6:")

    // Context shows neighbouring lines with a dash marker, matches with a colon.
    const withCtx = toolText(
      await call(app, token, "search", { short_id: id, query: "beta", context: 1 }),
    )
    expect(withCtx).toContain("3- alpha line")
    expect(withCtx).toContain("4: beta line with Pricing")
    expect(withCtx).toContain("5- gamma line")

    // The query is matched LITERALLY: regex metacharacters are not special, so a
    // pattern-shaped query only matches that verbatim text (and can't backtrack).
    const literalMeta = toolText(
      await call(app, token, "search", { short_id: id, query: "^gamma" }),
    )
    expect(literalMeta).toContain("no matches") // there is no literal "^gamma" in the doc
    const literal = toolText(await call(app, token, "search", { short_id: id, query: "line with" }))
    expect(literal).toContain("4: beta line with Pricing")

    // No matches steers toward the text scope.
    const none = toolText(await call(app, token, "search", { short_id: id, query: "zzznothere" }))
    expect(none).toContain("no matches")
  })

  it("search: source vs text scope on HTML, and bundles grouped by page", async () => {
    const { app, token } = appWithGrant("search2", "openid derive:read derive:publish")
    const html = "<h1>Heading</h1>\n<p>visible pricing text</p>"
    const id = (await (await publishRaw(app, token, html, "page.html", "Page")).json()).short_id

    // Source search sees the tags; text search sees only the visible words.
    const inSource = toolText(await call(app, token, "search", { short_id: id, query: "h1" }))
    expect(inSource).toContain("in source")
    expect(inSource).toContain("<h1>Heading</h1>")
    const inText = toolText(
      await call(app, token, "search", { short_id: id, query: "h1", in: "text" }),
    )
    expect(inText).toContain("no matches")
    const wordInText = toolText(
      await call(app, token, "search", { short_id: id, query: "pricing", in: "text" }),
    )
    expect(wordInText).toContain("in text")
    expect(wordInText).toContain("pricing")

    // The steer names the format whose line numbers the results match, so the
    // follow-up windowed read lands on the same coordinate space.
    expect(inSource).toContain('read(lines:"from-to", format:"html")')
    expect(wordInText).toContain('read(lines:"from-to", format:"text")')

    // Bundle: matches across pages are grouped under each page path.
    const enc = (s: string) => new TextEncoder().encode(s)
    const form = new FormData()
    form.append(
      "file",
      new Blob([
        zipSync({
          "index.html": enc("<h1>needle home</h1>"),
          "about.html": enc("<p>needle about</p>"),
        }),
      ]),
      "site.zip",
    )
    form.append("title", "Site")
    form.append("visibility", "link")
    const bundleId = (
      await (
        await app.request("/v1/artifacts", {
          method: "POST",
          body: form,
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()
    ).short_id
    const across = toolText(
      await call(app, token, "search", { short_id: bundleId, query: "needle" }),
    )
    expect(across).toContain("index.html")
    expect(across).toContain("about.html")
    expect(across).toContain("2 matches")
  })

  it("search: matches are self-locating (§ section labels)", async () => {
    const { app, token } = appWithGrant("srchsec", "openid derive:read derive:publish")
    const md = [
      "# Doc",
      "",
      "## Budget",
      "spend is high",
      "",
      "## Risks",
      "the churn risk is real",
    ].join("\n")
    const id = (await (await publishRaw(app, token, md, "plan.md", "Plan")).json()).short_id

    // A term in each section is labelled with the heading it falls under.
    const budget = toolText(await call(app, token, "search", { short_id: id, query: "spend" }))
    expect(budget).toContain("§ Budget")
    const risk = toolText(await call(app, token, "search", { short_id: id, query: "churn" }))
    expect(risk).toContain("§ Risks")

    // On HTML, a nested labelled landmark is the section (not just top-level).
    const html =
      "<body>\n<main>\n<section aria-label='Revenue'>the pricing tier</section>\n</main>\n</body>"
    const hid = (await (await publishRaw(app, token, html, "d.html", "D")).json()).short_id
    const s = toolText(await call(app, token, "search", { short_id: hid, query: "pricing" }))
    expect(s).toContain("§ Revenue")
  })

  it("search (workspace mode, short_id omitted): greps across accessible artifacts, grouped by artifact, and NEVER leaks a private artifact's content to a viewer who isn't its member (regression)", async () => {
    const { app, token, meta, blobs } = appWithGrant(
      "wssearch",
      "openid derive:read derive:publish",
    )
    const r1 = (
      await (
        await publishRaw(
          app,
          token,
          "# Report\n\nthe visible-needle-alpha is here",
          "r1.md",
          "Report One",
        )
      ).json()
    ).short_id
    const r2 = (
      await (
        await publishRaw(app, token, "# Notes\n\nnothing relevant in here", "r2.md", "Notes")
      ).json()
    ).short_id

    // Finds the hit and names which artifact it's in — the whole point of the mode.
    const found = toolText(await call(app, token, "search", { query: "visible-needle-alpha" }))
    expect(found).toContain(r1)
    expect(found).toContain("Report One")
    expect(found).toContain("1 match")
    expect(found).not.toContain(r2) // no hit there — must not appear as an empty section

    // A DIFFERENT artifact — listed:"none" (private) and NOT a member — must never
    // surface, even though it lives in the same workspace. This mirrors exactly the
    // visibility rule list_artifacts already enforces (artifactListConditions: listed
    // != 'none' OR isMember); workspace search reuses listArtifacts with the same
    // viewerId, so this pins that it didn't accidentally widen the scope. Crucially we
    // ALSO index it below (indexArtifact) so the FTS layer genuinely NOMINATES it as a
    // candidate — otherwise the negative below would pass vacuously (an unindexed doc
    // is never a candidate). This proves the listArtifacts gate, not an empty index,
    // is what drops it.
    const owner = await meta.getByShortId(r1)
    if (!owner) throw new Error("expected the visible artifact to exist")
    const secret = "# Secret\n\nthe private-needle-zulu lives here"
    const key = await blobs.put(new TextEncoder().encode(secret))
    await meta.createArtifact({
      id: "a_stranger_private",
      short_id: "strangr1",
      org_id: owner.org_id,
      slug: null,
      title: "Stranger's Private Doc",
      workspace_access: "member",
      link_role: "none",
      listed: "none",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion("a_stranger_private", {
      id: "v_stranger1",
      blob_key: key,
      content_type: "text/markdown",
      author: "stranger",
      message: null,
    })
    // The index HAS the private artifact + its needle (org-scoped, no visibility) — so
    // searchArtifactIds will nominate it. The visibility gate must still drop it.
    await meta.indexArtifact("a_stranger_private", owner.org_id, "Stranger's Private Doc", secret)

    const afterPrivate = toolText(
      await call(app, token, "search", { query: "private-needle-zulu" }),
    )
    // "No matches for ... private-needle-zulu" legitimately echoes the searched
    // query — the leak to guard against is the private artifact's short_id or its
    // OWN content surfacing anywhere in the report, neither of which it should.
    expect(afterPrivate).toContain("No matches")
    expect(afterPrivate).not.toContain("strangr1")
    expect(afterPrivate).not.toContain("Secret")
  })

  it("search (workspace mode): a freshly published artifact is findable across the workspace (publish indexes it)", async () => {
    // End-to-end proof of the write-path: publishing runs emitVersionBump →
    // indexArtifactVersion, so the new content is in the index and workspace search
    // (index → visibility → grep-confirm) surfaces it — no short_id needed.
    const { app, token } = appWithGrant("wsidx", "openid derive:read derive:publish")
    await publishRaw(
      app,
      token,
      "# Onboarding\n\nThe kestrel protocol handles retries.",
      "doc.md",
      "Onboarding",
    )
    const res = toolText(await call(app, token, "search", { query: "kestrel" }))
    expect(res).toContain("kestrel") // grep-confirmed hunk
    expect(res).toContain("Onboarding") // grouped under its artifact
  })

  // Seed N indexed artifacts that all match one query, so the grep-confirm cap is
  // exercised. Uses the direct meta path (fast) plus indexArtifact — the same row the
  // publish write-path would write — rather than N slow tool publishes.
  const seedMatching = async (
    meta: MetaStore,
    blobs: BlobStore,
    orgId: string,
    prefix: string,
    n: number,
  ): Promise<void> => {
    const key = await blobs.put(new TextEncoder().encode("every doc mentions widget here"))
    for (let i = 0; i < n; i++) {
      const id = `a_${prefix}_${i}`
      const title = `${prefix} ${i} widget`
      await meta.createArtifact({
        id,
        short_id: `${prefix}${i.toString().padStart(4, "0")}`,
        org_id: orgId,
        slug: null,
        title,
        workspace_access: "member",
        link_role: "viewer",
        listed: "workspace",
        kind: "file",
        spa: 0,
      })
      await meta.addVersion(id, {
        id: `v_${prefix}_${i}`,
        blob_key: key,
        content_type: "text/markdown",
        author: "seeder",
        message: null,
      })
      await meta.indexArtifact(id, orgId, title, "every doc mentions widget here")
    }
  }

  it("search (workspace mode): ranks the whole corpus and shows an honest truncation note past the grep-confirm cap", async () => {
    const { app, token, meta, blobs } = appWithGrant("wscap", "openid derive:read derive:publish")
    const seed = (await (await publishRaw(app, token, "# Seed", "seed.md", "Seed")).json()).short_id
    const owner = await meta.getByShortId(seed)
    if (!owner) throw new Error("expected the seed artifact to exist")
    // 31 matching artifacts — one more than WORKSPACE_SEARCH_ARTIFACT_CAP (30), so the
    // grep-confirm cap engages and the truncation note must appear.
    await seedMatching(meta, blobs, owner.org_id, "bulk", 31)
    const res = toolText(await call(app, token, "search", { query: "widget" }))
    expect(res).toContain("candidate artifacts you can see") // the relevance-truncation note
    expect(res).toContain("top 30 of 31")
  })

  it("search (workspace mode): EXACTLY the cap (30) matching artifacts shows NO truncation note", async () => {
    const { app, token, meta, blobs } = appWithGrant(
      "wscapexact",
      "openid derive:read derive:publish",
    )
    const seed = (await (await publishRaw(app, token, "# Seed", "seed.md", "Seed")).json()).short_id
    const owner = await meta.getByShortId(seed)
    if (!owner) throw new Error("expected the seed artifact to exist")
    // Exactly 30 matching artifacts (the seed doesn't match "widget"): the strict `>`
    // boundary means no truncation note fires.
    await seedMatching(meta, blobs, owner.org_id, "exct", 30)
    const res = toolText(await call(app, token, "search", { query: "widget" }))
    expect(res).not.toContain("candidate artifacts you can see")
    expect(res).not.toContain("matched the index")
  })

  it("search (workspace mode): resolves >90 candidates correctly across visibility chunks (D1 bound-param safety)", async () => {
    const { app, token, meta, blobs } = appWithGrant("wschunk", "openid derive:read derive:publish")
    const seed = (await (await publishRaw(app, token, "# Seed", "seed.md", "Seed")).json()).short_id
    const owner = await meta.getByShortId(seed)
    if (!owner) throw new Error("expected the seed artifact to exist")
    // 120 matching artifacts exceed the 90-id visibility chunk, so candidate ids resolve
    // over multiple listArtifacts calls (each stays under D1's 100 bound-parameter cap).
    // The merged, re-ranked result must count all 120 — nothing dropped or duplicated at
    // the chunk boundary.
    await seedMatching(meta, blobs, owner.org_id, "chunk", 120)
    const res = toolText(await call(app, token, "search", { query: "widget" }))
    expect(res).toContain("top 30 of 120")
  })

  it("search (workspace mode): a taken-down artifact's content is NOT grep-exfiltratable via search (tombstone hole)", async () => {
    const { app, token, meta } = appWithGrant("wstomb", "openid derive:read derive:publish")
    const sid = (
      await (
        await publishRaw(app, token, "# Secret\n\nthe tombstoneneedle lives here", "s.md", "Secret")
      ).json()
    ).short_id
    // Findable while live — proves it's indexed (so the negative below is non-vacuous).
    expect(toolText(await call(app, token, "search", { query: "tombstoneneedle" }))).toContain(
      "tombstoneneedle",
    )
    // Take it down. Takedown deliberately does NOT unindex (a restore must stay cheap), so
    // the index row survives and still nominates it — the ONLY thing keeping its content
    // out of search is searchWorkspace's excludeRemoved gate. This pins that hole shut:
    // the content must not be grep-readable even though the read endpoint 410s it.
    const art = await meta.getByShortId(sid)
    if (!art) throw new Error("expected the artifact to exist")
    await meta.setArtifactRemoved(art.id, new Date().toISOString())
    const after = toolText(await call(app, token, "search", { query: "tombstoneneedle" }))
    expect(after).toContain("No matches")
    expect(after).not.toContain("Secret")
    expect(after).not.toContain(sid)
  })

  it("read/search (one-artifact): a taken-down artifact serves no content, mirroring the web 410", async () => {
    const { app, token, meta } = appWithGrant("wsone", "openid derive:read derive:publish")
    const sid = (
      await (
        await publishRaw(app, token, "# Secret\n\nthe onedocneedle lives here", "s.md", "Secret")
      ).json()
    ).short_id
    // Readable by short_id while live.
    expect(toolText(await call(app, token, "read", { short_id: sid }))).toContain("onedocneedle")
    const art = await meta.getByShortId(sid)
    if (!art) throw new Error("expected the artifact to exist")
    await meta.setArtifactRemoved(art.id, new Date().toISOString())
    // After takedown, the direct one-artifact paths (which resolve through reach, not the
    // index) must ALSO refuse content — otherwise knowing the short_id bypasses the 410.
    const read = toolText(await call(app, token, "read", { short_id: sid }))
    expect(read).toContain("taken down")
    expect(read).not.toContain("onedocneedle")
    const one = toolText(await call(app, token, "search", { short_id: sid, query: "onedocneedle" }))
    expect(one).toContain("taken down")
    expect(one).not.toContain("onedocneedle")
  })

  it("search (workspace mode): index nominations lacking the exact literal are not reported as matches (recall vs precision)", async () => {
    const { app, token, meta, blobs } = appWithGrant("wsprec", "openid derive:read derive:publish")
    const seed = (await (await publishRaw(app, token, "# Seed", "seed.md", "Seed")).json()).short_id
    const owner = await meta.getByShortId(seed)
    if (!owner) throw new Error("expected the seed artifact to exist")
    // Both words are present but never the contiguous phrase "alpha omega".
    const key = await blobs.put(
      new TextEncoder().encode("alpha here and omega there, not adjacent"),
    )
    for (let i = 0; i < 3; i++) {
      const id = `a_prec_${i}`
      await meta.createArtifact({
        id,
        short_id: `prec${i.toString().padStart(5, "0")}`,
        org_id: owner.org_id,
        slug: null,
        title: `Prec ${i}`,
        workspace_access: "member",
        link_role: "viewer",
        listed: "workspace",
        kind: "file",
        spa: 0,
      })
      await meta.addVersion(id, {
        id: `v_prec_${i}`,
        blob_key: key,
        content_type: "text/markdown",
        author: "s",
        message: null,
      })
      await meta.indexArtifact(
        id,
        owner.org_id,
        `Prec ${i}`,
        "alpha here and omega there, not adjacent",
      )
    }
    // The index nominates all three (both prefix tokens present), but grep-confirm for the
    // contiguous literal finds nothing → honestly "No matches", never a false hit.
    const res = toolText(await call(app, token, "search", { query: "alpha omega" }))
    expect(res).toContain("No matches")
  })

  it("searchWorkspace hides a password-locked artifact's content unless the caller reads it via a workspace SEAT (not the locked link)", async () => {
    const { app, token, meta, blobs } = appWithGrant("wslock", "openid derive:read derive:publish")
    const seed = (await (await publishRaw(app, token, "# Seed", "seed.md", "Seed")).json()).short_id
    const owner = await meta.getByShortId(seed)
    if (!owner) throw new Error("expected the seed artifact to exist")
    const org = owner.org_id
    const key = await blobs.put(new TextEncoder().encode("the gatedneedle lives inside"))
    // Three PUBLIC-listed artifacts with the same content. A password locks the WORLD LINK;
    // whether the caller can still read the body turns on whether they hold a NON-link grant.
    const mk = async (id: string, locked: boolean, workspace_access: "member" | "none") => {
      await meta.createArtifact({
        id,
        short_id: id,
        org_id: org,
        slug: null,
        title: `Doc ${id}`,
        workspace_access,
        link_role: "viewer",
        listed: "public",
        password_hash: locked ? "a-real-hash" : null,
        kind: "file",
        spa: 0,
      })
      await meta.addVersion(id, {
        id: `v_${id}`,
        blob_key: key,
        content_type: "text/markdown",
        author: "o",
        message: null,
      })
      await meta.indexArtifact(id, org, `Doc ${id}`, "the gatedneedle lives inside")
    }
    await mk("aopen", false, "member") // no lock
    await mk("alock", true, "member") // locked, but a member's SEAT reads it (not the link)
    // Locked AND workspace_access:"none": a member can reach it only through the (locked) link,
    // so its body must stay hidden from them — reading it would 401 "password required".
    await mk("alocknone", true, "none")
    const sourceText = async (v: { blob_key: string; content_type: string }) => {
      const b = await blobs.get(v.blob_key)
      return b ? new TextDecoder().decode(b) : null
    }
    const deps = { blobs, sourceText, meta }
    const base = {
      orgId: org,
      query: "gatedneedle",
      re: searchMatcher("gatedneedle", false),
      where: "text" as const,
      ctxLines: 0,
      cap: 40,
    }
    // Anonymous / non-member (publicOnly): every locked doc's body must be non-grep-readable —
    // reading needs the password, and search must not bypass that.
    const anon = await searchWorkspace(deps, { ...base, publicOnly: true })
    expect(anon.results.map((r) => r.short_id).sort()).toEqual(["aopen"])
    // A member (no publicOnly) surfaces the unlocked doc AND the seat-readable lock — but NOT
    // the workspace_access:"none" lock, which they could only open via the locked link.
    const member = await searchWorkspace(deps, base)
    expect(member.results.map((r) => r.short_id).sort()).toEqual(["alock", "aopen"])
  })

  it("versionIndexText degrades safely on the non-happy paths (never throws)", async () => {
    // These branches are load-bearing: they keep a publish from throwing, and a throw
    // here would only be swallowed by emitVersionBump's best-effort catch (silently
    // dropping the artifact from search). Pin them so a refactor can't regress them.
    const dir = mkdtempSync(join(tmpdir(), "vit-"))
    const blobs = new FsBlobStore(join(dir, "b"))
    const v = (blobKey: string, ct: string) =>
      ({ blob_key: blobKey, content_type: ct }) as VersionRecord
    // Happy single-file: the source is indexed.
    const md = await blobs.put(new TextEncoder().encode("# Title\n\nthe indexed body"))
    expect(await versionIndexText(blobs, v(md, "text/markdown"))).toContain("indexed body")
    // Oversized source is capped, not unbounded.
    const big = await blobs.put(new TextEncoder().encode("x".repeat(MAX_INDEX_TEXT + 5000)))
    expect((await versionIndexText(blobs, v(big, "text/markdown"))).length).toBeLessThanOrEqual(
      MAX_INDEX_TEXT,
    )
    // Degrade branches → "" (never a throw):
    const img = await blobs.put(new Uint8Array([1, 2, 3, 4]))
    expect(await versionIndexText(blobs, v(img, "image/png"))).toBe("") // non-text single file
    expect(await versionIndexText(blobs, v("0".repeat(64), "text/html"))).toBe("") // missing blob
    const badBundle = await blobs.put(new TextEncoder().encode("not-a-json-manifest"))
    expect(await versionIndexText(blobs, v(badBundle, "derive/bundle"))).toBe("") // unparseable manifest
    rmSync(dir, { recursive: true, force: true })
  })

  it("search reindex (backfill): a bounded, resumable sweep makes pre-existing (never-indexed) artifacts findable", async () => {
    const { app, token, meta, blobs } = appWithGrant("reidx", "openid derive:read derive:publish")
    const seed = (await (await publishRaw(app, token, "# Seed", "seed.md", "Seed")).json()).short_id
    const owner = await meta.getByShortId(seed)
    if (!owner) throw new Error("expected the seed artifact to exist")
    // 3 artifacts created via the DIRECT meta path (createArtifact + addVersion, no
    // emitVersionBump) — exactly what a pre-feature / imported artifact looks like: it
    // exists but was never indexed.
    const key = await blobs.put(new TextEncoder().encode("the backfillneedle appears here"))
    for (let i = 0; i < 3; i++) {
      await meta.createArtifact({
        id: `a_pre_${i}`,
        short_id: `pre${i.toString().padStart(5, "0")}`,
        org_id: owner.org_id,
        slug: null,
        title: `Pre ${i}`,
        workspace_access: "member",
        link_role: "viewer",
        listed: "workspace",
        kind: "file",
        spa: 0,
      })
      await meta.addVersion(`a_pre_${i}`, {
        id: `v_pre_${i}`,
        blob_key: key,
        content_type: "text/markdown",
        author: "importer",
        message: null,
      })
    }
    // Not findable before the backfill — the index has no row for them.
    expect(toolText(await call(app, token, "search", { query: "backfillneedle" }))).toContain(
      "No matches",
    )
    // Drive the bounded sweep to completion (limit:2 forces multiple pages across the
    // seed + 3 artifacts, exercising the cursor).
    let cursor: { created_at: string; id: string } | null | undefined
    let pages = 0
    let indexed = 0
    do {
      const r = await reindexSearchBatch({ meta, blobs }, { cursor: cursor ?? undefined, limit: 2 })
      indexed += r.indexed
      cursor = r.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBeGreaterThan(1) // actually paginated, not one big pass
    expect(indexed).toBeGreaterThanOrEqual(3)
    // Now findable — grouped under their artifacts.
    const found = toolText(await call(app, token, "search", { query: "backfillneedle" }))
    expect(found).toContain("backfillneedle")
    expect(found).toContain("Pre 0")
  })

  it("read: a region ref (@N) reads that region directly, with actionable errors", async () => {
    const { app, token } = appWithGrant("region", "openid derive:read derive:publish")
    const html =
      "<!DOCTYPE html><html><body><nav aria-label='Nav'>n</nav><main><p>the main body here</p></main><footer>fin</footer></body></html>"
    const id = (await (await publishRaw(app, token, html, "app.html", "App")).json()).short_id

    const region2 = toolText(await call(app, token, "read", { short_id: id, section: "@2" }))
    expect(region2).toContain("section: @2 of 3 regions")
    expect(region2).toContain("the main body here")
    // Out-of-range ref names the real count; a doc with no regions says so.
    const bad = toolText(await call(app, token, "read", { short_id: id, section: "@9" }))
    expect(bad).toContain("@1..@3")
    const md = (await (await publishRaw(app, token, "# Just markdown", "x.md", "X")).json())
      .short_id
    const none = toolText(await call(app, token, "read", { short_id: md, section: "@1" }))
    expect(none).toContain("no landmark regions")
  })

  it('read render:"top" — the publish→look loop (pending, ready as an image, failed)', async () => {
    const { app, token, meta, blobs } = appWithGrant("render", "openid derive:read derive:publish")
    const pub = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "Styled page",
          content: "<!DOCTYPE html><html><body><h1>Hi</h1></body></html>",
          filename: "page.html",
        }),
      ),
    )
    const id = pub.short_id
    // The publish receipt steers to the render read.
    expect(pub.render).toContain('render:"top"')

    // Before the pipeline finishes: an actionable not-ready message, not a failure.
    const pending = toolText(await call(app, token, "read", { short_id: id, render: "top" }))
    expect(pending).toContain("isn't ready yet")

    // render + section/lines is rejected as contradictory.
    const both = toolText(
      await call(app, token, "read", { short_id: id, render: "top", lines: "1" }),
    )
    expect(both).toContain("pass it alone")

    // Seed a ready render (what the previews worker writes) and read it back as an image.
    const art = await meta.getByShortId(id)
    if (!art) throw new Error("no artifact")
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const key = await blobs.put(png)
    await meta.setVersionPreview(art.id, 1, { preview_key: key, preview_status: "ready" })
    const r = await call(app, token, "read", { short_id: id, render: "top" })
    const content = (
      r.parsed?.result as {
        content?: { type: string; text?: string; mimeType?: string; data?: string }[]
      }
    )?.content
    expect(content?.[0]?.text).toContain(`render:top of "${id}" v1`)
    expect(content?.[1]?.type).toBe("image")
    expect(content?.[1]?.mimeType).toBe("image/png")
    expect(content?.[1]?.data?.length).toBeGreaterThan(0)

    // A failed render reports the reason and points at the page.
    await meta.setVersionPreview(art.id, 1, { preview_status: "failed", preview_error: "timeout" })
    const failed = toolText(await call(app, token, "read", { short_id: id, render: "top" }))
    expect(failed).toContain("failed (timeout)")
  })

  it('read render:"full"/"marked" are independent of render:"top" and of each other', async () => {
    const { app, token, meta, blobs } = appWithGrant("renderv", "openid derive:read derive:publish")
    const pub = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "Dash",
          content: "<!DOCTYPE html><html><body><main>x</main></body></html>",
          filename: "dash.html",
        }),
      ),
    )
    const id = pub.short_id
    const art = await meta.getByShortId(id)
    if (!art) throw new Error("no artifact")

    // "full" not ready yet, independent of "top"/"marked" (neither seeded either).
    const fullPending = toolText(await call(app, token, "read", { short_id: id, render: "full" }))
    expect(fullPending).toContain("isn't ready yet")

    // Seed ONLY the marked variant as ready — top/full stay untouched.
    const png = new Uint8Array([1, 2, 3, 4])
    const key = await blobs.put(png)
    await meta.setVersionPreviewVariant(art.id, 1, "marked", { key, status: "ready" })
    const marked = await call(app, token, "read", { short_id: id, render: "marked" })
    const markedContent = (marked.parsed?.result as { content?: { type: string; text?: string }[] })
      ?.content
    expect(markedContent?.[0]?.text).toContain(`render:marked of "${id}" v1`)
    expect(markedContent?.[0]?.text).toContain("region map's @N refs")
    expect(markedContent?.[1]?.type).toBe("image")
    // "full" is STILL not ready — the marked seed didn't touch it.
    const fullStill = toolText(await call(app, token, "read", { short_id: id, render: "full" }))
    expect(fullStill).toContain("isn't ready yet")
    // "top" is unaffected too — nothing was ever seeded for it.
    const topStill = toolText(await call(app, token, "read", { short_id: id, render: "top" }))
    expect(topStill).toContain("isn't ready yet")

    // A "full" failure is reported distinctly from a "marked" one.
    await meta.setVersionPreviewVariant(art.id, 1, "full", { status: "failed", error: "oom" })
    const fullFailed = toolText(await call(app, token, "read", { short_id: id, render: "full" }))
    expect(fullFailed).toContain("render:full")
    expect(fullFailed).toContain("failed (oom)")
  })

  it("read: windowed `lines` returns a range, and rejects bad input", async () => {
    const { app, token } = appWithGrant("window", "openid derive:read derive:publish")
    const md = ["# Doc", "line two", "line three", "line four", "line five"].join("\n")
    const id = (await (await publishRaw(app, token, md, "doc.md", "Doc")).json()).short_id

    const win = toolText(await call(app, token, "read", { short_id: id, lines: "2-3" }))
    expect(win).toContain("lines: 2-3 of 5")
    expect(win).toContain("line two")
    expect(win).toContain("line three")
    expect(win).not.toContain("line four")

    // "4-" runs to the end; a single number is one line.
    const toEnd = toolText(await call(app, token, "read", { short_id: id, lines: "4-" }))
    expect(toEnd).toContain("lines: 4-5 of 5")
    expect(toEnd).toContain("line five")
    const one = toolText(await call(app, token, "read", { short_id: id, lines: "1" }))
    expect(one).toContain("lines: 1-1 of 5")

    // lines + section is rejected; a malformed range is an actionable error.
    const both = await call(app, token, "read", { short_id: id, lines: "2-3", section: "doc" })
    expect(toolText(both)).toContain("Pass `lines` OR `section`")
    const bad = await call(app, token, "read", { short_id: id, lines: "nope" })
    expect(toolText(bad)).toContain("Bad `lines`")

    // A start past the end is an error naming the real range, not an empty "999-5" window.
    const past = toolText(await call(app, token, "read", { short_id: id, lines: "999-1000" }))
    expect(past).toContain("Bad `lines`")
    expect(past).not.toContain("999-5")
    const zero = toolText(await call(app, token, "read", { short_id: id, lines: "0" }))
    expect(zero).toContain("Bad `lines`")
  })

  it("read: a large headless HTML page returns a landmark map, not a blind dump", async () => {
    const { app, token } = appWithGrant("landmark", "openid derive:read derive:publish")
    // A designed, heading-less page bigger than the outline-first threshold.
    const filler = "<p>card content that repeats to exceed the outline threshold. </p>".repeat(700)
    const html = `<!DOCTYPE html><html><body><nav aria-label="Primary">x</nav><main>${filler}</main><footer>fin</footer></body></html>`
    const id = (await (await publishRaw(app, token, html, "dash.html", "Dashboard")).json())
      .short_id

    const res = JSON.parse(toolText(await call(app, token, "read", { short_id: id })))
    expect(res.regions.map((r: { role: string }) => r.role)).toEqual([
      "navigation",
      "main",
      "contentinfo",
    ])
    expect(res.regions[0].label).toBe("Primary")
    expect(res.next).toContain("search")
    // And it is not the old blind clipped dump.
    expect(res.sections).toBeUndefined()
  })

  it("read: a headless card grid caps the region map instead of blowing the budget", async () => {
    const { app, token } = appWithGrant("mapcap", "openid derive:read derive:publish")
    // 400 top-level sections (a card grid) — each a landmark, no headings anywhere.
    const cards = Array.from(
      { length: 400 },
      (_, i) => `<section aria-label="Card ${i}"><p>${"content ".repeat(20)}</p></section>`,
    ).join("")
    const html = `<!DOCTYPE html><html><body><main>x</main>${cards}</body></html>`
    const id = (await (await publishRaw(app, token, html, "grid.html", "Grid")).json()).short_id
    const res = JSON.parse(toolText(await call(app, token, "read", { short_id: id })))
    expect(res.regions).toHaveLength(50) // capped
    expect(res.more_regions).toBe(351) // 401 total (main + 400 cards) - 50 shown
    // The whole response stays well under the ~80k char / 25k token budget.
    const raw = toolText(await call(app, token, "read", { short_id: id }))
    expect(raw.length).toBeLessThan(20_000)
  })

  it("read: outline now covers the full h1–h6 spine", async () => {
    const { app, token } = appWithGrant("deep", "openid derive:read derive:publish")
    const md = ["# One", "## Two", "### Three", "#### Four", "##### Five", "###### Six", "", "body"]
      .join("\n")
      // Pad past the outline-first threshold so `read` returns the outline.
      .concat(`\n\n${"filler line\n".repeat(4000)}`)
    const id = (await (await publishRaw(app, token, md, "deep.md", "Deep")).json()).short_id
    const res = JSON.parse(toolText(await call(app, token, "read", { short_id: id })))
    expect(res.sections.map((s: { level: number }) => s.level)).toEqual([1, 2, 3, 4, 5, 6])
    // A level-4 heading is addressable as a section.
    const sec = toolText(await call(app, token, "read", { short_id: id, section: "four" }))
    expect(sec).toContain("Four")
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

  // End-to-end through the RENDER pipeline (not just the stored-type label): publish
  // markdown with no filename, then fetch the served /raw/ page and prove it is
  // rendered markdown with tag-like tokens intact — the exact failure that flattened
  // a real doc to raw-source soup and ate its `<...>` placeholders. Reproduces the
  // production round-trip: fresh publish, then a full-content republish with no
  // filename (the step that flipped the artifact to text/html and broke the render).
  it("render e2e: a no-filename markdown publish renders as markdown, tokens intact, across a republish", async () => {
    const { app, token } = appWithGrant("rendere2e", "openid derive:read derive:publish")
    // A heading (proves it gets RENDERED, not served as source) and a tag-like token
    // in a code span (proves it SURVIVES, escaped, instead of vanishing as a phantom tag).
    const v1 =
      "# Skills across Derive\n\n## The idea\n\nGet it as a `derive://brandprint/<short_id>` resource; put files in `<cwd>/.claude/skills/`.\n"
    const created = JSON.parse(
      toolText(
        await call(app, token, "publish", {
          title: "Skills across Derive",
          content: v1,
          link_role: "viewer", // world-link readable so the anonymous /raw/ GET renders it
        }),
      ),
    )

    // Anonymous fetch of the SERVED page — the real serveContent → renderMarkdown chain.
    const page1 = await app.request(`/raw/${created.short_id}/v/1/`)
    expect(page1.status).toBe(200)
    expect(page1.headers.get("content-type")).toContain("text/html")
    const html1 = await page1.text()
    // Rendered, not dumped: the `##` became a real heading element.
    expect(html1).toContain("<h1")
    expect(html1).toContain("<h2")
    expect(html1).toContain("The idea")
    // The token survived as escaped text inside the code span…
    expect(html1).toContain("&lt;short_id&gt;")
    // …and the raw markdown source is NOT what got served (the soup failure mode).
    expect(html1).not.toContain("## The idea")

    // The production round-trip: a full-content republish with NO filename. This is the
    // exact step that re-typed the artifact to text/html and broke it.
    const v2 =
      "# Skills across Derive\n\n## The idea\n\nRevised: `derive://brandprint/<short_id>` still resolves; skills land in `<cwd>/.claude/skills/`.\n"
    await call(app, token, "publish", { short_id: created.short_id, content: v2 })
    const page2 = await app.request(`/raw/${created.short_id}/v/2/`)
    expect(page2.status).toBe(200)
    const html2 = await page2.text()
    expect(html2).toContain("<h2")
    expect(html2).toContain("Revised")
    expect(html2).toContain("&lt;short_id&gt;")
    expect(html2).not.toContain("## The idea")
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

    // base_version conflict: the artifact is at v2, but the agent read v1. The error
    // shows WHAT changed (v1 → v2), not just that it did.
    const stale = await call(app, token, "publish", {
      short_id: shortId,
      base_version: 1,
      edits: [{ old_str: "Title", new_str: "T2" }],
    })
    const staleText = toolText(stale)
    expect(staleText).toMatch(/moved to v2/)
    expect(staleText).toContain("What changed (v1 → v2)")
    expect(staleText).toContain("+")
    expect(staleText).toContain("-")

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
