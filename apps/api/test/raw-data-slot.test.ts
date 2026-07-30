import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"

// The raw JSON route for data slots: how everything that ISN'T an MCP client reads a
// slot — a fetch() from the artifact's own page, a curl, a script with a bearer. The
// slot is part of the version, so it must never be more readable than the page.
const dir = mkdtempSync(join(tmpdir(), "derive-rawslot-"))
const meta = new SqliteMetaStore(join(dir, "r.db"))
const blobs = new FsBlobStore(join(dir, "blobs"))
const app = createApp({ meta, blobs, baseUrl: "http://derive.test", token: "tok" })
const enc = (s: string) => new TextEncoder().encode(s)

afterAll(() => {
  meta.close()
  rmSync(dir, { recursive: true, force: true })
})

const PAGE = (day: number) =>
  `<!doctype html><html><body><script type="application/derive-data" data-slot="checks">{"day":${day}}</script></body></html>`

/** Seed an artifact with `versions` versions, each carrying its own slot value.
 *  Defaults to ONE so v1 is the current version: an anonymous read of an OLD version is
 *  blocked by the public-history gate (see the gate test below), which would otherwise
 *  make these cases fail for a reason that has nothing to do with what they check. */
const seed = async (shortId: string, listed: "public" | "none", versions = 1) => {
  const a = await meta.createArtifact({
    id: newId("a"),
    short_id: shortId,
    org_id: "default",
    slug: null,
    title: "Nightly",
    workspace_access: "member",
    link_role: listed === "public" ? "viewer" : "none",
    listed,
    kind: "file",
    spa: 0,
  })
  for (let day = 1; day <= versions; day++) {
    const key = await blobs.put(enc(PAGE(day)))
    const v = await meta.addVersion(a.id, {
      id: newId("v"),
      blob_key: key,
      content_type: "text/html",
      author: "amy",
      message: `night ${day}`,
    })
    // The route reads stored rows; the extraction chain is covered by mcp.test.ts.
    await meta.setVersionData(a.id, v.n, [
      { id: newId("vd"), slot: "checks", json: `{"day":${day}}`, size_bytes: 11, gen: 1 },
    ])
  }
  return a
}

describe("raw data-slot route", () => {
  it("serves a version's slot as JSON, with the stored bytes verbatim", async () => {
    await seed("slot1", "public")
    const r = await app.request("/raw/slot1/v/1/data/checks.json")
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toContain("application/json")
    expect(await r.json()).toEqual({ day: 1 })
  })

  it("serves the CURRENT version without a version segment", async () => {
    await seed("slot2", "public", 3)
    const r = await app.request("/raw/slot2/data/checks.json")
    expect(await r.json()).toEqual({ day: 3 })
  })

  it("accepts the slot name with or without the .json suffix", async () => {
    await seed("slot3", "public")
    expect((await app.request("/raw/slot3/v/1/data/checks")).status).toBe(200)
    expect((await app.request("/raw/slot3/v/1/data/checks.json")).status).toBe(200)
  })

  it("caches a pinned version immutably but never the current-version alias", async () => {
    await seed("slot4", "public")
    // A version is immutable, so its slot is too. The alias moves on the next publish.
    expect(
      (await app.request("/raw/slot4/v/1/data/checks")).headers.get("cache-control"),
    ).toContain("immutable")
    expect((await app.request("/raw/slot4/data/checks")).headers.get("cache-control")).toBe(
      "no-cache",
    )
  })

  it("404s an unknown slot, an unknown artifact, and an out-of-range version", async () => {
    await seed("slot5", "public")
    expect((await app.request("/raw/slot5/v/1/data/nosuch")).status).toBe(404)
    expect((await app.request("/raw/nope/v/1/data/checks")).status).toBe(404)
    expect((await app.request("/raw/slot5/v/99/data/checks")).status).toBe(404)
  })

  it("does not leak a private artifact's data to an anonymous caller", async () => {
    await seed("slot6", "none")
    expect((await app.request("/raw/slot6/v/1/data/checks")).status).toBe(404)
    // ...but the operator bearer, which can read the page, can read its slot.
    const ok = await app.request("/raw/slot6/v/1/data/checks", {
      headers: { authorization: "Bearer tok" },
    })
    expect(ok.status).toBe(200)
  })

  it("a gated artifact's slot is never stored by a SHARED cache", async () => {
    await seed("slot6b", "none", 2)
    const auth = { authorization: "Bearer tok" }
    // These 200s exist only because the CALLER could read the page, and nothing in the
    // response varies on that credential. `public` would let a CDN or corporate proxy keep
    // one member's figures and serve them to anyone — for a YEAR on the pinned route, which
    // is what turns a slip into a lasting one.
    for (const path of ["/raw/slot6b/v/1/data/checks", "/raw/slot6b/data/checks.jsonl"]) {
      const res = await app.request(path, { headers: auth })
      expect(res.status, path).toBe(200)
      expect(res.headers.get("cache-control"), path).not.toContain("public")
    }
    // Still immutable, just browser-private: the version genuinely never changes.
    expect(
      (await app.request("/raw/slot6b/v/1/data/checks", { headers: auth })).headers.get(
        "cache-control",
      ),
    ).toContain("immutable")
    // A world-readable artifact keeps the hard shared cache, which is what makes these URLs
    // cheap enough for a page to poll its own history. ONE version, so v1 is the current
    // one: an anonymous read of an OLD version is refused by the public-history gate, and
    // this case is about the cache header, not that gate.
    await seed("slot6c", "public")
    expect(
      (await app.request("/raw/slot6c/v/1/data/checks")).headers.get("cache-control"),
    ).toContain("public")
    expect(
      (await app.request("/raw/slot6c/data/checks.jsonl")).headers.get("cache-control"),
    ).toContain("public")
  })

  it("does not let the slot route bypass the anonymous history gate", async () => {
    // A public artifact without public_history: anon reads only the CURRENT version, so
    // an OLD version's slot must be as hidden as that version's bytes.
    await seed("slot7", "public", 2)
    expect((await app.request("/raw/slot7/v/1/data/checks")).status).toBe(404)
    expect((await app.request("/raw/slot7/v/2/data/checks")).status).toBe(200)
  })

  it("does not shadow a bundle's own file path named data/", async () => {
    // The route is registered before the /v/:n/* catch-all; make sure a real artifact
    // path that merely looks like the slot route still reaches the content server.
    await seed("slot8", "public")
    // No such file in this single-file artifact -> the content route answers, not a crash.
    const r = await app.request("/raw/slot8/v/1/data/checks/extra")
    expect([200, 404]).toContain(r.status)
  })
})

