import {
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  SKILL_CONTENT_TYPE,
} from "@derive/core"
import type { Context } from "hono"
import { describe, expect, it, vi } from "vitest"
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

const SCRIPT = "/raw/derive-client.js"
const SHARED = "/raw/derive-shared.js"

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
    // Both platform runtimes are available even when an authored meta CSP follows.
    // The DOM-dependent client is deferred until parsing completes.
    expect(body).toContain(SHARED)
    expect(body.indexOf(SHARED)).toBeLessThan(body.indexOf("<h1>Hi</h1>"))
    expect(body.indexOf(SCRIPT)).toBeLessThan(body.indexOf("<h1>Hi</h1>"))
    expect(body).toContain('<script defer src="/raw/derive-client.js"></script>')
    expectSandbox(res)
  })

  it("loads Derive's runtimes before an authored meta CSP", async () => {
    const authoredCsp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://unpkg.com">`
    const res = await serveContent(
      ctx(),
      blobStore({
        k: `<!doctype html><html><head>${authoredCsp}</head><body><h1>Visible</h1></body></html>`,
      }),
      { blob_key: "k", content_type: "text/html" },
      "CSP document",
      "/",
      "",
    )
    const body = await res.text()
    expect(body.indexOf("charset=utf-8")).toBeLessThan(body.indexOf(SHARED))
    expect(body.indexOf(SHARED)).toBeLessThan(body.indexOf(authoredCsp))
    expect(body.indexOf(SCRIPT)).toBeLessThan(body.indexOf(authoredCsp))
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
    expect(body.match(/\/raw\/derive-client\.js/g)).toHaveLength(1)
    expect(body).toContain(SHARED)
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
    expect(body).not.toContain(SHARED)
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
