import { join } from "node:path"
import { FsBlobStore } from "@dock/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import {
  app,
  as,
  dir,
  json,
  jsonAs,
  makeAuthedApp,
  meta,
  publishAs,
  type TestUser,
  upload,
} from "./helpers"

describe("view analytics", () => {
  it("de-dups rapid re-opens and aggregates uniques, per-version, recent viewers", async () => {
    const { short_id } = await (await upload("a.md", "# A")).json()
    await upload("a.md", "# A v2", { message: "v2" }, short_id) // now at v2

    // Three rapid opens from one anonymous viewer (cookie reused) collapse to ONE
    // recorded view — a refresh no longer inflates the count.
    let cookie = ""
    for (let i = 0; i < 3; i++) {
      const r = await app.request(`/v1/artifacts/${short_id}/view`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ version: 1 }),
      })
      cookie ||= (r.headers.get("set-cookie") ?? "").split(";")[0]
    }
    // The same viewer on a different version is a distinct view.
    await app.request(`/v1/artifacts/${short_id}/view`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ version: 2 }),
    })
    // A fresh anonymous viewer (no cookie) is a distinct unique.
    await app.request(`/v1/artifacts/${short_id}/view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 2 }),
    })

    const a = await (await app.request(`/v1/artifacts/${short_id}/analytics`)).json()
    expect(a.total).toBe(3) // viewerA@v1 (de-duped from 3), viewerA@v2, viewerB@v2
    expect(a.unique).toBe(2) // two distinct anon cookies
    expect(a.perVersion).toEqual([
      { version: 1, count: 1 },
      { version: 2, count: 2 },
    ])
    expect(a.daily.reduce((s: number, d: { count: number }) => s + d.count, 0)).toBe(3)
    expect(a.recent.length).toBe(2) // per-viewer, newest-first
    expect(a.recent.every((r: { kind: string }) => r.kind === "anon")).toBe(true)

    // Batch counts surface on the library listing.
    const list = await (await app.request("/v1/artifacts")).json()
    const row = list.artifacts.find((x: { short_id: string }) => x.short_id === short_id)
    expect(row.views).toBe(3)
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

describe("analytics: identity + retention", () => {
  const ann: TestUser = { id: "u_view_ann", email: "ann@dock.test", name: "Ann" }
  const bob: TestUser = {
    id: "u_view_bob",
    email: "bob@dock.test",
    name: "Bob",
    image: "https://cdn.dock.test/bob.png",
  }
  const { app, meta: m } = makeAuthedApp("analytics-id", [ann, bob], "commenter")

  it("excludes the owner's own opens; counts a viewer (by name + avatar) and anon", async () => {
    const sid = (await (await publishAs(app, "<h1>v</h1>", {}, as(ann.email))).json()).short_id
    // Ann is the workspace owner (first member). Her own opens don't count.
    for (let i = 0; i < 2; i++)
      await app.request(`/v1/artifacts/${sid}/view`, jsonAs(as(ann.email), { version: 1 }))
    // Bob is a commenter (audience); his two opens collapse to one counted view.
    for (let i = 0; i < 2; i++)
      await app.request(`/v1/artifacts/${sid}/view`, jsonAs(as(bob.email), { version: 1 }))
    // An anonymous open also counts.
    await app.request(`/v1/artifacts/${sid}/view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    })
    const a = await (
      await app.request(`/v1/artifacts/${sid}/analytics`, { headers: as(ann.email) })
    ).json()
    expect(a.total).toBe(2) // Bob (de-duped) + anon; Ann excluded
    expect(a.unique).toBe(2)
    expect(a.anonViewers).toBe(1)
    const named = a.recent.filter((r: { kind: string }) => r.kind === "user")
    expect(named).toHaveLength(1)
    expect(named[0]).toMatchObject({ viewer: "Bob", avatar: bob.image }) // name + profile pic
    expect(a.recent.some((r: { viewer: string }) => r.viewer === "Ann")).toBe(false)
  })

  it("prunes view rows older than the cutoff, keeps newer ones", async () => {
    const sid = (await (await publishAs(app, "<h1>p</h1>", {}, as(ann.email))).json()).short_id
    const art = await m.getByShortId(sid)
    if (!art) throw new Error("no artifact")
    await m.recordView({
      id: "v_old",
      artifact_id: art.id,
      version: 1,
      viewer: "anon_p",
      viewer_kind: "anon",
    })
    expect((await m.viewStats(art.id)).total).toBe(1)
    expect(await m.pruneViews(new Date(Date.now() - 86400_000).toISOString())).toBe(0) // none that old
    expect((await m.viewStats(art.id)).total).toBe(1) // kept
    expect(await m.pruneViews(new Date(Date.now() + 86400_000).toISOString())).toBeGreaterThan(0)
    expect((await m.viewStats(art.id)).total).toBe(0) // pruned
  })

  it("pruneViewsByViewers removes only the listed user-kind rows", async () => {
    const sid = (await (await publishAs(app, "<h1>pv</h1>", {}, as(ann.email))).json()).short_id
    const art = await m.getByShortId(sid)
    if (!art) throw new Error("no artifact")
    const v = (id: string, viewer: string, kind: "user" | "anon") =>
      m.recordView({ id, artifact_id: art.id, version: 1, viewer, viewer_kind: kind })
    await v("v_keep", "u_keep", "user")
    await v("v_drop", "u_drop", "user")
    await v("v_anon", "u_drop", "anon") // same string but anon-kind → must be kept
    expect(await m.pruneViewsByViewers(["u_drop"])).toBe(1) // only the user-kind row
    expect((await m.viewStats(art.id)).total).toBe(2) // u_keep + the anon row remain
  })

  it("the anonymous-viewer cookie is cross-site-safe when the SPA is split", async () => {
    const xs = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, "blobs")),
      baseUrl: "https://api.dock.test",
      crossSite: true,
    })
    const fd = new FormData()
    fd.append("file", new Blob([new TextEncoder().encode("# x")]), "x.md")
    const { short_id } = await (
      await xs.request("/v1/artifacts", { method: "POST", body: fd })
    ).json()
    const r = await xs.request(`/v1/artifacts/${short_id}/view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    const sc = (r.headers.get("set-cookie") ?? "").toLowerCase()
    expect(sc).toContain("dock_vid=")
    expect(sc).toContain("samesite=none") // rides the cross-site request
    expect(sc).toContain("secure")
  })
})
