import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zipSync } from "fflate"
import { afterAll, describe, expect, it } from "vitest"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { createApp } from "../src/app"

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

const upload = (name: string, content: Uint8Array | string, fields: Record<string, string> = {}, shortId?: string) => {
  const form = new FormData()
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
  form.append("file", new Blob([bytes as BlobPart]), name)
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const url = shortId ? `/v1/artifacts/${shortId}/versions` : "/v1/artifacts"
  return app.request(url, { method: "POST", body: form })
}

describe("publish html file", () => {
  let shortId: string

  it("publishes and returns a stable url", async () => {
    const res = await upload("q1-review.html", "<h1>Q1 Review</h1><script>document.title='hi'</script>", {
      title: "Q1 Review",
    })
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
    const res = await upload("q1-review.html", "<h1>Q1 Review v2</h1>", { message: "address review" }, shortId)
    expect(res.status).toBe(201)
    expect((await res.json()).current_version).toBe(2)

    expect(await (await app.request(`/raw/${shortId}/v/1/index.html`)).text()).toContain("Q1 Review</h1>")
    expect(await (await app.request(`/raw/${shortId}/v/2/index.html`)).text()).toContain("Q1 Review v2")

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
    shortId = (await (await upload("c.md", "# doc with mean sentiment", { title: "C" })).json()).short_id
    const res = await app.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "use median", author: "jess", anchor: { type: "TextQuoteSelector", exact: "mean" } }),
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
      await app.request(`/v1/artifacts/${shortId}/comments`, json({ body_md: "agreed", thread_id: threadId }))
    ).json()
    expect(cm.thread_id).toBe(threadId)
    const list = await (await app.request(`/v1/artifacts/${shortId}/comments`)).json()
    expect(list.comments).toHaveLength(2)
  })

  it("resolves and reopens a thread, with state filtering", async () => {
    await app.request(`/v1/artifacts/${shortId}/comments/${rootId}/resolve`, { method: "POST" })
    expect((await (await app.request(`/v1/artifacts/${shortId}/comments?state=open`)).json()).comments).toHaveLength(0)
    expect((await (await app.request(`/v1/artifacts/${shortId}/comments?state=resolved`)).json()).comments).toHaveLength(2)

    await app.request(`/v1/artifacts/${shortId}/comments/${rootId}/resolve`, json({ state: "open" }))
    expect((await (await app.request(`/v1/artifacts/${shortId}/comments?state=open`)).json()).comments).toHaveLength(2)
  })

  it("resolves threads on republish via the resolves field", async () => {
    const sid = (await (await upload("r.md", "# r", {})).json()).short_id
    const cm = await (await app.request(`/v1/artifacts/${sid}/comments`, json({ body_md: "fix this" }))).json()

    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("# r2")]), "r.md")
    form.append("message", "address review")
    form.append("resolves", cm.id)
    await app.request(`/v1/artifacts/${sid}/versions`, { method: "POST", body: form })

    expect((await (await app.request(`/v1/artifacts/${sid}/comments?state=open`)).json()).comments).toHaveLength(0)
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
    expect((await pub("link")).status).toBe(401)
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
