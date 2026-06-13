import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import Database from "better-sqlite3"
import { zipSync } from "fflate"
import { afterAll, describe, expect, it } from "vitest"
import { type AppDeps, createApp } from "../src/app"

const dir = mkdtempSync(join(tmpdir(), "dock-test-"))
const meta = new SqliteMetaStore(join(dir, "dock.db"))
const app = createApp({
  meta,
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: "http://dock.test",
})

afterAll(() => {
  meta.close()
  rmSync(dir, { recursive: true, force: true })
})

const upload = (
  name: string,
  content: Uint8Array | string,
  fields: Record<string, string> = {},
  shortId?: string,
) => {
  const form = new FormData()
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
  form.append("file", new Blob([bytes as BlobPart]), name)
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const url = shortId ? `/v1/artifacts/${shortId}/versions` : "/v1/artifacts"
  return app.request(url, { method: "POST", body: form })
}

const postJson = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("version sessions", () => {
  it("a named publish stores the checkpoint name on the version", async () => {
    const { short_id } = await (await upload("n.md", "v1")).json()
    await upload("n.md", "v2", { name: "Final draft" }, short_id)
    const a = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(a.versions[1].name).toBe("Final draft")
    expect(a.versions[0].name).toBeNull()
  })

  it("includes a sessions array alongside raw versions", async () => {
    const { short_id } = await (await upload("s.md", "v1")).json()
    const a = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(Array.isArray(a.sessions)).toBe(true)
    expect(a.sessions[0]).toMatchObject({ n: 1, from_n: 1, count: 1 })
  })

  it("collapses a same-author burst into one session", async () => {
    const { short_id } = await (await upload("b.md", "v1")).json()
    await upload("b.md", "v2", {}, short_id)
    await upload("b.md", "v3", {}, short_id)
    const a = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(a.versions).toHaveLength(3)
    expect(a.sessions).toHaveLength(1)
    expect(a.sessions[0]).toMatchObject({ n: 3, from_n: 1, count: 3 })
  })

  it("pins a named checkpoint as its own session", async () => {
    const { short_id } = await (await upload("p.md", "v1")).json()
    await upload("p.md", "v2", {}, short_id)
    await upload("p.md", "v3", { name: "Approved" }, short_id)
    const a = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    // newest-first: [named v3], [v1+v2 burst]
    expect(a.sessions).toHaveLength(2)
    expect(a.sessions[0]).toMatchObject({ n: 3, name: "Approved", count: 1 })
    expect(a.sessions[1]).toMatchObject({ n: 2, from_n: 1, count: 2 })
  })

  it("starts a new session when the author changes", async () => {
    const { short_id } = await (await upload("au.md", "v1", { author: "ava" })).json()
    await upload("au.md", "v2", { author: "bo" }, short_id)
    const a = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(a.sessions).toHaveLength(2)
    expect(a.sessions[0]).toMatchObject({ author: "bo" })
    expect(a.sessions[1]).toMatchObject({ author: "ava" })
  })

  it("honors the configured window (each revision its own session)", async () => {
    const m2 = new SqliteMetaStore(join(dir, "win.db"))
    const app2 = createApp({
      meta: m2,
      blobs: new FsBlobStore(join(dir, "blobs")),
      baseUrl: "http://dock.test",
      versionWindowMs: -1,
    })
    const mk = (c: string, id?: string) => {
      const fd = new FormData()
      fd.append("file", new Blob([new TextEncoder().encode(c)]), "w.md")
      return app2.request(id ? `/v1/artifacts/${id}/versions` : "/v1/artifacts", {
        method: "POST",
        body: fd,
      })
    }
    const { short_id } = await (await mk("v1")).json()
    await mk("v2", short_id)
    const a = await (await app2.request(`/v1/artifacts/${short_id}`)).json()
    expect(a.versions).toHaveLength(2)
    expect(a.sessions).toHaveLength(2) // window -1 → never merge
    m2.close()
  })
})

describe("version restore", () => {
  it("restores a past version as a new current revision", async () => {
    const { short_id } = await (await upload("r.md", "alpha")).json()
    await upload("r.md", "beta", {}, short_id)
    const res = await postJson(`/v1/artifacts/${short_id}/restore`, { version: 1 })
    expect(res.status).toBe(201)
    const a = await res.json()
    expect(a.current_version).toBe(3)
    expect(a.versions[2].message).toBe("Restored v1")
  })

  it("reproduces the restored version's content exactly", async () => {
    const { short_id } = await (await upload("rc.md", "# original")).json()
    await upload("rc.md", "# changed", {}, short_id)
    await postJson(`/v1/artifacts/${short_id}/restore`, { version: 1 })
    const current = await (await app.request(`/v1/artifacts/${short_id}/content`)).text()
    expect(current).toBe("# original")
  })

  it("preserves the original version after restore (history not rewritten)", async () => {
    const { short_id } = await (await upload("rp.md", "one")).json()
    await upload("rp.md", "two", {}, short_id)
    await postJson(`/v1/artifacts/${short_id}/restore`, { version: 1 })
    expect(await (await app.request(`/v1/artifacts/${short_id}/content?v=1`)).text()).toBe("one")
    expect(await (await app.request(`/v1/artifacts/${short_id}/content?v=2`)).text()).toBe("two")
  })

  it("404s restoring an unknown version", async () => {
    const { short_id } = await (await upload("r4.md", "x")).json()
    expect((await postJson(`/v1/artifacts/${short_id}/restore`, { version: 99 })).status).toBe(404)
  })

  it("400s when no version is given", async () => {
    const { short_id } = await (await upload("r0.md", "x")).json()
    expect((await postJson(`/v1/artifacts/${short_id}/restore`, {})).status).toBe(400)
  })
})

