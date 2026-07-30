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
