import { ANCHOR_CLIENT_JS, type ArtifactRecord } from "@derive/core"
import type { Context } from "hono"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { crossDocTransform } from "../lib/cross-doc"
import { verifyState } from "../lib/crypto"
import { cacheControlFor, TOMBSTONE } from "../lib/http"
import { verifyPreviewToken } from "../lib/preview-token"
import { serveContent } from "../lib/serve-content"

// How long a minted raw_token (artifacts.ts's GET detail response) stays good for. It
// doesn't re-check role/visibility live the way the cookie path's authorize() does, so
// it's kept short — long enough to browse one sitting of a multi-page/image bundle,
// short enough to bound exposure if the URL leaks (browser history, a proxy log, ...).
const RAW_TOKEN_MAX_AGE_MS = 5 * 60 * 1000

/** The sandbox: raw artifact + proposal bytes under /raw/*. Served with an
 *  opaque-origin CSP; a proposal renders exactly like the live version will. */
export const rawRoutes = (ctx: AppContext) => {
  const { meta, blobs, deps, authorize, background } = ctx
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

  // Shared by both entry points below (cookie-authorized and token-authorized): once
  // `artifact` is known readable, serve version `n` under `prefix`. `prefix` carries
  // whatever the entry point needs relative asset references to inherit — for the
  // token route that's the `/t/:token` segment, so a bundle's own `<img src="x.png">`
  // requests automatically replay the same proof of access with no HTML rewriting.
  const serveVersion = async (c: Context, artifact: ArtifactRecord, n: number, prefix: string) => {
    if (artifact.removed_at) return c.text(TOMBSTONE, 410)
    const version = await meta.getVersion(artifact.id, n)
    if (!version) return c.text("not found", 404)
    const path = decodeURIComponent(c.req.path.slice(prefix.length))
    return serveContent(
      c,
      blobs,
      version,
      artifact.title,
      prefix,
      path,
      cacheControlFor(artifact.link_role, !!artifact.password_hash),
      // Self-heal: this view just proved the bytes are HTML under a markdown label.
      // Fix the stored type off the hot path (waitUntil on edge, inline in tests) so
      // every view repairs it — the publish-time sniff stops new ones, this drains
      // the backlog as artifacts are opened, with no manual maintenance step needed.
      () => background(meta.reclassifyVersion(artifact.id, n, "text/html")),
      // Resolve relative cross-document links to sibling artifacts (synced folders),
      // so a tab like `walkthrough.html` navigates to the walkthrough artifact instead
      // of re-serving this page. No-op unless this artifact is GitHub-synced.
      crossDocTransform(meta, artifact),
    )
  }

  // The sandboxed content iframe's own entry point: a signed capability in the PATH
  // (not a query param — a relative URL resolves against its base's path only, so a
  // query-string token wouldn't reach a bundle's own `screenshots/x.png`-style
  // references, but a path segment does, automatically, for every nested asset) takes
  // the place of the cookie the opaque-origin iframe can't carry. Falls back to the
  // live cookie check on an invalid/expired token, so a stale or hand-typed link isn't
  // a hard dead end for a caller who genuinely still has access.
  //
  // Registered BEFORE the plain `/v/:n/*` route below: that pattern's trailing wildcard
  // is a syntactic superset of this one (it would happily swallow `t/<token>/...` as
  // part of its own `*`), so the more specific route must win the match, not just the
  // auth check — registration order is the explicit tiebreaker, not left to the router.
  app.get("/raw/:shortId/v/:n/t/:token/*", async (c) => {
    const shortId = c.req.param("shortId")
    const n = Number(c.req.param("n"))
    const artifact = await meta.getByShortId(shortId)
    if (!artifact || !Number.isInteger(n)) return c.text("not found", 404)
    const claim = verifyState<{ rid: string }>(
      c.req.param("token"),
      deps.encryptionKey ?? "",
      RAW_TOKEN_MAX_AGE_MS,
    )
    const ok = claim?.rid === artifact.id || (await authorize(c, "read", artifact))
    if (!ok) return c.text("not found", 404)
    return serveVersion(
      c,
      artifact,
      n,
      `/raw/${shortId}/v/${c.req.param("n")}/t/${c.req.param("token")}/`,
    )
  })

  // The screenshot renderer's entry point: the short-lived preview token minted in
  // previews.ts (read of exactly one artifact+version, never anything wider) rides as
  // a PATH segment for the same reason the viewer's `/t/:token/` above does. It used
  // to arrive as `?pv=` on the plain route below — which authorized the page itself
  // but not a bundle's own `<img src="picker.webp">` requests (a relative URL keeps
  // its base's path, not its query string), so private bundles screenshotted with
  // every image broken. In the path, the proof of access replays automatically on
  // each nested asset request. Same registration-order constraint as `/t/:token/`.
  //
  // Verify BEFORE anything else, and fall through (next()) when the segment isn't a
  // valid token: this route pattern would otherwise reserve the `pv/` name inside
  // every artifact — a bundle's own literal `pv/chart.png` would match here, get its
  // path sliced against the wrong prefix, and 404 for a fully authorized viewer.
  // A segment that HMAC-verifies can't be a coincidental filename, so a valid token
  // (even for the wrong artifact — someone replaying it) owns the request, and
  // everything else is a real file path for the plain route below to serve under
  // its normal cookie authorization.
  app.get("/raw/:shortId/v/:n/pv/:pv/*", async (c, next) => {
    const secret = deps.encryptionKey
    const claim = secret ? await verifyPreviewToken(secret, c.req.param("pv"), Date.now()) : null
    if (!claim) return next()
    const shortId = c.req.param("shortId")
    const n = Number(c.req.param("n"))
    const artifact = await meta.getByShortId(shortId)
    if (!artifact || !Number.isInteger(n)) return c.text("not found", 404)
    if (claim.artifactId !== artifact.id || claim.n !== n) return c.text("not found", 404)
    return serveVersion(
      c,
      artifact,
      n,
      `/raw/${shortId}/v/${c.req.param("n")}/pv/${c.req.param("pv")}/`,
    )
  })

  app.get("/raw/:shortId/v/:n/*", async (c) => {
    const shortId = c.req.param("shortId")
    const n = Number(c.req.param("n"))
    const artifact = await meta.getByShortId(shortId)
    if (!artifact || !Number.isInteger(n)) return c.text("not found", 404)
    if (!(await authorize(c, "read", artifact))) return c.text("not found", 404)
    return serveVersion(c, artifact, n, `/raw/${shortId}/v/${c.req.param("n")}/`)
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
