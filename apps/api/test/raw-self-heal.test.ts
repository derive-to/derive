import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId } from "@dock/core"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"

const dir = mkdtempSync(join(tmpdir(), "dock-rawheal-"))
const meta = new SqliteMetaStore(join(dir, "r.db"))
const blobs = new FsBlobStore(join(dir, "blobs"))
const app = createApp({ meta, blobs, baseUrl: "http://dock.test", token: "tok" })
const enc = (s: string) => new TextEncoder().encode(s)
// A full HTML document with a <style> head — the markdown renderer would strip the
// head/style and emit a blank body (the white screen). The bytes lie under a
// text/markdown label (the pre-sniff sync bug).
const HTML_DOC =
  "<!doctype html>\n<html><head><style>h1{color:red}</style></head><body><h1>Live Report</h1></body></html>"

afterAll(() => {
  meta.close()
  rmSync(dir, { recursive: true, force: true })
})

const seedMislabeled = async (shortId: string) => {
  const key = await blobs.put(enc(HTML_DOC))
  const a = await meta.createArtifact({
    id: newId("a"),
    short_id: shortId,
    org_id: "default",
    slug: null,
    title: "Frozen Bench",
    visibility: "public",
    kind: "file",
    spa: 0,
  })
  await meta.addVersion(a.id, {
    id: newId("v"),
    blob_key: key,
    content_type: "text/markdown",
    size_bytes: HTML_DOC.length,
    author: "t",
    message: null,
  })
  return a
}

describe("raw render never white-screens + self-heals a mislabeled blob", () => {
  it("serves the HTML verbatim (not markdown-stripped) when a markdown-typed version is HTML", async () => {
    await seedMislabeled("htmlmd1")
    const res = await app.request("/raw/htmlmd1/v/1/index.html")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("<h1>Live Report</h1>")
    // The <style> survived → it was passed through, not run through the markdown
    // renderer (which would have dropped the head). This is the no-white-screen backstop.
    expect(body).toContain("color:red")
  })

  it("self-heals the stored content_type on view, so repairs always happen", async () => {
    const a = await seedMislabeled("htmlmd2")
    expect((await meta.getByShortId("htmlmd2"))?.current_content_type).toBe("text/markdown")
    await app.request("/raw/htmlmd2/v/1/index.html")
    // background() awaits inline off the edge (and better-sqlite3 writes are sync), so
    // the reclassify has landed by the time the request resolves.
    expect((await meta.getByShortId("htmlmd2"))?.current_content_type).toBe("text/html")
    expect((await meta.getVersion(a.id, 1))?.content_type).toBe("text/html")
  })

  it("leaves genuine markdown on the markdown render path, untouched", async () => {
    const key = await blobs.put(enc("# Hello\n\nReal markdown body."))
    const a = await meta.createArtifact({
      id: newId("a"),
      short_id: "realmd",
      org_id: "default",
      slug: null,
      title: "Notes",
      visibility: "public",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(a.id, {
      id: newId("v"),
      blob_key: key,
      content_type: "text/markdown",
      size_bytes: 26,
      author: "t",
      message: null,
    })
    const res = await app.request("/raw/realmd/v/1/index.html")
    const body = await res.text()
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(body).toContain("<h1") // rendered markdown → html
    expect((await meta.getByShortId("realmd"))?.current_content_type).toBe("text/markdown") // untouched
  })
})
