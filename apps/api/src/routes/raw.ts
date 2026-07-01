import { ANCHOR_CLIENT_JS } from "@derive/core"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { crossDocTransform } from "../lib/cross-doc"
import { cacheControlFor, TOMBSTONE } from "../lib/http"
import { serveContent } from "../lib/serve-content"

/** The sandbox: raw artifact + proposal bytes under /raw/*. Served with an
 *  opaque-origin CSP; a proposal renders exactly like the live version will. */
export const rawRoutes = (ctx: AppContext) => {
  const { meta, blobs, authorize, background } = ctx
  const app = new Hono()

  // The comment-anchor client, referenced by URL from artifact HTML. Artifact
  // pages are cached immutable; this is cached short so the client can evolve
  // without stranding old behavior in already-viewed artifacts.
  app.get("/raw/derive-client.js", (c) =>
    c.body(ANCHOR_CLIENT_JS, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    }),
  )

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
    // `?reader=1` (the in-app Reader toggle) re-renders the content clean + responsive.
    const reader = ["1", "true"].includes(c.req.query("reader") ?? "")
    return serveContent(
      c,
      blobs,
      version,
      artifact.title,
      prefix,
      path,
      cacheControlFor(artifact.visibility),
      // Self-heal: this view just proved the bytes are HTML under a markdown label.
      // Fix the stored type off the hot path (waitUntil on edge, inline in tests) so
      // every view repairs it — the publish-time sniff stops new ones, this drains
      // the backlog as artifacts are opened, with no manual maintenance step needed.
      () => background(meta.reclassifyVersion(artifact.id, n, "text/html")),
      // Resolve relative cross-document links to sibling artifacts (synced folders),
      // so a tab like `walkthrough.html` navigates to the walkthrough artifact instead
      // of re-serving this page. No-op unless this artifact is GitHub-synced.
      crossDocTransform(meta, artifact),
      true,
      reader,
    )
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
    // A proposal is in-review, transient content (it can be withdrawn or change);
    // never let a shared cache hold it, regardless of the artifact's visibility.
    return serveContent(c, blobs, proposal, artifact.title, prefix, path, "private, no-store")
  })

  return app
}
