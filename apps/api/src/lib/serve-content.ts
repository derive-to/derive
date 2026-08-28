import {
  type BlobStore,
  type BundleManifest,
  backfillLegacyDeckStructure,
  injectArtifactRuntimeScripts,
  injectSharedStateScript,
  isBundleContentType,
  looksLikeHtmlDocument,
  MARKS_SCRIPT,
  mimeFor,
  parseFrontmatter,
  reflowHtml,
  renderMarkdown,
  SELECTION_SCRIPT,
  SHARED_STATE_SCRIPT,
} from "@derive/core"
import type { Context } from "hono"
import { IMMUTABLE_CACHE, RAW_HEADERS, rewriteAbsoluteUrls, toBody } from "./http"

/**
 * Serve a stored artifact version's content under `prefix`, resolving
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
  /** Auto-reflow non-mobile-optimized HTML at serve time (inject a viewport tag + a
   *  conservative overflow reset, only when the document declares no viewport). Detection-
   *  gated and non-destructive — the stored bytes are untouched. Default on; pass false to
   *  serve the document exactly as authored. Never applied to markdown-rendered output,
   *  which is already responsive. */
  reflow = true,
  /** Inject the anchor client (selection → comment, hover chips, live cursors).
   *  It only functions embedded in the app viewer — it talks to the host via
   *  parent.postMessage — so standalone serving (vanity/draft hosts, which are
   *  never iframed by the app) passes false: on a top-level page the client's
   *  hover UI renders but can deliver nothing. Default on for the raw routes,
   *  whose pages the viewer embeds. */
  anchors = true,
  /** Extra serve-time HTML appended to every rendered page (today: the draft
   *  discovery chip, lib/draft-chip.ts). Same contract as the anchor client:
   *  never part of the stored bytes, never on non-HTML responses. */
  append = "",
) => {
  const headers = { ...RAW_HEADERS, "Cache-Control": cacheControl }
  const rf = (doc: string) => (reflow ? reflowHtml(doc) : doc)
  // ?marks=1 draws numbered @N badges on the page's top-level landmark regions — the
  // marked-render variant of the render rung (see marks-script.ts). Gated on a query
  // param so it costs a normal read NOTHING: never baked into a plain page load, an
  // og:image unfurl, or the previews worker's OG crop. Anyone who can already view
  // the artifact can add it (a lightweight "inspect regions" mode), same auth as any
  // other read.
  const wantsMarks = ["1", "true"].includes(c.req.query("marks") ?? "")
  const marks = wantsMarks ? MARKS_SCRIPT : ""
  const withRuntime = anchors
    ? (doc: string) => injectArtifactRuntimeScripts(doc, SHARED_STATE_SCRIPT + SELECTION_SCRIPT)
    : (doc: string) => doc
  // renderMarkdown already carries SELECTION_SCRIPT in its generated shell, so it
  // needs only the early shared-state runtime. Injecting the full pair would execute
  // the anchor client twice.
  const withSharedState = anchors ? injectSharedStateScript : (doc: string) => doc
  // Runtime scripts precede authored meta CSP and execute in parse-safe order. Marks and
  // route-specific chrome remain appended because they are optional DOM enhancements.
  const htmlBody = (doc: string): string => withRuntime(rf(doc)) + marks + append
  // Legacy decks already have a source-level slide boundary. Optimistically expose
  // their safe direct children as movable nodes in the app render; the identical
  // pure transform is persisted by materializeEdits on the first save. A malformed
  // or ambiguous deck remains viewable and simply receives no structural handles.
  const withDeckStructure = (doc: string): string => {
    if (content.content_type !== "text/x-derive-deck") return doc
    try {
      return backfillLegacyDeckStructure(doc).html
    } catch {
      return doc
    }
  }
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
        ? withRuntime(rf(rewritten)) + marks + append
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
      const html = withSharedState(await renderMarkdown(body, title)) + append
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
    const html = withSharedState(await renderMarkdown(text, title)) + append
    return c.body(html, 200, { ...headers, "Content-Type": "text/html; charset=utf-8" })
  }

  // html file artifact — any path serves the document (+ selection capture)
  const ct = mimeFor(path || "index.html")
  if (ct.startsWith("text/html")) {
    const html = await htmlBody(withDeckStructure(new TextDecoder().decode(data)))
    return c.body(html, 200, { ...headers, "Content-Type": ct })
  }
  return c.body(toBody(data), 200, { ...headers, "Content-Type": ct })
}
