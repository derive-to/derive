import {
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  looksLikeHtmlDocument,
  mimeFor,
  reflowHtml,
  renderMarkdown,
  SELECTION_SCRIPT,
} from "@dock/core"
import type { Context } from "hono"
import { IMMUTABLE_CACHE, RAW_HEADERS, rewriteAbsoluteUrls, toBody } from "./http"

/**
 * Serve stored artifact content (a version or a proposal) under `prefix`, resolving
 * a sub-`path` for bundles. Shared by the `/raw/*` sandbox routes and domain mode:
 * for `/raw/:id/v/:n/` the prefix carries the path; for a vanity host the prefix is
 * `/`, so the absolute-URL rewriting becomes a no-op and the artifact serves at its
 * own origin root. Always carries the opaque-origin CSP (RAW_HEADERS).
 *
 * `cacheControl` sets Cache-Control per the artifact's access model (see
 * `cacheControlFor`): a shared cache must never store a gated artifact's bytes and
 * replay them to an unauthorized viewer, so only fully-public content is immutable.
 */
export const serveContent = async (
  c: Context,
  blobs: BlobStore,
  content: { blob_key: string; content_type: string },
  title: string | null,
  prefix: string,
  rawPath: string,
  cacheControl: string = IMMUTABLE_CACHE,
  /** Called when the bytes contradict a `text/markdown` label (they're actually a
   *  full HTML document). The caller uses this to self-heal the stored content_type
   *  so the mislabel is fixed permanently, not just rendered-around each view. */
  onMismatch?: () => void,
  /** Serve-time rewrite applied to every HTML body this produces (a raw HTML file,
   *  markdown-rendered output, or a mislabeled-HTML markdown blob) before the anchor
   *  client is appended. Resolves a synced artifact's relative cross-document links
   *  into in-app navigations; omitted ⇒ identity. */
  transformHtml?: (html: string) => Promise<string>,
  /** Auto-reflow non-mobile-optimized HTML at serve time (inject a viewport tag + a
   *  conservative overflow reset, only when the document declares no viewport). Detection-
   *  gated and non-destructive — the stored bytes are untouched. Default on; pass false to
   *  serve the document exactly as authored. Never applied to markdown-rendered output,
   *  which is already responsive. */
  reflow = true,
) => {
  const headers = { ...RAW_HEADERS, "Cache-Control": cacheControl }
  const tx = (doc: string) => (transformHtml ? transformHtml(doc) : Promise.resolve(doc))
  const rf = (doc: string) => (reflow ? reflowHtml(doc) : doc)
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
    if (!entry) return c.text("not found", 404, headers)

    const data = await blobs.get(entry.key)
    if (!data) return c.text("blob missing", 500)
    if (entry.type.startsWith("text/html") || entry.type.startsWith("text/css")) {
      const rewritten = rewriteAbsoluteUrls(new TextDecoder().decode(data), prefix.slice(0, -1))
      // Bundle pages get the anchor client too — comments stick everywhere.
      const out = entry.type.startsWith("text/html") ? rf(rewritten) + SELECTION_SCRIPT : rewritten
      return c.body(out, 200, { ...headers, "Content-Type": entry.type })
    }
    return c.body(toBody(data), 200, { ...headers, "Content-Type": entry.type })
  }

  const data = await blobs.get(content.blob_key)
  if (!data) return c.text("blob missing", 500)

  if (content.content_type === "text/markdown") {
    if (path === "raw.md")
      return c.body(toBody(data), 200, {
        ...headers,
        "Content-Type": "text/markdown; charset=utf-8",
      })
    const text = new TextDecoder().decode(data)
    // Redundancy against a mislabeled blob: a version stored as text/markdown whose
    // bytes are actually a full HTML document renders blank through the markdown path
    // (it strips <head>/<style>/scripts) — the white screen we must never produce.
    // Detect it and serve the HTML verbatim, and signal the caller to self-heal the
    // stored type. The renderer never emits a blank page from real content, whatever
    // the label says — the type sniff is a hint, this is the backstop.
    if (looksLikeHtmlDocument(text)) {
      onMismatch?.()
      return c.body(rf(await tx(text)) + SELECTION_SCRIPT, 200, {
        ...headers,
        "Content-Type": "text/html; charset=utf-8",
      })
    }
    const html = await tx(await renderMarkdown(text, title))
    return c.body(html, 200, { ...headers, "Content-Type": "text/html; charset=utf-8" })
  }

  // html file artifact — any path serves the document (+ selection capture)
  const ct = mimeFor(path || "index.html")
  if (ct.startsWith("text/html")) {
    const html = rf(await tx(new TextDecoder().decode(data))) + SELECTION_SCRIPT
    return c.body(html, 200, { ...headers, "Content-Type": ct })
  }
  return c.body(toBody(data), 200, { ...headers, "Content-Type": ct })
}