describe("publish html file", () => {
  let shortId: string

  it("publishes and returns a stable url", async () => {
    const res = await upload(
      "q1-review.html",
      "<h1>Q1 Review</h1><script>document.title='hi'</script>",
      {
        title: "Q1 Review",
      },
    )
    expect(res.status).toBe(201)
    const json = await res.json()
    shortId = json.short_id
    expect(json.url).toBe(`http://dock.test/a/${shortId}-q1-review`)
    expect(json.kind).toBe("file")
    expect(json.current_version).toBe(1)
  })

  it("serves the viewer shell and sandboxed raw content", async () => {
    const viewer = await app.request(`/a/${shortId}-q1-review`)
    expect(viewer.status).toBe(200)
    expect(await viewer.text()).toContain("Q1 Review")

    const raw = await app.request(`/raw/${shortId}/v/1/index.html`)
    expect(raw.status).toBe(200)
    expect(raw.headers.get("content-security-policy")).toContain("sandbox allow-scripts")
    expect(raw.headers.get("content-security-policy")).not.toContain("allow-same-origin")
    expect(await raw.text()).toContain("<h1>Q1 Review</h1>")
  })

  it("republishes as v2 while @v1 stays immutable", async () => {
    const res = await upload(
      "q1-review.html",
      "<h1>Q1 Review v2</h1>",
      { message: "address review" },
      shortId,
    )
    expect(res.status).toBe(201)
    expect((await res.json()).current_version).toBe(2)

    expect(await (await app.request(`/raw/${shortId}/v/1/index.html`)).text()).toContain(
      "Q1 Review</h1>",
    )
    expect(await (await app.request(`/raw/${shortId}/v/2/index.html`)).text()).toContain(
      "Q1 Review v2",
    )

    const oldViewer = await app.request(`/a/${shortId}@v1`)
    expect(await oldViewer.text()).toContain("jump to current (v2)")
  })
})

