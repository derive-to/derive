import { join } from "node:path"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { app, dir, meta, postJson, upload } from "./helpers"

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

  it("serves artifact metadata and sandboxed raw content", async () => {
    // The viewer at /a/:ref is the SPA (client-rendered); the server exposes the
    // artifact's metadata over the data API and the bytes over the sandboxed /raw.
    const detail = await app.request(`/v1/artifacts/${shortId}`)
    expect(detail.status).toBe(200)
    expect((await detail.json()).title).toBe("Q1 Review")

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
    const bad = await upload("dist.zip", zipSync({}))
    expect(bad.status).toBe(400)
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

describe("single-container web serving", () => {
  it("serves the API landing at / by default", async () => {
    const r = await app.request("/")
    expect(r.status).toBe(200)
    expect(await r.text()).toContain("open home for AI-generated artifacts")
  })

  it("drops the / placeholder when serveWeb is set, so the bundled SPA owns the shell", async () => {
    const webApp = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, "blobs")),
      baseUrl: "http://dock.test",
      serveWeb: true,
    })
    // No placeholder here; the Node entry's static + index.html fallback (added
    // around createApp when a build is present) is what answers `/` in prod.
    expect((await webApp.request("/")).status).toBe(404)
  })
})