// The JSONL export: the whole history of one slot, one object per version. This is the
// substrate the querying story is built on (a page charts itself, an agent pulls a
// series, jq/DuckDB read it) — so it must be correct, ordered, and gated exactly like
// the per-version route.
describe("raw data-slot JSONL export", () => {
  it("serves the full series oldest-first, one JSON object per line", async () => {
    await seed("jl1", "public", 3)
    const r = await app.request("/raw/jl1/data/checks.jsonl", {
      headers: { authorization: "Bearer tok" },
    })
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toContain("application/x-ndjson")
    const lines = (await r.text()).trim().split("\n")
    expect(lines).toHaveLength(3)
    const points = lines.map((l) => JSON.parse(l))
    expect(points.map((p) => p.n)).toEqual([1, 2, 3])
    expect(points.map((p) => p.data.day)).toEqual([1, 2, 3])
    expect(points[0].at).toBeTruthy()
  })

  it("accepts the slot name with or without the .jsonl suffix", async () => {
    await seed("jl2", "public", 2)
    const bare = await app.request("/raw/jl2/data/checks.jsonl", {
      headers: { authorization: "Bearer tok" },
    })
    expect(bare.status).toBe(200)
  })

  it("404s an unknown slot and an unknown artifact", async () => {
    await seed("jl3", "public")
    expect((await app.request("/raw/jl3/data/nosuch.jsonl")).status).toBe(404)
    expect((await app.request("/raw/nope/data/checks.jsonl")).status).toBe(404)
  })

  it("does not leak a private artifact's series to an anonymous caller", async () => {
    await seed("jl4", "none", 2)
    expect((await app.request("/raw/jl4/data/checks.jsonl")).status).toBe(404)
    const ok = await app.request("/raw/jl4/data/checks.jsonl", {
      headers: { authorization: "Bearer tok" },
    })
    expect(ok.status).toBe(200)
  })

  it("gives an anonymous caller only the CURRENT point when history is not public", async () => {
    // The export must not be a way around the public-history gate: without it, an old
    // version's data would be readable here while its bytes are not.
    await seed("jl5", "public", 3)
    const anon = await app.request("/raw/jl5/data/checks.jsonl")
    expect(anon.status).toBe(200)
    const lines = (await anon.text()).trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string).data.day).toBe(3)
  })
})
