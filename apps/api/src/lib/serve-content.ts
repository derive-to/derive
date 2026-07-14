import {
  type BlobStore,
  type BundleManifest,
  HISTORY_SHIM,
  isBundleContentType,
  looksLikeHtmlDocument,
  MARKS_SCRIPT,
  mimeFor,
  parseFrontmatter,
  reflowHtml,
  renderMarkdown,
  SELECTION_SCRIPT,
} from "@derive/core"
import type { Context } from "hono"
import { headersFor, IMMUTABLE_CACHE, rewriteAbsoluteUrls, toBody } from "./http"

/**
 * Serve stored artifact content (a version or a proposal) under `prefix`, resolving
 * a sub-`path` for bundles. Shared by the `/raw/*` sandbox routes and domain mode:
 * for `/raw/:id/v/:n/` the prefix carries the path; for a vanity host the prefix is
 * `/`, so the absolute-URL rewriting becomes a no-op and the artifact serves at its
 * own origin root. Carries the opaque-origin CSP by default; an isolated
 * per-artifact origin passes `isolated` for the capability grant (headersFor).
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
  /** This response is being served on an ISOLATED per-artifact origin (an
   *  artifact-bound domain host): use the capability-granting header set
   *  (`allow-same-origin` — see headersFor in http.ts) and inject the history
   *  shim so an EMBEDDED copy of the artifact can't grow the embedder's tab
   *  history. Default off: /raw and workspace-domain serves stay opaque. */
  isolated = false,
) => {
  const headers = { ...headersFor(isolated), "Cache-Control": cacheControl }
  const tx = (doc: string) => (transformHtml ? transformHtml(doc) : Promise.resolve(doc))
  const rf = (doc: string) => (reflow ? reflowHtml(doc) : doc)
  // ?marks=1 draws numbered @N badges on the page's top-level landmark regions — the
  // marked-render variant of the render rung (see marks-script.ts). Gated on a query
  // param so it costs a normal read NOTHING: never baked into a plain page load, an
  // og:image unfurl, or the previews worker's OG crop. Anyone who can already view
  // the artifact can add it (a lightweight "inspect regions" mode), same auth as any
  // other read.
  const wantsMarks = ["1", "true"].includes(c.req.query("marks") ?? "")
  const marks = wantsMarks ? MARKS_SCRIPT : ""
  // On an isolated origin the page has real History access — ship the back-button
  // shim with every HTML response there (a no-op unless the page is iframed).
  const shim = isolated ? HISTORY_SHIM : ""
  // Produce the final HTML body for a document: cross-doc rewrite + auto-reflow, then append
  // the anchor client (for comment anchoring + live cursors) and, when asked, the marks overlay.
  const htmlBody = async (doc: string): Promise<string> =>
    rf(await tx(doc)) + SELECTION_SCRIPT + marks + shim
  let path = rawPath
  if (isBundleContentType(content.content_type)) {
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
      const out = entry.type.startsWith("text/html")
        ? rf(rewritten) + SELECTION_SCRIPT + marks + shim
        : rewritten
      return c.body(out, 200, { ...headers, "Content-Type": entry.type })
    }
    // Markdown pages (a skill's SKILL.md, a doc bundle's pages) render through the
    // same markdown path as a single-file .md — branded shell, GFM, anchor client —
    // so an HTML-less skill folder reads as a document, not a raw text dump. `?raw=1`
    // bypasses it to fetch the source (mirrors the single-file `raw.md` escape).
    // `?raw=1` bypasses rendering to fetch a file's source (mirrors single-file raw.md).
    if (
      entry.type.startsWith("text/markdown") &&
      !["1", "true"].includes(c.req.query("raw") ?? "")
    ) {
      // Strip YAML frontmatter (a skill's SKILL.md leads with name/description) — marked
      // would otherwise render it as a stray `<hr>` + heading. The parsed fields surface
      // as skill chrome around this iframe, not in the document body.
      const body = parseFrontmatter(new TextDecoder().decode(data)).body
      const html = await tx(await renderMarkdown(body, title))
      return c.body(html, 200, { ...headers, "Content-Type": "text/html; charset=utf-8" })
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
      return c.body(await htmlBody(text), 200, {
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
    const html = await htmlBody(new TextDecoder().decode(data))
    return c.body(html, 200, { ...headers, "Content-Type": ct })
  }
  return c.body(toBody(data), 200, { ...headers, "Content-Type": ct })
}
