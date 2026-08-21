import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  newId,
  SKILL_CONTENT_TYPE,
} from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import type { Context } from "hono"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createApp } from "../src/app"
import { RAW_HEADERS } from "../src/lib/http"
import { serveContent } from "../src/lib/serve-content"

const enc = (s: string) => new TextEncoder().encode(s)

// Fake BlobStore — serveContent only ever calls get().
const blobStore = (entries: Record<string, Uint8Array | string>): BlobStore => {
  const map = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(entries)) map.set(k, typeof v === "string" ? enc(v) : v)
  return { get: async (key: string) => map.get(key) ?? null } as unknown as BlobStore
}

// Minimal Hono context: serveContent calls c.body / c.text (each yielding a Response)
// and c.req.query (the `?raw=1` markdown-source escape). `query` defaults to empty.
const ctx = (query: Record<string, string> = {}): Context =>
  ({
    req: { query: (k: string) => query[k] },
    body: (data: BodyInit | null, status = 200, headers?: Record<string, string>) =>
      new Response(data, { status, headers }),
    text: (msg: string, status = 200, headers?: Record<string, string>) =>
      new Response(msg, { status, headers: headers ?? {} }),
  }) as unknown as Context

const CSP = RAW_HEADERS["Content-Security-Policy"]
const IMMUTABLE = "public, max-age=31536000, immutable"

// The opaque-origin sandbox headers must ride EVERY response serveContent produces.
const expectSandbox = (res: Response, cache: string = IMMUTABLE) => {
  expect(res.headers.get("content-security-policy")).toBe(CSP)
  expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  expect(res.headers.get("x-robots-tag")).toBe("noindex")
  expect(res.headers.get("cache-control")).toBe(cache)
}

const SCRIPT = "/raw/derive-client.js" // the appended anchor client (SELECTION_SCRIPT)