describe("publish static bundle (astro-style dist)", () => {
  let shortId: string

  it("publishes a zip with nested assets and pretty urls", async () => {
    const zip = zipSync({
      "index.html": new TextEncoder().encode("<h1>Site</h1><script src='/assets/app.js'></script>"),
      "assets/app.js": new TextEncoder().encode("console.log('hi')"),
      "about/index.html": new TextEncoder().encode("<h1>About</h1>"),
    })
    const res = await upload("dist.zip", zip, { title: "My Site", spa: "true" })
    expect(res.status).toBe(201)
    const json = await res.json()
    shortId = json.short_id
    expect(json.kind).toBe("bundle")
  })

  it("serves nested assets with correct mime", async () => {
    const js = await app.request(`/raw/${shortId}/v/1/assets/app.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get("content-type")).toContain("text/javascript")
  })

  it("rewrites root-absolute urls so assets resolve under the raw prefix", async () => {
    const html = await (await app.request(`/raw/${shortId}/v/1/index.html`)).text()
    expect(html).toContain(`src='/raw/${shortId}/v/1/assets/app.js'`)
    expect(html).not.toContain(`src='/assets/app.js'`)
  })

  it("supports pretty urls and spa fallback", async () => {
    const about = await app.request(`/raw/${shortId}/v/1/about`)
    expect(await about.text()).toContain("<h1>About</h1>")

    const fallback = await app.request(`/raw/${shortId}/v/1/some/client/route`)
    expect(fallback.status).toBe(200)
    expect(await fallback.text()).toContain("<h1>Site</h1>")
  })
})

describe("view analytics", () => {
  it("records views and aggregates counts, uniques, per-version, and recent viewers", async () => {
    const { short_id } = await (await upload("a.md", "# A")).json()
    await upload("a.md", "# A v2", { message: "v2" }, short_id) // now at v2

    // Three views from one anonymous viewer (cookie reused), one from another.
    let cookie = ""
    for (let i = 0; i < 3; i++) {
      const r = await app.request(`/v1/artifacts/${short_id}/view`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ version: 1 }),
      })
      cookie ||= (r.headers.get("set-cookie") ?? "").split(";")[0]
    }
    await app.request(`/v1/artifacts/${short_id}/view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    const a = await (await app.request(`/v1/artifacts/${short_id}/analytics`)).json()
    expect(a.total).toBe(4)
    expect(a.unique).toBe(2) // one reused cookie + one fresh
    expect(a.perVersion).toEqual([
      { version: 1, count: 3 },
      { version: 2, count: 1 },
    ])
    expect(a.daily.reduce((s: number, d: { count: number }) => s + d.count, 0)).toBe(4)
    expect(a.recent.length).toBe(2)
    expect(a.recent.every((r: { kind: string }) => r.kind === "anon")).toBe(true)

    // Batch counts surface on the library listing.
    const list = await (await app.request("/v1/artifacts")).json()
    const row = list.artifacts.find((x: { short_id: string }) => x.short_id === short_id)
    expect(row.views).toBe(4)
  })

  it("no-ops when analytics is disabled", async () => {
    const off = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, "blobs2")),
      baseUrl: "http://dock.test",
      analytics: false,
    })
    const { short_id } = await (async () => {
      const form = new FormData()
      form.append("file", new Blob([new TextEncoder().encode("# B")]), "b.md")
      return (await off.request("/v1/artifacts", { method: "POST", body: form })).json()
    })()
    const v = await off.request(`/v1/artifacts/${short_id}/view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(v.status).toBe(204)
    const a = await off.request(`/v1/artifacts/${short_id}/analytics`)
    expect(a.status).toBe(404)
  })
})

describe("publish markdown", () => {
  it("renders sanitized html and serves raw source", async () => {
    const md = "# Notes\n\nSome *text*.\n\n<script>alert(1)</script>"
    const res = await upload("notes.md", md)
    const { short_id } = await res.json()

    const rendered = await app.request(`/raw/${short_id}/v/1/index.html`)
    const html = await rendered.text()
    expect(html).toContain("<h1>Notes</h1>")
    expect(html).not.toContain("<script>alert")

    const raw = await app.request(`/raw/${short_id}/v/1/raw.md`)
    expect(raw.headers.get("content-type")).toContain("text/markdown")
    expect(await raw.text()).toBe(md)
  })
})

describe("api surface", () => {
  it("returns artifact json with version history", async () => {
    const res = await upload("doc.html", "<p>one</p>", { title: "Doc" })
    const { short_id } = await res.json()
    await upload("doc.html", "<p>two</p>", { message: "tweak" }, short_id)

    const meta = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(meta.current_version).toBe(2)
    expect(meta.versions).toHaveLength(2)
    expect(meta.versions[1].message).toBe("tweak")
  })

  it("reads back source content for any version", async () => {
    const res = await upload("read.md", "# one", { title: "Read" })
    const { short_id } = await res.json()
    await upload("read.md", "# two", { message: "v2" }, short_id)

    const cur = await app.request(`/v1/artifacts/${short_id}/content`)
    expect(cur.status).toBe(200)
    expect(cur.headers.get("x-dock-version")).toBe("2")
    expect(await cur.text()).toBe("# two")

    const v1 = await app.request(`/v1/artifacts/${short_id}/content?v=1`)
    expect(await v1.text()).toBe("# one")
  })

  it("reads back a bundle's entry document", async () => {
    const zip = zipSync({ "index.html": new TextEncoder().encode("<h1>Entry</h1>") })
    const { short_id } = await (await upload("site.zip", zip)).json()
    const content = await app.request(`/v1/artifacts/${short_id}/content`)
    expect(content.headers.get("x-dock-kind")).toBe("bundle")
    expect(await content.text()).toBe("<h1>Entry</h1>")
  })

  it("diffs two versions as text and json", async () => {
    const res = await upload("d.md", "# title\nalpha", { title: "D" })
    const { short_id } = await res.json()
    await upload("d.md", "# title\nbeta", { message: "v2" }, short_id)

    const txt = await app.request(`/v1/artifacts/${short_id}/diff`)
    expect(txt.status).toBe(200)
    expect(txt.headers.get("x-dock-from")).toBe("1")
    expect(txt.headers.get("x-dock-to")).toBe("2")
    const body = await txt.text()
    expect(body).toContain("  # title")
    expect(body).toContain("- alpha")
    expect(body).toContain("+ beta")

    const json = await (await app.request(`/v1/artifacts/${short_id}/diff?format=json`)).json()
    expect(json.from).toBe(1)
    expect(json.to).toBe(2)
    expect(json.ops).toContainEqual({ t: "add", line: "beta" })
  })

  it("404s on unknown artifacts and rejects empty zips", async () => {
    expect((await app.request("/v1/artifacts/zzzzzzzz")).status).toBe(404)
    expect((await app.request("/a/zzzzzzzz")).status).toBe(404)
    const bad = await upload("dist.zip", zipSync({}))
    expect(bad.status).toBe(400)
  })
})

const json = (obj: unknown) => ({
  method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj),
})

describe("comments + the loop", () => {
  let shortId: string
  let threadId: string
  let rootId: string

  it("creates a comment as a new thread", async () => {
    shortId = (await (await upload("c.md", "# doc with mean sentiment", { title: "C" })).json())
      .short_id
    const res = await app.request(
      `/v1/artifacts/${shortId}/comments`,
      json({
        body_md: "use median",
        author: "jess",
        anchor: { type: "TextQuoteSelector", exact: "mean" },
      }),
    )
    expect(res.status).toBe(201)
    const cm = await res.json()
    expect(cm.state).toBe("open")
    expect(cm.thread_id).toBe(cm.id)
    expect(cm.base_version).toBe(1)
    expect(cm.anchor).toContain("TextQuoteSelector")
    threadId = cm.thread_id
    rootId = cm.id
  })

  it("replies in the same thread", async () => {
    const cm = await (
      await app.request(
        `/v1/artifacts/${shortId}/comments`,
        json({ body_md: "agreed", thread_id: threadId }),
      )
    ).json()
    expect(cm.thread_id).toBe(threadId)
    const list = await (await app.request(`/v1/artifacts/${shortId}/comments`)).json()
    expect(list.comments).toHaveLength(2)
  })

  it("resolves and reopens a thread, with state filtering", async () => {
    await app.request(`/v1/artifacts/${shortId}/comments/${rootId}/resolve`, { method: "POST" })
    expect(
      (await (await app.request(`/v1/artifacts/${shortId}/comments?state=open`)).json()).comments,
    ).toHaveLength(0)
    expect(
      (await (await app.request(`/v1/artifacts/${shortId}/comments?state=resolved`)).json())
        .comments,
    ).toHaveLength(2)

    await app.request(
      `/v1/artifacts/${shortId}/comments/${rootId}/resolve`,
      json({ state: "open" }),
    )
    expect(
      (await (await app.request(`/v1/artifacts/${shortId}/comments?state=open`)).json()).comments,
    ).toHaveLength(2)
  })

  it("resolves threads on republish via the resolves field", async () => {
    const sid = (await (await upload("r.md", "# r", {})).json()).short_id
    const cm = await (
      await app.request(`/v1/artifacts/${sid}/comments`, json({ body_md: "fix this" }))
    ).json()

    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("# r2")]), "r.md")
    form.append("message", "address review")
    form.append("resolves", cm.id)
    await app.request(`/v1/artifacts/${sid}/versions`, { method: "POST", body: form })

    expect(
      (await (await app.request(`/v1/artifacts/${sid}/comments?state=open`)).json()).comments,
    ).toHaveLength(0)
  })

  it("validates body and 404s unknown artifacts", async () => {
    expect((await app.request(`/v1/artifacts/${shortId}/comments`, json({}))).status).toBe(400)
    expect((await app.request("/v1/artifacts/zzzzzzzz/comments")).status).toBe(404)
  })
})

describe("auth: token write-gating + per-artifact read-gating", () => {
  const authApp = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://dock.test",
    token: "s3cret",
  })
  const authed = (extra: RequestInit = {}) => ({
    ...extra,
    headers: { authorization: "Bearer s3cret", ...(extra.headers ?? {}) },
  })
  const pub = (visibility?: string, headers?: HeadersInit) => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>secret</h1>")]), "s.html")
    if (visibility) form.append("visibility", visibility)
    return authApp.request("/v1/artifacts", { method: "POST", body: form, headers })
  }

  it("rejects writes without the token, accepts with it", async () => {
    expect((await pub("link")).status).toBe(403) // permission-gated: forbidden
    const ok = await pub("link", { authorization: "Bearer s3cret" })
    expect(ok.status).toBe(201)
  })

  it("serves public/link artifacts to anyone", async () => {
    const { short_id } = await (await pub("link", { authorization: "Bearer s3cret" })).json()
    expect((await authApp.request(`/a/${short_id}`)).status).toBe(200)
    expect((await authApp.request(`/v1/artifacts/${short_id}/content`)).status).toBe(200)
  })

  it("hides gated artifacts without the token (404), reveals with it", async () => {
    const { short_id } = await (await pub("org", { authorization: "Bearer s3cret" })).json()
    expect((await authApp.request(`/a/${short_id}`)).status).toBe(404)
    expect((await authApp.request(`/v1/artifacts/${short_id}`)).status).toBe(404)
    expect((await authApp.request(`/v1/artifacts/${short_id}/content`)).status).toBe(404)
    expect((await authApp.request(`/a/${short_id}`, authed())).status).toBe(200)
    expect((await authApp.request(`/v1/artifacts/${short_id}`, authed())).status).toBe(200)
  })

  it("leaves a no-token instance fully open (the default app)", async () => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("# x")]), "x.md")
    expect((await app.request("/v1/artifacts", { method: "POST", body: form })).status).toBe(201)
  })
})

describe("live stream (SSE)", () => {
  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    needle: string,
    timeoutMs = 2500,
  ): Promise<string> {
    const dec = new TextDecoder()
    let buf = ""
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const res = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array; done: boolean }>((r) =>
          setTimeout(() => r({ value: undefined, done: false }), 150),
        ),
      ])
      if (res.value) buf += dec.decode(res.value, { stream: true })
      if (buf.includes(needle)) return buf
      if (res.done) break
    }
    throw new Error(`SSE timeout waiting for "${needle}"; got:\n${buf}`)
  }

  it("emits ready, then comment.created and version.published", async () => {
    const { short_id } = await (await upload("live.md", "# live", {})).json()
    const res = await app.request(`/v1/artifacts/${short_id}/events`)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const reader = res.body!.getReader()
    try {
      await readUntil(reader, "event: ready")

      await app.request(`/v1/artifacts/${short_id}/comments`, json({ body_md: "live note" }))
      expect(await readUntil(reader, "event: comment.created")).toContain("live note")

      const form = new FormData()
      form.append("file", new Blob([new TextEncoder().encode("# live v2")]), "live.md")
      form.append("message", "v2")
      await app.request(`/v1/artifacts/${short_id}/versions`, { method: "POST", body: form })
      expect(await readUntil(reader, "event: version.published")).toContain('"n":2')
    } finally {
      await reader.cancel()
    }
  })

  it("reports presence on heartbeat", async () => {
    const { short_id } = await (await upload("p.md", "# p", {})).json()
    const res = await app.request(`/v1/artifacts/${short_id}/presence`, json({ name: "Jess" }))
    expect((await res.json()).viewers).toEqual(["Jess"])
  })
})

// A faithful role test needs real sessions. We seed Better Auth's `user` table
// (so the share route can resolve email→id) and stand in a fake `auth` whose
// session is chosen by an `x-test-user` header (the user's email). A static
// token keeps the instance secured, so an unauthenticated caller is NOT owner.
type TestUser = { id: string; email: string; name: string | null }

const makeAuthedApp = (name: string, users: TestUser[], defaultRole?: AppDeps["defaultRole"]) => {
  const path = join(dir, `${name}.db`)
  const m = new SqliteMetaStore(path)
  const raw = new Database(path)
  raw.exec(`CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT)`)
  const ins = raw.prepare(`INSERT OR IGNORE INTO user (id, email, name) VALUES (?,?,?)`)
  for (const u of users) ins.run(u.id, u.email, u.name)
  raw.close()
  const auth = {
    handler: async () => new Response(null, { status: 404 }),
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const u = users.find((x) => x.email === headers.get("x-test-user"))
        return u ? { user: u } : null
      },
    },
  } as unknown as AppDeps["auth"]
  const app = createApp({
    meta: m,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://dock.test",
    token: "tok",
    auth,
    defaultRole,
  })
  return { app, meta: m }
}

const as = (email: string) => ({ "x-test-user": email })
const publishAs = (
  app: ReturnType<typeof createApp>,
  content: string,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
  shortId?: string,
) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), "f.html")
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const url = shortId ? `/v1/artifacts/${shortId}/versions` : "/v1/artifacts"
  return app.request(url, { method: "POST", body: form, headers })
}
const jsonAs = (headers: Record<string, string>, body: unknown) => ({
  method: "POST" as const,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
})

describe("permissions: workspace roles gate writes", () => {
  const alice: TestUser = { id: "u_alice", email: "alice@dock.test", name: "Alice" }
  const bob: TestUser = { id: "u_bob", email: "bob@dock.test", name: "Bob" }
  const { app } = makeAuthedApp("perm-roles", [alice, bob], "commenter")
  let shortId: string

  it("makes the first member the owner, who can create artifacts", async () => {
    const res = await publishAs(app, "<h1>a</h1>", {}, as(alice.email))
    expect(res.status).toBe(201)
    shortId = (await res.json()).short_id
  })

  it("provisions later members at the default role (commenter)", async () => {
    const me = await (await app.request("/v1/me", { headers: as(bob.email) })).json()
    expect(me.user.role).toBe("commenter")
  })

  it("blocks a commenter from creating or republishing", async () => {
    expect((await publishAs(app, "<h1>b</h1>", {}, as(bob.email))).status).toBe(403)
    expect((await publishAs(app, "<h1>a2</h1>", {}, as(bob.email), shortId)).status).toBe(403)
  })

  it("lets a commenter comment, but not an unauthenticated caller", async () => {
    const ok = await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(bob.email), { body_md: "nice" }),
    )
    expect(ok.status).toBe(201)
    const anon = await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs({}, { body_md: "x" }),
    )
    expect(anon.status).toBe(403)
  })
})

describe("permissions: a per-artifact share overrides the workspace role", () => {
  const owner: TestUser = { id: "u_own", email: "own@dock.test", name: "Own" }
  const carol: TestUser = { id: "u_carol", email: "carol@dock.test", name: "Carol" }
  const { app } = makeAuthedApp("perm-share", [owner, carol], "viewer")
  let shortId: string

  it("a workspace viewer can read an org artifact but not republish it", async () => {
    shortId = (
      await (await publishAs(app, "<h1>secret</h1>", { visibility: "org" }, as(owner.email))).json()
    ).short_id
    expect(
      (await app.request(`/v1/artifacts/${shortId}`, { headers: as(carol.email) })).status,
    ).toBe(200)
    expect((await publishAs(app, "<h1>edit</h1>", {}, as(carol.email), shortId)).status).toBe(403)
  })

  it("sharing the artifact as editor lets the viewer republish, and my_role reflects it", async () => {
    const share = await app.request(`/v1/artifacts/${shortId}/members`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ email: carol.email, role: "editor" }),
    })
    expect(share.status).toBe(201)
    expect((await publishAs(app, "<h1>edit</h1>", {}, as(carol.email), shortId)).status).toBe(201)
    const meta = await (
      await app.request(`/v1/artifacts/${shortId}`, { headers: as(carol.email) })
    ).json()
    expect(meta.my_role).toBe("editor")
  })

  it("only an owner can manage shares (an editor cannot)", async () => {
    const byEditor = await app.request(`/v1/artifacts/${shortId}/members`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(carol.email) },
      body: JSON.stringify({ email: owner.email, role: "viewer" }),
    })
    expect(byEditor.status).toBe(403)
  })

  it("the owner sees the share in the member list", async () => {
    const list = await (
      await app.request(`/v1/artifacts/${shortId}/members`, { headers: as(owner.email) })
    ).json()
    expect(list.default_role).toBe("viewer")
    expect(list.members).toContainEqual(
      expect.objectContaining({ email: carol.email, role: "editor" }),
    )
  })
})

const proposeAs = (
  app: ReturnType<typeof createApp>,
  shortId: string,
  content: string,
  headers: Record<string, string> = {},
  fields: Record<string, string> = {},
) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), "f.html")
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return app.request(`/v1/artifacts/${shortId}/proposals`, { method: "POST", body: form, headers })
}

describe("reviews: propose → approve goes live; commenter can't approve", () => {
  const owner: TestUser = { id: "u_ro", email: "ro@dock.test", name: "Ro" }
  const cassie: TestUser = { id: "u_cassie", email: "cassie@dock.test", name: "Cassie" }
  const { app } = makeAuthedApp("reviews", [owner, cassie], "commenter")
  let shortId: string
  let proposalId: string

  it("owner publishes v1; a commenter proposes a candidate that does NOT go live", async () => {
    shortId = (await (await publishAs(app, "<h1>v1 live</h1>", {}, as(owner.email))).json())
      .short_id
    const res = await proposeAs(app, shortId, "<h1>candidate</h1>", as(cassie.email), {
      message: "tighten the headline",
    })
    expect(res.status).toBe(201)
    const p = await res.json()
    proposalId = p.id
    expect(p.state).toBe("open")
    expect(p.base_version).toBe(1)

    // The artifact is untouched: still v1, but the review queue shows 1.
    const art = await (
      await app.request(`/v1/artifacts/${shortId}`, { headers: as(owner.email) })
    ).json()
    expect(art.current_version).toBe(1)
    expect(art.open_proposals).toBe(1)
  })

  it("renders the proposed experience at its preview URL, distinct from current", async () => {
    const proposed = await app.request(`/raw/${shortId}/p/${proposalId}/index.html`, {
      headers: as(owner.email),
    })
    expect(proposed.status).toBe(200)
    expect(await proposed.text()).toContain("<h1>candidate</h1>")
    // The live content is still v1.
    const live = await app.request(`/v1/artifacts/${shortId}/content`, { headers: as(owner.email) })
    expect(await live.text()).toContain("v1 live")
  })

  it("a commenter cannot approve their own proposal", async () => {
    const res = await app.request(`/v1/artifacts/${shortId}/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: as(cassie.email),
    })
    expect(res.status).toBe(403)
  })

  it("an editor/owner approves: the proposed content becomes the new current version", async () => {
    const res = await app.request(`/v1/artifacts/${shortId}/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.state).toBe("approved")
    expect(body.published).toBe(2)

    const art = await (
      await app.request(`/v1/artifacts/${shortId}`, { headers: as(owner.email) })
    ).json()
    expect(art.current_version).toBe(2)
    expect(art.open_proposals).toBe(0)
    const live = await app.request(`/v1/artifacts/${shortId}/content`, { headers: as(owner.email) })
    expect(await live.text()).toContain("candidate")
  })

  it("approving an already-decided proposal is a conflict", async () => {
    const res = await app.request(`/v1/artifacts/${shortId}/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(res.status).toBe(409)
  })
})

