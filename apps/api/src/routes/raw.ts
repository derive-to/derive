import {
  ANCHOR_CLIENT_JS,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  mimeFor,
  renderMarkdown,
  SELECTION_SCRIPT,
} from "@dock/core"
import { type Context, Hono } from "hono"
import type { AppContext } from "../context"
import { RAW_HEADERS, rewriteAbsoluteUrls, TOMBSTONE, toBody } from "../lib/http"

/** The sandbox: raw artifact + proposal bytes under /raw/*. Served with an
 *  opaque-origin CSP; a proposal renders exactly like the live version will. */
export const rawRoutes = (ctx: AppContext) => {
  const { meta, blobs, authorize } = ctx
  const app = new Hono()

  // The comment-anchor client, referenced by URL from artifact HTML. Artifact
  // pages are cached immutable; this is cached short so the client can evolve
  // without stranding old behavior in already-viewed artifacts.
  app.get("/raw/dock-client.js", (c) =>
    c.body(ANCHOR_CLIENT_JS, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    }),
  )

  // Serve stored content (a version or a proposal) under `prefix`, resolving a
  // sub-`path` for bundles. Identical pipeline for both, so a proposal renders
  // exactly how it will once approved — reviewers approve the experience.
  const serveContent = async (
    c: Context,
    content: { blob_key: string; content_type: string },
    title: string | null,
    prefix: string,
    rawPath: string,
  ) => {
    let path = rawPath
    if (content.content_type === BUNDLE_CONTENT_TYPE) {
      const manifestBytes = await blobs.get(content.blob_key)
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
        const rewritten = rewriteAbsoluteUrls(new TextDecoder().decode(data), prefix.slice(0, -1))
        // Bundle pages get the anchor client too — comments stick everywhere.
        const out = entry.type.startsWith("text/html") ? rewritten + SELECTION_SCRIPT : rewritten
        return c.body(out, 200, { ...RAW_HEADERS, "Content-Type": entry.type })
      }
      return c.body(toBody(data), 200, { ...RAW_HEADERS, "Content-Type": entry.type })
    }

    const data = await blobs.get(content.blob_key)
    if (!data) return c.text("blob missing", 500)

    if (content.content_type === "text/markdown") {
      if (path === "raw.md")
        return c.body(toBody(data), 200, {
          ...RAW_HEADERS,
          "Content-Type": "text/markdown; charset=utf-8",
        })
      const html = await renderMarkdown(new TextDecoder().decode(data), title)
      return c.body(html, 200, { ...RAW_HEADERS, "Content-Type": "text/html; charset=utf-8" })
    }

    // html file artifact — any path serves the document (+ selection capture)
    const ct = mimeFor(path || "index.html")
    if (ct.startsWith("text/html")) {
      const html = new TextDecoder().decode(data) + SELECTION_SCRIPT
      return c.body(html, 200, { ...RAW_HEADERS, "Content-Type": ct })
    }
    return c.body(toBody(data), 200, { ...RAW_HEADERS, "Content-Type": ct })
  }

  app.get("/raw/:shortId/v/:n/*", async (c) => {
    const shortId = c.req.param("shortId")
    const n = Number(c.req.param("n"))
    const artifact = await meta.getByShortId(shortId)
    if (!artifact || !Number.isInteger(n) || !(await authorize(c, "read", artifact)))
      return c.text("not found", 404)
    if (artifact.removed_at) return c.text(TOMBSTONE, 410)
    const version = await meta.getVersion(artifact.id, n)
    if (!version) return c.text("not found", 404)

    const prefix = `/raw/${shortId}/v/${c.req.param("n")}/`
    const path = decodeURIComponent(c.req.path.slice(prefix.length))
    return serveContent(c, version, artifact.title, prefix, path)
  })

  // Render a proposed version exactly like a live one, so review is of the
  // experience, not a source dump. Read-gated; the proposal must belong here.
  app.get("/raw/:shortId/p/:proposalId/*", async (c) => {
    const shortId = c.req.param("shortId")
    const artifact = await meta.getByShortId(shortId)
    if (!artifact || !(await authorize(c, "read", artifact))) return c.text("not found", 404)
    if (artifact.removed_at) return c.text(TOMBSTONE, 410)
    const proposal = await meta.getProposal(c.req.param("proposalId"))
    if (!proposal || proposal.artifact_id !== artifact.id) return c.text("not found", 404)

    const prefix = `/raw/${shortId}/p/${proposal.id}/`
    const path = decodeURIComponent(c.req.path.slice(prefix.length))
    return serveContent(c, proposal, artifact.title, prefix, path)
  })

  return app
}