describe("serveContent — single-file artifacts", () => {
  it("serves an HTML file with the anchor client and the sandbox headers", async () => {
    const res = await serveContent(
      ctx(),
      blobStore({ k: "<h1>Hi</h1>" }),
      { blob_key: "k", content_type: "text/html" },
      "Title",
      "/",
      "",
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("<h1>Hi</h1>")
    expect(body).toContain(SCRIPT)
    expectSandbox(res)
  })

  it("renders markdown to HTML", async () => {
    const res = await serveContent(
      ctx(),
      blobStore({ k: "# Hello" }),
      { blob_key: "k", content_type: "text/markdown" },
      "Doc",
      "/",
      "",
    )
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("<h1")
    expect(body).toContain(SCRIPT)
  })

  it("self-heals a blob mislabeled markdown that is actually a full HTML document", async () => {
    const onMismatch = vi.fn()
    const html =
      "<!DOCTYPE html><html><head><style>b{}</style></head><body>real content</body></html>"
    const res = await serveContent(
      ctx(),
      blobStore({ k: html }),
      { blob_key: "k", content_type: "text/markdown" },
      null,
      "/",
      "",
      IMMUTABLE,
      onMismatch,
    )
    expect(onMismatch).toHaveBeenCalledOnce()
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    // Served verbatim (the <style> survives — the markdown path would have stripped it),
    // never the blank page.
    expect(body).toContain("<style>b{}</style>")
    expect(body).toContain("real content")
    expect(body).toContain(SCRIPT)
  })

  it("uses the gated Cache-Control for a non-public artifact (never immutable)", async () => {
    const res = await serveContent(
      ctx(),
      blobStore({ k: "<h1>x</h1>" }),
      { blob_key: "k", content_type: "text/html" },
      null,
      "/",
      "",
      "private, no-store",
    )
    expectSandbox(res, "private, no-store")
  })
})

describe("serveContent — bundles", () => {
  const manifest: BundleManifest = {
    entry: "/index.html",
    spa: false,
    files: {
      "/index.html": { key: "k_idx", type: "text/html; charset=utf-8" },
      "/style.css": { key: "k_css", type: "text/css; charset=utf-8" },
      "/img.png": { key: "k_img", type: "image/png" },
    },
  }
  const prefix = "/raw/abc/v/1/"
  const bundleBlobs = (over: Partial<Record<string, Uint8Array | string>> = {}) =>
    blobStore({
      kManifest: JSON.stringify(manifest),
      k_idx: '<a href="/deep">home</a>',
      k_css: "a{color:red}",
      k_img: Uint8Array.from([1, 2, 3, 4]),
      ...over,
    })
  const content = { blob_key: "kManifest", content_type: BUNDLE_CONTENT_TYPE }

  it("serves the entry page: scope-rewritten links + the anchor client", async () => {
    const res = await serveContent(ctx(), bundleBlobs(), content, "Site", prefix, "")
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain('href="/raw/abc/v/1/deep"') // root-absolute link kept in scope
    expect(body).toContain(SCRIPT)
    expectSandbox(res)
  })

  it("serves a CSS page rewritten but WITHOUT the anchor client", async () => {
    const res = await serveContent(ctx(), bundleBlobs(), content, "Site", prefix, "style.css")
    expect(res.headers.get("content-type")).toContain("text/css")
    const body = await res.text()
    expect(body).toBe("a{color:red}")
    expect(body).not.toContain(SCRIPT)
  })

  it("404s an unknown bundle path, still with the sandbox headers", async () => {
    const res = await serveContent(ctx(), bundleBlobs(), content, "Site", prefix, "nope.html")
    expect(res.status).toBe(404)
    expect(res.headers.get("content-security-policy")).toBe(CSP)
  })

  it("falls back to the entry page for an SPA route with no matching file", async () => {
    const spaManifest: BundleManifest = { ...manifest, spa: true }
    const res = await serveContent(
      ctx(),
      bundleBlobs({ kManifest: JSON.stringify(spaManifest) }),
      content,
      "Site",
      prefix,
      "app/some/route",
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain("home") // the entry document
  })
})

describe("serveContent — skill / markdown bundles", () => {
  // A skill folder: entry is SKILL.md, plus a script (served raw) and a reference doc.
  const manifest: BundleManifest = {
    entry: "/SKILL.md",
    spa: false,
    files: {
      "/SKILL.md": { key: "k_skill", type: "text/markdown; charset=utf-8" },
      "/scripts/run.sh": { key: "k_sh", type: "application/octet-stream" },
    },
  }
  const prefix = "/raw/sk/v/1/"
  const skillMd = "---\nname: my-skill\ndescription: does things\n---\n\n# My Skill\n\nbody text"
  const blobs = blobStore({
    kManifest: JSON.stringify(manifest),
    k_skill: skillMd,
    k_sh: "#!/usr/bin/env bash\necho hi\n",
  })
  // A real skill carries the derive/skill content type; serveContent must still treat
  // it as a bundle (isBundleContentType), not fall through to single-file handling.
  const content = { blob_key: "kManifest", content_type: SKILL_CONTENT_TYPE }

  it("renders the SKILL.md entry as HTML, frontmatter stripped, with the anchor client", async () => {
    const res = await serveContent(ctx(), blobs, content, "my-skill", prefix, "")
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("<h1") // the body heading rendered
    expect(body).toContain("My Skill")
    expect(body).not.toContain("name: my-skill") // frontmatter stripped, not shown
    expect(body).toContain(SCRIPT)
    expectSandbox(res)
  })

  it("serves the markdown source verbatim with ?raw=1", async () => {
    const res = await serveContent(
      ctx({ raw: "1" }),
      blobs,
      content,
      "my-skill",
      prefix,
      "SKILL.md",
    )
    expect(res.headers.get("content-type")).toContain("text/markdown")
    expect(await res.text()).toBe(skillMd)
  })
})

// Sibling-link rewriting is a /raw serve-time transform: a relative link in a synced HTML
// artifact that resolves to a sibling (same repo directory, same workspace) becomes an
// in-app navigation. Exercised through the real route on its own store + app.
describe("cross-document links between synced sibling artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-crossdoc-"))
  const meta = new SqliteMetaStore(join(dir, "c.db"))
  const blobs = new FsBlobStore(join(dir, "blobs"))
  const app = createApp({ meta, blobs, baseUrl: "http://derive.test", token: "tok" })

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
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
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

    // The sibling link → its canonical /artifacts/<slug>-<short_id> URL + the interception marker.
    expect(body).toContain('href="/artifacts/ct-walkthrough-cdwalk1"')
    expect(body).toContain('data-derive-nav="ct-walkthrough-cdwalk1"')
    // A link with no sibling, an external link, and an in-page anchor are left as-is.
    expect(body).toContain('href="missing.html"')
    expect(body).toContain('href="https://fonts.googleapis.com"')
    expect(body).toContain('href="#top"')
    expect(body).not.toContain('data-derive-nav="ct-product') // never self-links
  })

  it("does not resolve across workspaces — a same-path sibling in another org is invisible", async () => {
    const key = await blobs.put(enc("<html><body>other-org walkthrough</body></html>"))
    const other = await meta.createArtifact({
      id: newId("a"),
      short_id: "cdother1",
      org_id: "other-org",
      slug: "other-walk",
      title: "other",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
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
    expect(body).not.toContain("data-derive-nav")
  })
})
