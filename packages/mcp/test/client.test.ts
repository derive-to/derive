import { mkdtempSync, rmSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "@derive/api/app"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { serve } from "@hono/node-server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createClient, type DeriveClient } from "../src/client"
import { fallbackFilename } from "../src/filename"

let server: ReturnType<typeof serve>
let meta: SqliteMetaStore
let client: DeriveClient
const dir = mkdtempSync(join(tmpdir(), "derive-mcp-"))

beforeAll(async () => {
  meta = new SqliteMetaStore(join(dir, "derive.db"))
  // The MCP server authenticates to Derive with a static token (DERIVE_TOKEN in prod);
  // anonymous callers can't write, so the test wires the same token end-to-end.
  const app = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://derive.test",
    token: "tok",
  })
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  client = createClient({ baseUrl: `http://localhost:${port}`, token: "tok" })
})

afterAll(() => {
  server.close()
  meta.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("derive client (the MCP server's backend) over real HTTP", () => {
  let shortId: string

  it("publishes and reads content back", async () => {
    const a = await client.publish({ content: "# Hello", filename: "hello.md", title: "Hello" })
    shortId = a.short_id
    expect(a.current_version).toBe(1)
    expect(a.kind).toBe("file")
    expect((await client.getContent(shortId)).text).toBe("# Hello")
  })

  it("filenameless markdown stays markdown and keeps <angle> tokens (retype-incident fix)", async () => {
    const content = "# Doc\n\nsee the <token> below"
    // What the publish tool now sends when the caller gives no filename.
    const good = await client.publish({
      content,
      filename: fallbackFilename(content),
      title: "Good",
    })
    // Read as markdown: a markdown artifact passes through, so the <token> survives.
    expect((await client.getContent(good.short_id, { format: "markdown" })).text).toContain(
      "<token>",
    )

    // Contrast with the OLD blind `index.html` default: the same content typed as HTML,
    // read back as markdown, converts — and the browser/converter drops the unknown
    // <token> tag, exactly the content-swallowing the fix prevents.
    const bad = await client.publish({ content, filename: "index.html", title: "Bad" })
    expect((await client.getContent(bad.short_id, { format: "markdown" })).text).not.toContain(
      "<token>",
    )
  })

  it("publishes a new version and reads each version back", async () => {
    const a = await client.publish({
      id: shortId,
      content: "# Hello v2",
      filename: "hello.md",
      message: "update",
    })
    expect(a.current_version).toBe(2)
    expect((await client.getContent(shortId, { version: 1 })).text).toBe("# Hello")
    expect((await client.getContent(shortId, { version: 2 })).text).toBe("# Hello v2")
  })

  it("lists version history with messages", async () => {
    const a = await client.get(shortId)
    expect(a.versions.map((v) => v.n)).toEqual([1, 2])
    expect(a.versions[1]?.message).toBe("update")
  })

  it("runs the comment loop: comment, read back, resolve on republish", async () => {
    const a = await client.publish({ content: "# spec", filename: "spec.md", title: "Spec" })
    const c1 = await client.createComment(a.short_id, {
      body_md: "tighten the intro",
      author: "jess",
      anchor: { type: "TextQuoteSelector", exact: "spec" },
    })
    expect(c1.state).toBe("open")

    // agent reads the open feedback
    const open = await client.listComments(a.short_id, "open")
    expect(open).toHaveLength(1)
    expect(open[0]?.body_md).toBe("tighten the intro")

    // agent republishes, resolving the thread in the same call
    const v2 = await client.publish({
      id: a.short_id,
      content: "# spec v2",
      filename: "spec.md",
      message: "address",
      resolves: [c1.id],
    })
    expect(v2.current_version).toBe(2)
    expect(await client.listComments(a.short_id, "open")).toHaveLength(0)
  })

  it("resolves and reopens a thread directly (not just via republish)", async () => {
    const a = await client.publish({ content: "x", filename: "t.md" })
    const c = await client.createComment(a.short_id, { body_md: "fix", author: "jess" })
    await client.setThreadState(a.short_id, c.id, "resolved")
    expect(await client.listComments(a.short_id, "open")).toHaveLength(0)
    await client.setThreadState(a.short_id, c.id, "open")
    expect(await client.listComments(a.short_id, "open")).toHaveLength(1)
  })

  it("leaves an anchored comment as a new thread", async () => {
    const a = await client.publish({ content: "alpha beta", filename: "ac.md" })
    const c = await client.createComment(a.short_id, {
      body_md: "on beta",
      author: "agent",
      anchor: { type: "TextQuoteSelector", exact: "beta" },
    })
    expect(c.thread_id).toBe(c.id) // a brand-new thread
    expect(JSON.parse(c.anchor as string).exact).toBe("beta")
  })

  it("diffs two versions", async () => {
    const a = await client.publish({ content: "# title\nalpha", filename: "d.md" })
    await client.publish({
      id: a.short_id,
      content: "# title\nbeta",
      filename: "d.md",
      message: "v2",
    })
    const d = await client.diff(a.short_id, 1, 2)
    expect(d).toMatchObject({ from: 1, to: 2 })
    expect(d.ops).toContainEqual({ t: "add", line: "beta" })
    expect(d.ops).toContainEqual({ t: "del", line: "alpha" })
  })

  it("restores a past version as a new current revision", async () => {
    const a = await client.publish({ content: "original", filename: "r.md" })
    await client.publish({ id: a.short_id, content: "changed", filename: "r.md", message: "v2" })
    const restored = await client.restore(a.short_id, 1)
    expect(restored.current_version).toBe(3)
    expect((await client.getContent(a.short_id)).text).toBe("original")
    expect((await client.getContent(a.short_id, { version: 1 })).text).toBe("original") // history intact
  })

  it("includes time-grouped sessions and version names on the detail endpoint", async () => {
    const a = await client.publish({ content: "v1", filename: "s.md" })
    await client.publish({ id: a.short_id, content: "v2", filename: "s.md", message: "edit" })
    const got = await client.get(a.short_id)
    expect(Array.isArray(got.sessions)).toBe(true)
    expect(got.versions[0]).toHaveProperty("name")
  })

  it("lists the workspace's artifacts, filtered by a title query", async () => {
    const a = await client.publish({ content: "x", filename: "l.md", title: "Listable Plan" })
    const all = await client.list()
    expect(all.some((x) => x.short_id === a.short_id)).toBe(true)
    const hit = await client.list("Listable")
    expect(hit.some((x) => x.short_id === a.short_id)).toBe(true)
    const none = await client.list("zzz-no-such-title-zzz")
    expect(none.some((x) => x.short_id === a.short_id)).toBe(false)
  })

  it("search: greps within one artifact (short_id set) over real HTTP", async () => {
    const a = await client.publish({
      content: "# Plan\n\nalpha line\nbeta line with Pricing\ngamma line",
      filename: "search1.md",
      title: "Search Target",
    })
    const hit = await client.search(a.short_id, "pricing")
    expect(hit).toContain("1 match")
    expect(hit).toContain("beta line with Pricing")

    const cs = await client.search(a.short_id, "Pricing", { caseSensitive: true })
    expect(cs).toContain("1 match")
    const csMiss = await client.search(a.short_id, "PRICING", { caseSensitive: true })
    expect(csMiss).toContain("no matches")

    const html = await client.publish({
      content: "<h1>Heading</h1>\n<p>visible pricing text</p>",
      filename: "search1.html",
      title: "Search HTML",
    })
    const inSource = await client.search(html.short_id, "h1")
    expect(inSource).toContain("<h1>Heading</h1>")
    const inText = await client.search(html.short_id, "h1", { in: "text" })
    expect(inText).toContain("no matches")
  })

  it("search: greps ACROSS the workspace when short_id is omitted, over real HTTP (route-order + cross-artifact grouping)", async () => {
    const a = await client.publish({
      content: "# Doc One\n\nthe stdio-workspace-needle-alpha lives here",
      filename: "wsA.md",
      title: "Workspace Doc A",
    })
    await client.publish({
      content: "# Doc Two\n\nnothing relevant in this one",
      filename: "wsB.md",
      title: "Workspace Doc B",
    })
    // A route-order regression (workspace search shadowed by GET /v1/artifacts/:id)
    // would 404 here instead of returning a report — this exercises the client's
    // real HTTP path, not just the REST layer directly (packages/mcp is a SEPARATE
    // package/build from apps/api, so this is genuine end-to-end coverage).
    const report = await client.search(undefined, "stdio-workspace-needle-alpha")
    expect(report).toContain(a.short_id)
    expect(report).toContain("Workspace Doc A")
    expect(report).not.toContain("Workspace Doc B")
  })

  it("proposes a single-file revision for review (with and without addresses)", async () => {
    const a = await client.publish({ content: "# headline", filename: "p.md", title: "Proposable" })
    const c = await client.createComment(a.short_id, { body_md: "fix headline", author: "jess" })
    const p = await client.propose(a.short_id, {
      content: "# fixed headline",
      message: "tightened",
      addresses: [c.thread_id],
    })
    expect(p.id).toBeTruthy()
    expect(p.base_version).toBe(1)
    expect(p.addressed).toEqual([c.thread_id])
    // The live version is untouched — a proposal is not a publish.
    expect((await client.getContent(a.short_id)).text).toBe("# headline")

    // No `addresses` (default filename) covers the other branch.
    const p2 = await client.propose(a.short_id, { content: "# again", message: "another pass" })
    expect(p2.id).toBeTruthy()

    // Bytes content (the content_path lane) proposes the same as a string.
    const p3 = await client.propose(a.short_id, {
      content: new TextEncoder().encode("# from a file"),
      message: "by path",
    })
    expect(p3.id).toBeTruthy()
  })

  it("getContent format:'html' returns the exact stored source (the edits precondition)", async () => {
    const src = "<html><head><title>t</title></head><body><h1>H</h1><p>body</p></body></html>"
    const a = await client.publish({ content: src, filename: "h.html", title: "Html read" })
    const r = await client.getContent(a.short_id, { format: "html" })
    expect(r.text).toBe(src)
  })

  it("surfaces server errors as thrown messages", async () => {
    await expect(client.get("nope0000")).rejects.toThrow(/derive 404/)
  })

  it("getContent: format/section params round-trip, with capability headers", async () => {
    const html =
      "<html><head><style>x{color:red}</style></head><body><h1>Doc</h1><h2>Alpha</h2><p>a</p><h2>Beta</h2><p>b</p></body></html>"
    const a = await client.publish({ content: html, filename: "fmt.html", title: "Fmt" })

    const raw = await client.getContent(a.short_id)
    expect(raw.text).toBe(html)
    expect(raw.supportsParams).toBe(true)
    expect(raw.format).toBe("raw")

    const md = await client.getContent(a.short_id, { format: "markdown" })
    expect(md.text).toContain("# Doc")
    expect(md.text).not.toContain("color:red")
    expect(md.format).toBe("markdown")

    const sec = await client.getContent(a.short_id, { section: "alpha", format: "markdown" })
    expect(sec.text).toContain("a")
    expect(sec.text).not.toContain("Beta")
    expect(sec.section).toBe("alpha")
  })

  it("getOutline: heading slugs for a single-file doc", async () => {
    const a = await client.publish({
      content: "<h1>Top</h1><h2>Alpha</h2><p>x</p><h2>Beta</h2><p>y</p>",
      filename: "outline.html",
      title: "Outline",
    })
    const outline = await client.getOutline(a.short_id)
    expect(outline.sections.map((s) => s.slug)).toEqual(["top", "alpha", "beta"])
    expect(outline.pages).toBeNull()
  })

  it("publish edits: materializes a revision without resending content", async () => {
    const a = await client.publish({
      content: "<h1>Title</h1><p>alpha beta gamma</p>",
      filename: "edit.html",
      title: "Editable",
    })
    const v2 = await client.publish({
      id: a.short_id,
      edits: [{ old_str: "beta", new_str: "BETA" }],
    })
    expect(v2.current_version).toBe(2)
    expect((await client.getContent(a.short_id)).text).toContain("alpha BETA gamma")

    // A stale base_version is rejected before anything applies.
    await expect(
      client.publish({
        id: a.short_id,
        edits: [{ old_str: "BETA", new_str: "nope" }],
        baseVersion: 1,
      }),
    ).rejects.toThrow(/derive 409/)
  })

  it("propose edits: stages a proposal from materialized text, live version untouched", async () => {
    const a = await client.publish({
      content: "<h1>x</h1><p>keep this</p>",
      filename: "pe.html",
      title: "Propose Edits",
    })
    const p = await client.propose(a.short_id, {
      edits: [{ old_str: "keep this", new_str: "changed this" }],
      message: "tweak",
    })
    expect(p.id).toBeTruthy()
    const live = await client.getContent(a.short_id)
    expect(live.text).toContain("keep this")
    expect(live.text).not.toContain("changed this")
  })

  it("diff: content=markdown diffs the readable form", async () => {
    const a = await client.publish({
      content:
        "<html><head><style>x{color:red}</style></head><body><p>alpha bravo</p></body></html>",
      filename: "diffmd.html",
      title: "Diff MD",
    })
    await client.publish({
      id: a.short_id,
      content:
        "<html><head><style>x{color:blue}</style></head><body><p>alpha BRAVO</p></body></html>",
    })
    const semantic = await client.diff(a.short_id, 1, 2, "markdown")
    const text = semantic.ops.map((o) => o.line).join("\n")
    expect(text).toContain("BRAVO")
    expect(text).not.toContain("<style>")
  })
})

describe("createClient — workspace targeting", () => {
  // The workspace header only matters for an OAuth agent token (see
  // apps/api/src/context.ts's re-home logic) — a static DERIVE_TOKEN ignores it
  // server-side, so that path is covered by the API's own oauth-workspace tests.
  // What belongs here, at the client boundary, is simpler: does the option turn
  // into the header at all, on every call. `fetchImpl` intercepts before any
  // network I/O.
  const capture = () => {
    const calls: [string, RequestInit | undefined][] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push([String(url), init])
      return new Response(JSON.stringify({ artifacts: [] }), { status: 200 })
    }) as typeof fetch
    return { calls, fetchImpl }
  }

  it("sends X-Derive-Workspace when a workspace is set", async () => {
    const { calls, fetchImpl } = capture()
    const c = createClient({ baseUrl: "http://x", token: "t", workspace: "ws_acme", fetchImpl })
    await c.list()
    expect(calls).toHaveLength(1)
    const headers = calls[0]?.[1]?.headers as Record<string, string>
    expect(headers["X-Derive-Workspace"]).toBe("ws_acme")
    expect(headers.Authorization).toBe("Bearer t")
  })

  it("omits the header entirely when no workspace is given", async () => {
    const { calls, fetchImpl } = capture()
    const c = createClient({ baseUrl: "http://x", token: "t", fetchImpl })
    await c.list()
    expect(calls).toHaveLength(1)
    const headers = calls[0]?.[1]?.headers as Record<string, string>
    expect(headers["X-Derive-Workspace"]).toBeUndefined()
  })
})