describe("reviews: request changes and withdraw keep content live-unchanged", () => {
  const owner: TestUser = { id: "u_rc", email: "rc@dock.test", name: "Rc" }
  const dana: TestUser = { id: "u_dana", email: "dana@dock.test", name: "Dana" }
  const { app } = makeAuthedApp("reviews-rc", [owner, dana], "commenter")
  let shortId: string

  it("request-changes carries the reviewer's note back to the proposer, content unchanged", async () => {
    shortId = (await (await publishAs(app, "<h1>base</h1>", {}, as(owner.email))).json()).short_id
    const pid = (await (await proposeAs(app, shortId, "<h1>try</h1>", as(dana.email))).json()).id
    const res = await app.request(`/v1/artifacts/${shortId}/proposals/${pid}/request-changes`, {
      method: "POST",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ note: "Tighten the intro paragraph first" }),
    })
    expect(res.status).toBe(200)
    const decided = await res.json()
    expect(decided.state).toBe("changes_requested")
    expect(decided.decision_note).toBe("Tighten the intro paragraph first")
    const art = await (
      await app.request(`/v1/artifacts/${shortId}`, { headers: as(owner.email) })
    ).json()
    expect(art.current_version).toBe(1)
    expect(art.open_proposals).toBe(0)
    // The decided proposal still counts toward the Proposals entry (not withdrawn),
    // so the proposer can return to read the feedback.
    expect(art.proposals_total).toBe(1)
  })

  it("a proposer can withdraw their own open proposal", async () => {
    const pid = (await (await proposeAs(app, shortId, "<h1>wip</h1>", as(dana.email))).json()).id
    const res = await app.request(`/v1/artifacts/${shortId}/proposals/${pid}/withdraw`, {
      method: "POST",
      headers: as(dana.email),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).state).toBe("withdrawn")
  })

  it("an unauthenticated caller on a secured instance cannot propose", async () => {
    const res = await proposeAs(app, shortId, "<h1>nope</h1>", {})
    expect(res.status).toBe(403)
  })
})

