import { ANCHOR_CLIENT_JS, type ArtifactRecord, isDerivedFactName } from "@derive/core"
import type { Context } from "hono"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { crossDocTransform } from "../lib/cross-doc"
import { verifyState } from "../lib/crypto"
import { cacheControlFor, fail, TOMBSTONE } from "../lib/http"
import { verifyPreviewToken } from "../lib/preview-token"
import { serveContent } from "../lib/serve-content"
import { log } from "../log"
import { safeJson } from "../mcp-util"

// How long a minted raw_token (artifacts.ts's GET detail response) stays good for. It
// doesn't re-check role/visibility live the way the cookie path's authorize() does, so
// it's kept short — long enough to browse one sitting of a multi-page/image bundle,
// short enough to bound exposure if the URL leaks (browser history, a proxy log, ...).
const RAW_TOKEN_MAX_AGE_MS = 5 * 60 * 1000

/** The sandbox: raw artifact + proposal bytes under /raw/*. Served with an
 *  opaque-origin CSP; a proposal renders exactly like the live version will. */
export const rawRoutes = (ctx: AppContext) => {
  const { meta, blobs, deps, authorize, actorFor, background } = ctx
  const app = new Hono()

  // The public-history gate: unless the owner opted the public page into history,
  // an anonymous caller reads only the CURRENT version — an old version's bytes are
  // as hidden as the workbench that lists them. Applies to the viewer entry points
  // (cookie + raw_token) only: the preview route's token is a server-minted
  // capability for exactly one artifact+version, and proposals aren't versions.
  const anonHistoryBlocked = async (c: Context, artifact: ArtifactRecord, n: number) =>
    n !== artifact.current_version &&
    !artifact.public_history &&
    (await actorFor(c, artifact)).kind === "anon"

  // The comment-anchor client, referenced by URL from artifact HTML. Artifact
  // pages are cached immutable; this is cached short so the client can evolve
  // without stranding old behavior in already-viewed artifacts.
  app.get("/raw/derive-client.js", (c) =>
    c.body(ANCHOR_CLIENT_JS, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    }),
  )

  // A version's facts as JSON, for everything that isn't an MCP client: a fetch()
  // from the artifact's own page (a chart reading its own history), a curl in a shell,
  // a script with a bearer. Same facts the `read` tool returns, same authorization and
  // anon-history gate as the bytes — a fact is part of the version, so it can never be
  // more readable than the page carrying it.
  //
  // Registered BEFORE the `/raw/:shortId/v/:n/*` catch-all, whose trailing wildcard would
  // otherwise swallow `data/checks.json` as a file path inside the artifact; the more
  // specific route has to win the match, exactly like the `/t/:token/` route above.
  // `.json` is optional so both spellings work rather than one 404ing mysteriously.
  //
  // A fact's bytes reach only a caller who cleared `authorize`, so for an artifact with no
  // world link (or a locked one) the response is CALLER-SPECIFIC. Nothing here varies on
  // the credential that produced it, so marking it `public` would invite a CDN or corporate
  // proxy to hand one member's figures to anyone who asks, and the version-pinned variant
  // asks to keep them for a year. A world-readable artifact keeps the hard cache that makes
  // these URLs cheap for a page to poll. Same line the OG card draws in embeds.ts.
  const slotCache = (a: ArtifactRecord, directives: string): string =>
    a.link_role === "none" || a.password_hash ? `private, ${directives}` : `public, ${directives}`

  /**
   * A fact response must be READABLE BY THE ARTIFACT'S OWN PAGE, which is the entire
   * point of "a page charts its own history".
   *
   * Artifacts are served into an OPAQUE ORIGIN (the sandbox CSP grants no
   * allow-same-origin), so a page fetching its own data is making a cross-origin request
   * from a null origin. Without this header the browser refuses to hand the body to the
   * script and `fetch` throws a bare "Failed to fetch" before any response is visible.
   * Every other raw route already carries it via RAW_HEADERS; these routes built their
   * headers from scratch and lost it, which is why a live probe page could self-discover
   * its own short_id and then fail on the very next line.
   *
   * It grants no access. An opaque origin cannot send credentials, and `*` forbids
   * credentialed reads anyway, so a cross-origin caller sees exactly what an anonymous
   * one sees — which for a gated artifact is the 404 the authorize check above already
   * returned. This makes a PUBLIC artifact's data readable by its own page; a gated one
   * still cannot self-read, because the page has no credentials to prove with.
   */
  const SLOT_CORS = { "Access-Control-Allow-Origin": "*" }

  const serveSlot = async (c: Context, shortId: string, n: number | null, slotRaw: string) => {
    // `.jsonl` asks for the WHOLE SERIES, `.json` (or bare) for one version's value. The
    // two share this handler rather than living on separate routes because the `.json`
    // pattern matches `checks.jsonl` first — a sibling route could never win the match.
    const wantsSeries = /\.jsonl$/i.test(slotRaw) && n === null
    const slot = slotRaw.replace(/\.jsonl$/i, "").replace(/\.json$/i, "")
    const artifact = await meta.getByShortId(shortId)
    if (!artifact) return fail(c, 404, "not found")
    if (artifact.removed_at) return fail(c, 410, TOMBSTONE)
    const v = n ?? artifact.current_version
    if (!Number.isInteger(v) || v < 1 || v > artifact.current_version)
      return fail(c, 404, `no version ${v}`)
    if (!(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    if (await anonHistoryBlocked(c, artifact, v)) return fail(c, 404, "not found")

    // THE SERIES EXPORT: one JSON object per version, oldest first. This is the substrate
    // the rest of the querying story stands on — a page charts its own history from it, an
    // agent pulls a series without an MCP client, a shell pipes it to jq, and anything
    // wanting real SQL points DuckDB-WASM at it. Derive precomputes and serves; the
    // consumer queries, which is why there is no query language here to defend.
    // JSONL on purpose: a new version is a LINE append, and it streams.
    if (wantsSeries) {
      // An anonymous caller who may not read history gets only the current point — the
      // export must never be a way around the public-history gate.
      const anonCurrentOnly = await anonHistoryBlocked(c, artifact, 1)
      const series = anonCurrentOnly
        ? await meta.getVersionData(artifact.id, artifact.current_version, slot)
        : await meta.getVersionDataSeries(artifact.id, slot, 1, artifact.current_version, 5000)
      if (!series.length) return fail(c, 404, `no facts "${slot}"`)
      const body = series
        .map((r) => JSON.stringify({ n: r.n, at: r.created_at, data: safeJson(r.json) }))
        .join("\n")
      // The raw surface is where self-reading pages consume their own data — the
      // consumption most worth observing (fact_read: the layer's instrument).
      log.info("fact_read", { name: slot, derived: isDerivedFactName(slot), surface: "raw" })
      return c.body(`${body}\n`, 200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        // Grows with every publish, so never immutable — but cheap and worth a short cache.
        "Cache-Control": slotCache(artifact, "max-age=60"),
        "X-Content-Type-Options": "nosniff",
        ...SLOT_CORS,
      })
    }
    const rows = await meta.getVersionData(artifact.id, v, slot)
    const row = rows[0]
    if (!row) return fail(c, 404, `no facts "${slot}" in v${v}`)
    // The stored bytes verbatim, not a re-serialization: what was published is what a
    // caller gets, and it's already valid JSON (validated at publish).
    log.info("fact_read", { name: slot, derived: isDerivedFactName(slot), surface: "raw" })
    return c.body(row.json, 200, {
      "Content-Type": "application/json; charset=utf-8",
      // A version is immutable, so its slot is too — cache it hard. The current-version
      // alias can't be, since the next publish changes what it points at.
      "Cache-Control": n === null ? "no-cache" : slotCache(artifact, "max-age=31536000, immutable"),
      ...SLOT_CORS,
    })
  }
  app.get("/raw/:shortId/v/:n/data/:slot", (c) =>
    serveSlot(c, c.req.param("shortId"), Number(c.req.param("n")), c.req.param("slot")),
  )
  app.get("/raw/:shortId/data/:slot", (c) =>
    serveSlot(c, c.req.param("shortId"), null, c.req.param("slot")),
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
    if (await anonHistoryBlocked(c, artifact, n)) return c.text("not found", 404)
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
    if (await anonHistoryBlocked(c, artifact, n)) return c.text("not found", 404)
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