// The tag/collection client methods that back the local MCP `organize` tool, exercised
// over the same real in-process HTTP server. (The dense-arm suggestion path has no embedder
// here, so suggestTags returns the vocabulary-only fallback — the semantic aggregation is
// covered by a computeTagSuggestions unit test in apps/api.)
describe("organize backend: tags + collections client methods over real HTTP", () => {
  it("publish sets tags; list(tag) filters; get + list carry them", async () => {
    const a = await client.publish({
      content: "# A",
      title: "Alpha",
      tags: ["Q3 Plan", "planning"],
    })
    await client.publish({ content: "# B", title: "Beta", tags: ["planning"] })
    // Normalized (lowercase, whitespace-collapsed, sorted) on the detail read.
    expect((await client.get(a.short_id)).tags).toEqual(["planning", "q3 plan"])
    // Tag filter narrows the listing; each row carries its tags.
    const listed = await client.list(undefined, "q3 plan")
    expect(listed.map((x) => x.short_id)).toEqual([a.short_id])
    expect(listed[0]?.tags).toEqual(["planning", "q3 plan"])
  })

  it("listTags returns the vocabulary with counts, most-used first", async () => {
    const vocab = await client.listTags()
    expect(vocab.find((t) => t.tag === "planning")?.count).toBe(2)
    // Sorted by count desc — the most-used tag leads.
    expect(vocab[0]?.count).toBeGreaterThanOrEqual(vocab[vocab.length - 1]?.count ?? 0)
  })

  it("tag add unions, remove drops, set replaces", async () => {
    const { short_id } = await client.publish({ content: "# T", title: "Tagme", tags: ["keep"] })
    const added = await client.tag([short_id], { add: ["extra"] })
    expect(added.updated).toBe(1)
    expect((await client.get(short_id)).tags).toEqual(["extra", "keep"])
    await client.tag([short_id], { remove: ["keep"] })
    expect((await client.get(short_id)).tags).toEqual(["extra"])
    await client.tag([short_id], { set: ["only"] })
    expect((await client.get(short_id)).tags).toEqual(["only"])
  })

  it("suggestTags returns current tags + vocabulary (no dense arm ⇒ empty suggestions)", async () => {
    const { short_id } = await client.publish({ content: "# S", title: "Subj", tags: ["draft"] })
    const s = await client.suggestTags(short_id)
    expect(s.current).toEqual(["draft"])
    expect(s.suggested).toEqual([])
    expect(s.vocabulary.map((t) => t.tag)).toContain("planning")
  })

  it("collect creates a collection by name and folds artifacts in; get shows membership", async () => {
    const a = await client.publish({ content: "# 1", title: "One" })
    const b = await client.publish({ content: "# 2", title: "Two" })
    const res = await client.collect([a.short_id, b.short_id], "Q3 Work")
    expect(res.added).toBe(2)
    expect(res.collection.title).toBe("Q3 Work")
    expect((await client.get(a.short_id)).collections).toContain(res.collection.id)
    // Same name again resolves to the SAME collection (matched, not duplicated).
    const c = await client.publish({ content: "# 3", title: "Three" })
    const again = await client.collect([c.short_id], "Q3 Work")
    expect(again.collection.id).toBe(res.collection.id)
    expect((await client.listCollections()).find((x) => x.id === res.collection.id)?.count).toBe(3)
  })
})