describe("anchored comments", () => {
  it("flags comments anchored vs orphaned against the current version", async () => {
    const sid = (await (await upload("a.md", "alpha beta gamma", { title: "A" })).json()).short_id
    // anchor a comment to "beta"
    const anchor = { type: "TextQuoteSelector", exact: "beta", prefix: "alpha ", suffix: " gamma" }
    await app.request(`/v1/artifacts/${sid}/comments`, json({ body_md: "on beta", anchor }))

    let list = await (await app.request(`/v1/artifacts/${sid}/comments`)).json()
    expect(list.comments[0].anchored).toBe(true)

    // republish without "beta" → comment becomes orphaned
    const fd = new FormData()
    fd.append("file", new Blob([new TextEncoder().encode("alpha gamma delta")]), "a.md")
    fd.append("message", "v2")
    await app.request(`/v1/artifacts/${sid}/versions`, { method: "POST", body: fd })

    list = await (await app.request(`/v1/artifacts/${sid}/comments`)).json()
    expect(list.comments[0].anchored).toBe(false)
  })
})

describe("security: webhook SSRF guard", () => {
  const owner: TestUser = { id: "u_wh", email: "wh@dock.test", name: "Wh" }
  const { app } = makeAuthedApp("ssrf", [owner])
  const create = (url: string) =>
    app.request("/v1/webhooks", {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ url }),
    })

  it("rejects private, loopback, and metadata targets", async () => {
    const blocked = [
      "http://127.0.0.1/x",
      "http://localhost/x",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/hook",
      "http://192.168.1.10/hook",
      "http://[::1]/x",
      "ftp://example.com/x",
    ]
    for (const url of blocked) {
      const r = await create(url)
      expect(r.status, `should block ${url}`).toBe(400)
    }
  })

  it("accepts a public https url", async () => {
    expect((await create("https://hooks.example.com/abc")).status).toBe(201)
  })
})

