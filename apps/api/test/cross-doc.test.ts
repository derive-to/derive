import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId } from "@dock/core"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"

const dir = mkdtempSync(join(tmpdir(), "dock-crossdoc-"))
const meta = new SqliteMetaStore(join(dir, "c.db"))
const blobs = new FsBlobStore(join(dir, "blobs"))
const app = createApp({ meta, blobs, baseUrl: "http://dock.test", token: "tok" })
const enc = (s: string) => new TextEncoder().encode(s)

afterAll(() => {
  meta.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A synced HTML file artifact: published, version 1, with an optional repo path. */
const seedHtml = async (opts: {
  shortId: string
  slug: string | null
  html: string
  sourcePath?: string
}) => {
  const key = await blobs.put(enc(opts.html))
  const a = await meta.createArtifact({
    id: newId("a"),
    short_id: opts.shortId,
    org_id: "default",
    slug: opts.slug,
    title: opts.shortId,
    visibility: "public",
    kind: "file",
    spa: 0,
  })
  await meta.addVersion(a.id, {
    id: newId("v"),
    blob_key: key,
    content_type: "text/html",
    size_bytes: opts.html.length,
    author: "t",
    message: null,
  })
  if (opts.sourcePath) await meta.setArtifactSourcePath(a.id, opts.sourcePath)
  return a
}

const PRODUCT = `<!doctype html><html><body>
<a href="walkthrough.html">Walkthrough</a>
<a href="missing.html">Missing</a>
<a href="https://fonts.googleapis.com">Font</a>
<a href="#top">Top</a>
</body></html>`

describe("cross-document links between synced sibling artifacts", () => {
  it("rewrites a relative link that resolves to a sibling into an in-app navigation", async () => {
    await seedHtml({
      shortId: "cdwalk1",
      slug: "ct-walkthrough",
      html: "<html><body><h1>Walkthrough</h1></body></html>",
      sourcePath: "docs/plans/ct/walkthrough.html",
    })
    await seedHtml({
      shortId: "cdprod1",
      slug: "ct-product",
      html: PRODUCT,
      sourcePath: "docs/plans/ct/product.html",
    })

    const body = await (await app.request("/raw/cdprod1/v/1/index.html")).text()

    // The sibling link → its canonical /a/<slug>-<short_id> URL + the interception marker.
    expect(body).toContain('href="/a/ct-walkthrough-cdwalk1"')
    expect(body).toContain('data-dock-nav="ct-walkthrough-cdwalk1"')
    // A link with no sibling, an external link, and an in-page anchor are left as-is.
    expect(body).toContain('href="missing.html"')
    expect(body).toContain('href="https://fonts.googleapis.com"')
    expect(body).toContain('href="#top"')
    expect(body).not.toContain('data-dock-nav="ct-product') // never self-links
  })

  it("leaves relative links untouched for a non-synced artifact (no source_path)", async () => {
    await seedHtml({ shortId: "cdnone1", slug: "loose", html: PRODUCT }) // no sourcePath
    const body = await (await app.request("/raw/cdnone1/v/1/index.html")).text()
    expect(body).toContain('href="walkthrough.html"')
    expect(body).not.toContain("data-dock-nav")
  })

  it("does not resolve across workspaces — a same-path sibling in another org is invisible", async () => {
    const key = await blobs.put(enc("<html><body>other-org walkthrough</body></html>"))
    const other = await meta.createArtifact({
      id: newId("a"),
      short_id: "cdother1",
      org_id: "other-org",
      slug: "other-walk",
      title: "other",
      visibility: "public",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(other.id, {
      id: newId("v"),
      blob_key: key,
      content_type: "text/html",
      size_bytes: 10,
      author: "t",
      message: null,
    })
    // Same repo path as cdprod1's sibling, but a different org.
    await meta.setArtifactSourcePath(other.id, "docs/plans/other/walkthrough.html")

    await seedHtml({
      shortId: "cdprod2",
      slug: "ct2-product",
      html: `<html><body><a href="walkthrough.html">W</a></body></html>`,
      sourcePath: "docs/plans/other/product.html", // org "default", not "other-org"
    })
    const body = await (await app.request("/raw/cdprod2/v/1/index.html")).text()
    expect(body).toContain('href="walkthrough.html"') // unresolved — cross-org match ignored
    expect(body).not.toContain("data-dock-nav")
  })
})
