import { Hono, type Context } from "hono"
import {
  BUNDLE_CONTENT_TYPE,
  PublishError,
  artifactUrl,
  mimeFor,
  publish,
  renderMarkdown,
  renderShell,
  toJson,
  type BlobStore,
  type BundleManifest,
  type MetaStore,
} from "@dock/core"

export interface AppDeps {
  meta: MetaStore
  blobs: BlobStore
  baseUrl: string
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/** Headers for everything inside the artifact sandbox. */
const RAW_HEADERS: Record<string, string> = {
  // Opaque origin: scripts run, but can touch no cookies, storage, or APIs.
  "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  // Versioned paths are immutable by construction.
  "Cache-Control": "public, max-age=31536000, immutable",
}

const REF_RE = /^([0-9a-z]{6,12})(?:-[a-z0-9-]*)?(?:@v(\d+))?$/

/** Copy into a plain ArrayBuffer — what Hono's body() accepts. */
const toBody = (u: Uint8Array): ArrayBuffer => new Uint8Array(u).buffer as ArrayBuffer

/**
 * Embedded mode serves bundles under /raw/:id/v/:n/, so root-absolute URLs
 * (href="/x", src="/x", url(/x)) must be prefixed or they escape the artifact.
 * Domain mode (per-artifact origin) makes this a no-op later.
 */
const rewriteAbsoluteUrls = (text: string, prefix: string): string =>
  text
    .replace(/(\b(?:href|src|action|srcset|poster)=["'])\/(?!\/)/g, `$1${prefix}/`)
    .replace(/(url\(\s*['"]?)\/(?!\/)/g, `$1${prefix}/`)

export function createApp(deps: AppDeps): Hono {
  const { meta, blobs } = deps
  const app = new Hono()

  app.get("/healthz", (c) => c.json({ ok: true }))

  app.get("/", (c) =>
    c.html(
      `<!doctype html><meta charset="utf-8"><title>Dock</title>
<body style="font:16px/1.6 system-ui;background:#f6f0e3;color:#2a2540;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="letter-spacing:-.02em">Dock</h1>
<p>An open home for AI-generated artifacts.<br>
<code style="background:#eee7d6;padding:2px 8px;border-radius:6px">dock publish ./your-thing</code></p></div>`,
    ),
  )

  // ---- Publish ----------------------------------------------------------

  const handlePublish = async (c: Context, shortId?: string) => {
    const len = Number(c.req.header("content-length") ?? 0)
    if (len > MAX_UPLOAD_BYTES) return c.json({ error: "upload too large" }, 413)

    const body = await c.req.parseBody()
    const file = body["file"]
    if (!(file instanceof File)) return c.json({ error: "multipart field 'file' required" }, 400)

    const bytes = new Uint8Array(await file.arrayBuffer())
    const isBundle =
      /\.zip$/i.test(file.name) ||
      body["kind"] === "bundle" ||
      (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5))

    try {
      const { artifact, version } = await publish(
        meta,
        blobs,
        {
          bytes,
          filename: file.name,
          isBundle,
          title: str(body["title"]),
          slug: str(body["slug"]),
          spa: body["spa"] === "true" || body["spa"] === "1",
          message: str(body["message"]),
          author: str(body["author"]),
        },
        shortId,
      )
      const versions = await meta.listVersions(artifact.id)
      return c.json({ ...toJson(deps.baseUrl, artifact, versions), published: version.n }, 201)
    } catch (err) {
      if (err instanceof PublishError) return c.json({ error: err.message }, err.statusCode as 400)
      throw err
    }
  }

  app.post("/v1/artifacts", (c) => handlePublish(c))
  app.post("/v1/artifacts/:shortId/versions", (c) => handlePublish(c, c.req.param("shortId")))

  app.get("/v1/artifacts/:shortId", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return c.json({ error: "not found" }, 404)
    return c.json(toJson(deps.baseUrl, artifact, await meta.listVersions(artifact.id)))
  })

  // Source read-back for machines: returns an artifact's text content for any
  // version, as plain text (?v=N selects a version; defaults to current).
  app.get("/v1/artifacts/:shortId/content", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0) return c.json({ error: "not found" }, 404)
    const v = c.req.query("v") ? Number(c.req.query("v")) : artifact.current_version
    if (!Number.isInteger(v)) return c.json({ error: "bad version" }, 400)
    const version = await meta.getVersion(artifact.id, v)
    if (!version) return c.json({ error: `no version ${v}` }, 404)

    let data: Uint8Array | null
    if (version.content_type === BUNDLE_CONTENT_TYPE) {
      const manifestBytes = await blobs.get(version.blob_key)
      if (!manifestBytes) return c.json({ error: "blob missing" }, 500)
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest
      data = await blobs.get(manifest.files[manifest.entry].key)
    } else {
      data = await blobs.get(version.blob_key)
    }
    if (!data) return c.json({ error: "blob missing" }, 500)
    c.header("Content-Type", "text/plain; charset=utf-8")
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Dock-Version", String(v))
    c.header("X-Dock-Kind", artifact.kind)
    return c.body(toBody(data))
  })

  // ---- Viewer ------------------------------------------------------------

  app.get("/a/:ref", async (c) => {
    const m = REF_RE.exec(c.req.param("ref"))
    if (!m) return c.text("not found", 404)
    const artifact = await meta.getByShortId(m[1])
    if (!artifact || artifact.current_version === 0) return c.text("not found", 404)
    const n = m[2] ? Number(m[2]) : artifact.current_version
    const version = await meta.getVersion(artifact.id, n)
    if (!version) return c.text(`no version ${n}`, 404)
    const versions = await meta.listVersions(artifact.id)
    const rawSrc = `/raw/${artifact.short_id}/v/${n}/index.html`
    return c.html(renderShell(artifact, versions, n, rawSrc))
  })

  // ---- Raw content (the sandbox) ----------------------------------------

  app.get("/raw/:shortId/v/:n/*", async (c) => {
    const shortId = c.req.param("shortId")
    const n = Number(c.req.param("n"))
    const artifact = await meta.getByShortId(shortId)
    if (!artifact || !Number.isInteger(n)) return c.text("not found", 404)
    const version = await meta.getVersion(artifact.id, n)
    if (!version) return c.text("not found", 404)

    const prefix = `/raw/${shortId}/v/${c.req.param("n")}/`
    let path = decodeURIComponent(c.req.path.slice(prefix.length))

    if (version.content_type === BUNDLE_CONTENT_TYPE) {
      const manifestBytes = await blobs.get(version.blob_key)
      if (!manifestBytes) return c.text("blob missing", 500)
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest

      if (path === "" || path === "index.html") path = manifest.entry.slice(1)
      let lookup = `/${path}`
      if (lookup.endsWith("/")) lookup += "index.html"
      let entry = manifest.files[lookup]
      // Pretty URLs (Astro-style dir output), then SPA fallback.
      if (!entry && !/\.[a-z0-9]+$/i.test(lookup)) entry = manifest.files[`${lookup}/index.html`]
      if (!entry && manifest.spa) entry = manifest.files[manifest.entry]
      if (!entry) return c.text("not found", 404, RAW_HEADERS)

      const data = await blobs.get(entry.key)
      if (!data) return c.text("blob missing", 500)
      if (entry.type.startsWith("text/html") || entry.type.startsWith("text/css")) {
        const rewritten = rewriteAbsoluteUrls(
          new TextDecoder().decode(data),
          prefix.slice(0, -1),
        )
        return c.body(rewritten, 200, { ...RAW_HEADERS, "Content-Type": entry.type })
      }
      return c.body(toBody(data), 200, { ...RAW_HEADERS, "Content-Type": entry.type })
    }

    const data = await blobs.get(version.blob_key)
    if (!data) return c.text("blob missing", 500)

    if (version.content_type === "text/markdown") {
      if (path === "raw.md")
        return c.body(toBody(data), 200, { ...RAW_HEADERS, "Content-Type": "text/markdown; charset=utf-8" })
      const html = await renderMarkdown(new TextDecoder().decode(data), artifact.title)
      return c.body(html, 200, { ...RAW_HEADERS, "Content-Type": "text/html; charset=utf-8" })
    }

    // html file artifact — any path serves the document
    return c.body(toBody(data), 200, { ...RAW_HEADERS, "Content-Type": mimeFor(path || "index.html") })
  })

  return app
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)

export { artifactUrl }