describe("security: rate limiting", () => {
  const limited = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://dock.test",
    rateLimit: true,
  })

  it("429s once the auth window cap is exceeded", async () => {
    let status = 0
    for (let i = 0; i < 22; i++) {
      status = (
        await limited.request("/api/auth/get-session", {
          headers: { "x-forwarded-for": "203.0.113.7" },
        })
      ).status
    }
    expect(status).toBe(429)
  })
})

describe("@mentions + in-app notifications", () => {
  const alice: TestUser = { id: "u_m_alice", email: "ma@dock.test", name: "Alice" }
  const bob: TestUser = { id: "u_m_bob", email: "mb@dock.test", name: "Bob" }
  const { app, meta: m } = makeAuthedApp("mentions", [alice, bob], "editor")
  let shortId: string

  it("lists provisioned workspace members in the mention directory, filtered by ?q=", async () => {
    shortId = (await (await publishAs(app, "<h1>doc</h1>", {}, as(alice.email))).json()).short_id
    await app.request("/v1/me", { headers: as(bob.email) }) // provisions bob as a member
    const all = await (await app.request("/v1/users", { headers: as(alice.email) })).json()
    const ids = all.users.map((u: { id: string }) => u.id)
    expect(ids).toContain(alice.id)
    expect(ids).toContain(bob.id)

    const filtered = await (
      await app.request("/v1/users?q=bob", { headers: as(alice.email) })
    ).json()
    expect(filtered.users).toHaveLength(1)
    expect(filtered.users[0]).toMatchObject({ id: bob.id, name: "Bob", email: bob.email })
  })

  it("stores mentions on the comment and notifies the mentioned user, never the author", async () => {
    const res = await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(alice.email), {
        body_md: "hey please take a look",
        mentions: [
          { id: bob.id, name: "Bob" },
          { id: alice.id, name: "Alice" }, // self-mention must NOT notify Alice
        ],
      }),
    )
    expect(res.status).toBe(201)
    const cm = await res.json()
    expect(cm.mentions).toEqual([
      { id: bob.id, name: "Bob" },
      { id: alice.id, name: "Alice" },
    ])

    const bobN = await (await app.request("/v1/notifications", { headers: as(bob.email) })).json()
    expect(bobN.unread).toBe(1)
    expect(bobN.notifications[0]).toMatchObject({
      kind: "mention",
      actor: "Alice",
      artifact_short_id: shortId,
      thread_id: cm.thread_id,
      comment_id: cm.id,
      read: 0,
    })
    expect(bobN.notifications[0].preview).toContain("take a look")

    const aliceN = await (
      await app.request("/v1/notifications", { headers: as(alice.email) })
    ).json()
    expect(aliceN.unread).toBe(0)
  })

  it("drops mentions of unknown user ids (no junk notifications)", async () => {
    await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(alice.email), {
        body_md: "ghost ping",
        mentions: [{ id: "u_does_not_exist", name: "Ghost" }],
      }),
    )
    // Bob still has only his single earlier notification; no row for the ghost id.
    const ghost = await m.listNotifications("u_does_not_exist", 10)
    expect(ghost).toHaveLength(0)
  })

  it("marks notifications read", async () => {
    const before = await (await app.request("/v1/notifications", { headers: as(bob.email) })).json()
    expect(before.unread).toBe(1)
    const read = await app.request("/v1/notifications/read", jsonAs(as(bob.email), { all: true }))
    expect((await read.json()).unread).toBe(0)
    const after = await (await app.request("/v1/notifications", { headers: as(bob.email) })).json()
    expect(after.unread).toBe(0)
    expect(after.notifications[0].read).toBe(1)
  })

  it("requires auth for the directory and the notification feed", async () => {
    expect((await app.request("/v1/users")).status).toBe(401)
    expect((await app.request("/v1/notifications")).status).toBe(401)
    expect((await app.request("/v1/notifications/events")).status).toBe(401)
  })

  it("enqueues a comment.mention webhook carrying the notified names", async () => {
    await app.request("/v1/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json", ...as(alice.email) },
      body: JSON.stringify({
        url: "https://hooks.example.com/mention",
        events: ["comment.mention"],
      }),
    })
    await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(alice.email), { body_md: "ping again", mentions: [{ id: bob.id, name: "Bob" }] }),
    )
    const due = await m.claimDueDeliveries(new Date(Date.now() + 1000).toISOString(), 50)
    const mention = due.find((d) => d.event_type === "comment.mention")
    expect(mention).toBeTruthy()
    const payload = JSON.parse(mention?.payload ?? "{}")
    expect(payload.data.mentioned).toContain("Bob")
    expect(payload.data.author).toBe("Alice")
  })

  it("pushes a live notification event to the mentioned user's stream", async () => {
    const res = await app.request("/v1/notifications/events", { headers: as(bob.email) })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const reader = res.body?.getReader()
    if (!reader) throw new Error("no stream body")
    const dec = new TextDecoder()
    const readUntil = async (needle: string, timeoutMs = 2500) => {
      let buf = ""
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const r = await Promise.race([
          reader.read(),
          new Promise<{ value?: Uint8Array; done: boolean }>((res) =>
            setTimeout(() => res({ value: undefined, done: false }), 100),
          ),
        ])
        if (r.value) buf += dec.decode(r.value, { stream: true })
        if (buf.includes(needle)) return buf
        if (r.done) break
      }
      throw new Error(`SSE timeout waiting for "${needle}"; got:\n${buf}`)
    }
    try {
      await readUntil("event: ready")
      await app.request(
        `/v1/artifacts/${shortId}/comments`,
        jsonAs(as(alice.email), { body_md: "live ping", mentions: [{ id: bob.id, name: "Bob" }] }),
      )
      const got = await readUntil("event: notification")
      expect(got).toContain('"kind":"mention"')
      expect(got).toContain("live ping")
    } finally {
      await reader.cancel()
    }
  })
})

