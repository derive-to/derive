import {
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  mimeFor,
  renderMarkdown,
  SELECTION_SCRIPT,
} from "@dock/core"
import type { Context } from "hono"
import { RAW_HEADERS, rewriteAbsoluteUrls, toBody } from "./http"

/**
 * Serve stored artifact content (a version or a proposal) under `prefix`, resolving
 * a sub-`path` for bundles. Shared by the `/raw/*` sandbox routes and domain mode:
 * for `/raw/:id/v/:n/` the prefix carries the path; for a vanity host the prefix is
 * `/`, so the absolute-URL rewriting becomes a no-op and the artifact serves at its
 * own origin root. Always carries the opaque-origin CSP (RAW_HEADERS).
 */
export const serveContent = async (
  c: Context,
  blobs: BlobStore,
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