describe("favorites + tags (browse)", () => {
  const idOf = async (shortId: string) => {
    const a = await meta.getByShortId(shortId)
    if (!a) throw new Error(`no artifact ${shortId}`)
    return a.id
  }
  const putTags = (shortId: string, tags: string[]) =>
    app.request(`/v1/artifacts/${shortId}/tags`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags }),
    })

  it("favorites are per-user at the store layer (set, idempotent, remove)", async () => {
    const { short_id } = await (await upload("fav.md", "# Fav")).json()
    const id = await idOf(short_id)
    expect(await meta.listUserFavoriteIds("u1")).not.toContain(id)
    await meta.setFavorite(id, "u1")
    await meta.setFavorite(id, "u1") // idempotent — no duplicate row
    expect(await meta.listUserFavoriteIds("u1")).toContain(id)
    expect(await meta.listUserFavoriteIds("u2")).not.toContain(id) // personal
    await meta.removeFavorite(id, "u1")
    expect(await meta.listUserFavoriteIds("u1")).not.toContain(id)
  })

  it("normalizes tags and surfaces them on list + detail", async () => {
    const { short_id } = await (await upload("t.md", "# Tagged")).json()
    const res = await putTags(short_id, ["React", "react", "  Demo  ", ""])
    expect(res.status).toBe(200)
    expect((await res.json()).tags).toEqual(["demo", "react"]) // trimmed, lowercased, deduped, sorted

    const detail = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(detail.tags).toEqual(["demo", "react"])
    expect(detail.favorite).toBe(false)

    const list = await (await app.request("/v1/artifacts")).json()
    const row = list.artifacts.find((x: { short_id: string }) => x.short_id === short_id)
    expect(row.tags).toEqual(["demo", "react"])
    expect(row).toHaveProperty("favorite")
  })

  it("replaces the full tag set (old tags drop)", async () => {
    const { short_id } = await (await upload("r.md", "# R")).json()
    await putTags(short_id, ["one", "two"])
    expect((await (await putTags(short_id, ["three"])).json()).tags).toEqual(["three"])
    const detail = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(detail.tags).toEqual(["three"])
  })

  it("batches tags across artifacts without N+1", async () => {
    const a1 = await (await upload("b1.md", "# 1")).json()
    const a2 = await (await upload("b2.md", "# 2")).json()
    await putTags(a1.short_id, ["solo"])
    const id1 = await idOf(a1.short_id)
    const id2 = await idOf(a2.short_id)
    const map = await meta.tagsForArtifacts([id1, id2])
    expect(map[id1]).toEqual(["solo"])
    expect(map[id2]).toBeUndefined() // untagged ids simply have no entry
  })
})

describe("server-side search + cursor pagination", () => {
  const putTags = (shortId: string, tags: string[]) =>
    app.request(`/v1/artifacts/${shortId}/tags`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags }),
    })

  it("searches by title server-side, case-insensitive", async () => {
    await upload("s1.md", "x", { title: "Quarterly ZZUNIQUE Report" })
    await upload("s2.md", "x", { title: "Totally unrelated" })
    const r = await (await app.request("/v1/artifacts?q=zzunique")).json()
    const titles = r.artifacts.map((a: { title: string | null }) => a.title)
    expect(titles).toContain("Quarterly ZZUNIQUE Report")
    expect(titles.every((t: string | null) => /zzunique/i.test(t ?? ""))).toBe(true)
  })

  it("paginates newest-first with a keyset cursor (no overlap)", async () => {
    for (const n of ["A", "B", "C"]) await upload(`pg${n}.md`, "x", { title: `PGSEED ${n}` })
    const p1 = await (await app.request("/v1/artifacts?q=PGSEED&limit=2")).json()
    expect(p1.artifacts).toHaveLength(2)
    expect(typeof p1.next_cursor).toBe("string")
    const p2 = await (
      await app.request(
        `/v1/artifacts?q=PGSEED&limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`,
      )
    ).json()
    expect(p2.artifacts).toHaveLength(1)
    expect(p2.next_cursor).toBeNull()
    const seen = new Set(p1.artifacts.map((a: { short_id: string }) => a.short_id))
    expect(p2.artifacts.some((a: { short_id: string }) => seen.has(a.short_id))).toBe(false)
  })

  it("filters by ?tag= server-side", async () => {
    const { short_id } = await (await upload("tg.md", "x", { title: "Tagged one" })).json()
    await putTags(short_id, ["serverfilter"])
    const r = await (await app.request("/v1/artifacts?tag=serverfilter")).json()
    expect(r.artifacts.map((a: { short_id: string }) => a.short_id)).toEqual([short_id])
  })

  it("GET /v1/tags returns a browse summary (total, favorites, tag counts)", async () => {
    const { short_id } = await (await upload("sum.md", "x", { title: "Summary doc" })).json()
    await putTags(short_id, ["summaryfilter"])
    const r = await (await app.request("/v1/tags")).json()
    expect(typeof r.total).toBe("number")
    expect(r.total).toBeGreaterThan(0)
    expect(r.favorites).toBe(0) // anonymous in tests
    expect(r.tags.find((t: { tag: string }) => t.tag === "summaryfilter")?.count).toBe(1)
  })
})
