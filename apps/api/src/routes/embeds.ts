import {
  type ArtifactRecord,
  candidateShortIds,
  elideDataUris,
  escapeHtml,
  injectHead,
  isBundleContentType,
  normalizeUsername,
  oembedResponse,
  ogCardSvg,
  ogProfileCardSvg,
  type ProfileCard,
  parseRef,
  profileMetaTags,
  profileSummary,
  refFor,
  setRobotsMeta,
  setTitle,
  toMarkdown,
  type UnfurlInfo,
  unfurlMetaTags,
} from "@derive/core"
import { type Context, Hono } from "hono"
import type { AppContext } from "../context"
import { manifestOf } from "../lib/bundle"
import { fail, toBody } from "../lib/http"
import { SLACK_PREVIEW_ORIGIN, verifyOgToken } from "../lib/og-token"
import { unfurlInfoFor } from "../lib/unfurl-info"

/**
 * Unfurl + embed surface. Turns a `/artifacts/:ref` share link into a rich card and an
 * embeddable iframe, so a Derive link looks good in Slack / Discord / X / Notion and
 * can be dropped into any page. Three public, anonymous-readable endpoints under
 * `/v1` (worker-first in both runtimes) plus a server-rendered `/artifacts/:ref` that
 * injects OG/Twitter meta into the SPA shell for crawlers (which don't run JS):
 *
 *   GET /v1/og/:ref        the OG card image (SVG, 1200x630)
 *   GET /v1/oembed?url=…   the oEmbed document (rich; a sandboxed iframe)
 *   GET /v1/embed/:ref     the embeddable view (iframe target)
 *   GET /artifacts/:ref            the SPA shell with per-artifact unfurl meta injected
 *
 * Visibility is honored against the *request* actor: a crawler is anonymous, so
 * org/password artifacts never leak a title — they get a generic locked card.
 */
export const embedRoutes = (ctx: AppContext) => {
  const { meta, resolveArtifacts, authorize, actorFor, blobs, effectiveWhiteLabel, sourceText } =
    ctx
  const baseUrl = ctx.deps.baseUrl
  const rawBase = ctx.deps.sandboxOrigin ?? baseUrl
  const app = new Hono()

  // Everything an unfurl/embed surface needs for one artifact (lib/unfurl-info.ts — shared with
  // the Slack link-unfurl builder so the two can't describe the same artifact differently).
  const infoFor = (artifact: ArtifactRecord): Promise<UnfurlInfo> =>
    unfurlInfoFor(meta, baseUrl, artifact)

  /**
   * The cache directive for a response whose CONTENT depends on who asked.
   *
   * Anything built from `infoFor` is assembled only for a caller who cleared `readable()`,
   * so for an artifact with no world link it carries that artifact's title, counts and now
   * its slot figures. Nothing here varies on the credential that produced those bytes, so
   * marking them `public` invites a CDN or corporate proxy to hand an authorized member's
   * card to an anonymous requester. Gated artifacts therefore cache in the caller's own
   * browser only. The PNG branch below has always drawn this line; every sibling that
   * embeds `infoFor` needs it drawn the same way.
   */
  const cacheFor = (a: ArtifactRecord | null, shared: string, privateMaxAge = 600): string =>
    a && (a.link_role === "none" || !!a.password_hash)
      ? `private, max-age=${privateMaxAge}`
      : shared

  // Resolve `:ref` → an artifact the *request actor* may read. `null` means "render
  // a generic card" (missing, removed, or gated to an anonymous crawler).
  const readable = async (c: Context, ref: string): Promise<ArtifactRecord | null> => {
    const candidates = candidateShortIds(ref)
    const resolved = await resolveArtifacts(c, candidates)
    const byShortId = new Map(resolved.map((artifact) => [artifact.short_id, artifact]))
    const artifact = candidates.map((id) => byShortId.get(id)).find(Boolean) ?? null
    if (!artifact || artifact.removed_at) return null
    return (await authorize(c, "read", artifact)) ? artifact : null
  }

  /**
   * The artifact a valid `?t=` names, or null. Three things must agree, and each is a way the
   * grant could otherwise widen:
   *
   *   - the signature verifies against THIS instance's secret, in the og-token domain, unexpired
   *   - the artifact it names is the one `:ref` asked for — otherwise a token minted for a doc
   *     someone may read would spend on any other doc's image
   *   - the version it names is still the CURRENT one — so the token follows a snapshot, not the
   *     document, and a publish since retires it
   *
   * Absent secret ⇒ null: a deployment with no signing key cannot have minted one, so anything
   * presented is forged.
   */
  const ogTokenArtifact = async (c: Context): Promise<ArtifactRecord | null> => {
    const token = c.req.query("t")
    if (!token || !ctx.deps.encryptionKey) return null
    const claim = await verifyOgToken(ctx.deps.encryptionKey, token, Date.now())
    if (!claim) return null
    const ref = c.req.param("ref")
    if (!ref) return null
    let artifact: ArtifactRecord | null = null
    for (const id of candidateShortIds(ref)) {
      artifact = await meta.getByShortId(id)
      if (artifact) break
    }
    if (!artifact || artifact.removed_at) return null
    if (artifact.id !== claim.artifactId) return null
    if (artifact.current_version !== claim.n) return null
    return artifact
  }

  // The OG card image. SVG: zero-dep and identical on Node + Worker. A gated or
  // missing artifact gets a generic locked card (no title leak), still 200 so the
  // unfurl shows something. Cached hard (see the Cache-Control below) — the live
  // version/comment counts on the card are allowed to lag for an unfurl preview.
  app.get("/v1/og/:ref", async (c) => {
    const readableArtifact = await readable(c, c.req.param("ref"))
    // A signed token stands in for the read check for THIS IMAGE ALONE (lib/og-token.ts).
    // It is what lets a Slack unfurl of a workspace-listed doc carry its screenshot: Slack
    // fetches preview images anonymously, so without it the picture on the cards people paste
    // most would be the title-less padlock.
    //
    // Deliberately not a general read: it never reaches `infoFor`, so a holder gets the
    // rendered image and never a title, a description or a comment count. And it is spent only
    // on the version it names — a doc republished since is a miss, and the token quietly ages
    // into a locked card rather than following the document.
    const tokened = readableArtifact ? null : await ogTokenArtifact(c)
    const artifact = readableArtifact ?? tokened
    // readable() enforces visibility: a gated artifact for an anonymous crawler returns null
    // and never reaches the PNG branch, so a private artifact can never leak its screenshot.
    if (artifact) {
      const v = await meta.getVersion(artifact.id, artifact.current_version)
      if (v?.preview_status === "ready" && v.preview_key) {
        const png = await blobs.get(v.preview_key)
        // Unlike the SVG fallback (title-less when gated, so always shareable), this
        // branch only runs for a reader who passed readable() — which for an artifact
        // with no world link (or a locked one) means an authorized member. Their
        // screenshot must never land in a shared cache; keep it browser-only there
        // (max-age so the library card <img> stays cached across renders).
        //
        // A TOKENED fetch is the exception, and cacheable publicly for the reason capability
        // URLs generally are: the credential is IN the URL, so a shared cache keyed on the
        // full URL can only ever hand the bytes back to someone who already presented the
        // token. Slack's image proxy caching this is the point, not a leak.
        if (png)
          return c.body(toBody(png), 200, {
            "Content-Type": "image/png",
            "Cache-Control": tokened
              ? "public, max-age=86400, stale-while-revalidate=604800"
              : cacheFor(artifact, "public, max-age=86400, stale-while-revalidate=604800", 3600),
            "X-Content-Type-Options": "nosniff",
            // Slack REQUIRES this on anything it is handed as a preview image; without it the
            // card's picture simply does not appear. See SLACK_PREVIEW_ORIGIN.
            "Access-Control-Allow-Origin": SLACK_PREVIEW_ORIGIN,
          })
      }
    }
    // FALLS THROUGH on purpose when the token is absent, expired, forged or names a version
    // that is no longer current — to the same anonymous card this endpoint has always served.
    // That is what makes a long token life affordable: the worst an expiry can do is put back
    // the behaviour that predates it. Never a broken image, never an error.
    //
    // `readableArtifact`, NOT `artifact`: the token buys the rendered image and nothing else,
    // and this branch reveals the title, description and counts. A tokened caller whose PNG
    // was missing must land on the generic card exactly as an anonymous one does — otherwise
    // the narrow grant widens into a metadata read the moment a render is pending or failed.
    const svg = readableArtifact
      ? // `summary: null` deliberately: the card renders its description as ONE unwrapped
        // <text> line at 28px, sized for the ~50-character inventory line. A 200-character
        // generated summary would run off the canvas. The image travels beside an
        // og:description that already carries the summary, so nothing is lost by keeping the
        // picture on the spec line.
        ogCardSvg({ ...(await infoFor(readableArtifact)), summary: null, reveal: true })
      : ogCardSvg({
          title: "",
          kindLabel: "Document",
          versionCount: 0,
          commentCount: 0,
          reveal: false,
        })
    return c.body(svg, 200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      // Cache an ANONYMOUS card hard: 1 day fresh + a week of serve-stale-while-revalidate
      // keeps regenerations rare while it still refreshes in the background, and the live
      // version/comment counts may lag a day on an unfurl. A gated artifact reached this
      // branch only because the CALLER could read it, so its revealed card (title, counts,
      // slot figures) is browser-private — see cacheFor.
      "Cache-Control": cacheFor(
        readableArtifact,
        "public, max-age=86400, stale-while-revalidate=604800",
        3600,
      ),
      "X-Content-Type-Options": "nosniff",
      // Same header on the fallback: this URL is what a public artifact's card points at, and it
      // lands here whenever that artifact's render is still pending.
      "Access-Control-Allow-Origin": SLACK_PREVIEW_ORIGIN,
    })
  })

  // Everything a profile unfurl needs, gathered from the public profile + its stats.
  // Null when the handle isn't claimed (the caller renders a generic card).
  const profileCardFor = async (handle: string): Promise<ProfileCard | null> => {
    const p = await meta.getUserByUsername(normalizeUsername(handle))
    if (!p) return null
    const ghIds = await meta.githubIdsForUser(p.id)
    // Public-only counts here (no viewer) — an unfurl must never reflect private work.
    const [works, followers] = await Promise.all([
      meta.countUserWorks(p.id, ghIds, {}),
      meta.countFollowers(p.id),
    ])
    return {
      username: p.username,
      name: p.name,
      profession: p.profession ?? null,
      works,
      followers,
    }
  }

  // The profile OG card image (SVG, 1200x630). Anonymous-readable; a missing handle gets
  // a generic Derive card (still 200 so the unfurl shows something). Cached hard.
  app.get("/v1/og/users/:handle", async (c) => {
    const card = await profileCardFor(c.req.param("handle"))
    const svg = ogProfileCardSvg(
      card ?? {
        username: c.req.param("handle"),
        name: null,
        profession: null,
        works: 0,
        followers: 0,
      },
    )
    return c.body(svg, 200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      "X-Content-Type-Options": "nosniff",
    })
  })

  // oEmbed (https://oembed.com): consumers POST our discovered endpoint with the
  // artifact `url`. Only JSON is implemented. Private/missing → 404, per spec.
  app.get("/v1/oembed", async (c) => {
    const url = c.req.query("url")
    const format = c.req.query("format") ?? "json"
    if (format !== "json") return fail(c, 501, "only json oembed is supported")
    if (!url) return fail(c, 400, "url is required")
    let ref: string
    try {
      const path = new URL(url).pathname
      const m = path.match(/^\/artifacts\/([^/]+)$/)
      if (!m?.[1]) return fail(c, 404, "not an artifact url")
      ref = decodeURIComponent(m[1])
    } catch {
      return fail(c, 400, "invalid url")
    }
    const artifact = await readable(c, ref)
    if (!artifact) return fail(c, 404, "not found")
    return c.json(oembedResponse(await infoFor(artifact), baseUrl), 200, {
      "Cache-Control": cacheFor(artifact, "public, max-age=600"),
    })
  })

  // The embeddable view: the live artifact full-bleed in a sandboxed iframe, with a
  // small "Derive" plaque set into the frame's corner linking back to the artifact
  // page. Frameable by design — no X-Frame-Options — so external sites can drop it
  // in. `?chrome=none` drops the plaque and border too and serves just the sandboxed
  // iframe, for host pages that draw their own frame and attribution.
  app.get("/v1/embed/:ref", async (c) => {
    const ref = c.req.param("ref")
    const artifact = await readable(c, ref)
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": cacheFor(artifact, "public, max-age=600"),
      // Explicitly allow embedding anywhere; this card is meant to be iframed.
      "Content-Security-Policy": "frame-ancestors *",
    }
    if (!artifact) return c.body(embedShell(null), 200, headers)
    const info = await infoFor(artifact)
    const src = `${rawBase}/raw/${artifact.short_id}/v/${artifact.current_version}/`
    // White-label workspaces lose the plaque and may go fully bare (?chrome=none);
    // for everyone else the bare frame is ignored — the mark is the free tier's rent.
    // Effective white-label also requires entitlement (beta, or an active
    // subscription) — the toggle alone isn't enough once billing is enforced.
    const whiteLabel = await effectiveWhiteLabel(artifact.org_id)
    const shell =
      whiteLabel && c.req.query("chrome") === "none"
        ? bareShell({ info, src })
        : embedShell({ info, src, plaque: !whiteLabel })
    return c.body(shell, 200, headers)
  })

  // Server-rendered share URL: the SPA shell with per-artifact unfurl meta injected
  // into <head> for crawlers. Humans still get the SPA (the meta is inert). The shell
  // comes from `shell` (Node, read at boot) or `shellFetch` (the edge Worker, from its
  // ASSETS binding). Mounted whenever either is present; the path is worker-first so
  // the Worker reaches this handler instead of serving the raw static shell.
  const getShell = async (): Promise<string | null> =>
    ctx.deps.shell ?? (ctx.deps.shellFetch ? await ctx.deps.shellFetch() : null)

  // A request that names text/markdown in Accept (with nonzero q) gets the markdown
  // projection instead of the shell. Browsers never send it in a navigation; Claude-
  // family agent fetchers send "text/markdown, text/html, */*" on every request.
  // Order and q-weights beyond the q=0 refusal are deliberately not compared: naming
  // the type at all is a signal only a markdown-capable client emits.
  const acceptsMarkdown = (accept: string | undefined): boolean =>
    !!accept?.split(",").some((part) => {
      const [type, ...params] = part.trim().split(";")
      if (type?.trim().toLowerCase() !== "text/markdown") return false
      const q = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith("q="))
      return !q || Number.parseFloat(q.slice(2)) > 0
    })

  // The version exists but its stored bytes don't: a server-side 500, never to be
  // dressed up as "private" — the content API draws the same line ("blob missing").
  const GONE = Symbol("blob missing")

  // The markdown projection of one version — the same rendering the content API's
  // `?format=markdown` serves. `null` = no such version (a caller-side 404). A
  // bundle converts by its ENTRY's own type — pickBundleEntry prefers
  // SKILL.md/README.md over non-root HTML, so a skill's markdown entry must pass
  // through verbatim, not through the HTML converter.
  const markdownOf = async (
    artifactId: string,
    v: number,
  ): Promise<string | null | typeof GONE> => {
    const version = await meta.getVersion(artifactId, v)
    if (!version) return null
    if (!isBundleContentType(version.content_type)) {
      const src = await sourceText(version)
      if (src === null) return GONE
      return elideDataUris(toMarkdown(src, version.content_type))
    }
    const manifest = await manifestOf(blobs, version)
    const entry = manifest?.files[manifest.entry]
    const bytes = entry ? await blobs.get(entry.key) : null
    if (!entry || !bytes) return GONE
    return elideDataUris(toMarkdown(new TextDecoder().decode(bytes), entry.type))
  }

  // The markdown surface's error body: one line, never the app shell (a markdown-
  // preferring client can do nothing with 20KB of chrome) and never a title — the
  // same no-leak rule the shell branch's generic 404 draws.
  const markdownNotFound = (c: Context) => {
    c.header("Vary", "Accept")
    c.header("X-Robots-Tag", "noindex")
    // Never let a shared cache pin this 404 heuristically and starve a member who
    // could read the artifact a moment later.
    c.header("Cache-Control", "no-store")
    c.header("Content-Type", "text/markdown; charset=utf-8")
    return c.body("Not found — or this artifact is private.\n", 404)
  }

  if (ctx.deps.shell || ctx.deps.shellFetch)
    // Deliberately dynamic: readability, takedown state, status, and unfurl metadata
    // can differ by artifact and request. Signup attribution is carried explicitly by
    // CTA URLs, so this response no longer sets or depends on a tracking cookie.
    app.get("/artifacts/:ref", async (c) => {
      const rawRef = c.req.param("ref")
      // `/artifacts/<ref>.md` is the explicit markdown URL. Unambiguous: slugs and
      // short ids come out of slugify/newShortId, which never emit a dot.
      const mdSuffix = rawRef.endsWith(".md")
      const ref = mdSuffix ? rawRef.slice(0, -".md".length) : rawRef
      const wantsMd = mdSuffix || acceptsMarkdown(c.req.header("Accept"))
      const artifact = await readable(c, ref)
      // Missing, gated, and taken-down artifacts still hydrate the SPA so a human
      // gets its access/tombstone state, but carry a real 404 plus noindex so crawlers
      // do not treat the generic application shell as a page.
      if (!artifact || artifact.removed_at) {
        if (wantsMd) return markdownNotFound(c)
        const shell = await getShell()
        if (!shell) return c.notFound()
        // Two representations live at this URL now, 404s included.
        c.header("Vary", "Accept")
        return c.html(setRobotsMeta(shell, "noindex,nofollow"), 404)
      }
      // Canonicalise any non-canonical ref (bare id, stale name, legacy order) to
      // /artifacts/<name>-<shortId> so the browser/crawler holds the readable URL. 302 (not
      // 301) so a later rename re-canonicalises instead of being cached. Only ever for an
      // artifact the actor may read (readable() already authorised), so a gated title can't
      // leak via the redirect. Preserves the @vN suffix, the .md suffix and the query string.
      const { version } = parseRef(ref)
      const canonical = version ? `${refFor(artifact)}@v${version}` : refFor(artifact)
      if (ref !== canonical)
        return c.redirect(
          `/artifacts/${canonical}${mdSuffix ? ".md" : ""}${new URL(c.req.url).search}`,
          302,
        )
      const indexable =
        artifact.listed === "public" &&
        artifact.link_role !== "none" &&
        !artifact.password_hash &&
        !artifact.expires_at
      if (wantsMd) {
        // The expiry fence (see serveArtifact in app.ts): authorize() doesn't know
        // about expiry — only unclaimed drafts carry one, their world link stays
        // viewer, and the sweep is the janitor. Without this an expired-but-unswept
        // draft would serve its whole body here.
        if (artifact.expires_at && artifact.expires_at <= new Date().toISOString())
          return markdownNotFound(c)
        const v = version ?? artifact.current_version
        // The public-history gate (mirrors anonHistoryBlocked in routes/raw.ts):
        // unless the owner opted the page into history, an anonymous caller reads
        // only the CURRENT version — an old version's bytes are as hidden as the
        // workbench that lists them.
        if (
          v !== artifact.current_version &&
          !artifact.public_history &&
          (await actorFor(c, artifact)).kind === "anon"
        )
          return markdownNotFound(c)
        const md = await markdownOf(artifact.id, v)
        if (md === null) return markdownNotFound(c)
        if (md === GONE) return fail(c, 500, "blob missing")
        c.header("Vary", "Accept")
        // A live draft must never be CDN-cacheable (same rule as serveArtifact):
        // its viewer link would earn a shared cache entry that outlives the sweep.
        // And only the .md URL may cache SHARED: the negotiated response lives at
        // the page URL, where nothing but Vary separates it from the HTML — and
        // several major CDNs ignore Vary: Accept, which would hand this markdown
        // to every browser behind them for 10 minutes.
        const shared = mdSuffix ? "public, max-age=600" : "private, max-age=600"
        c.header("Cache-Control", artifact.expires_at ? "no-store" : cacheFor(artifact, shared))
        c.header("X-Content-Type-Options", "nosniff")
        c.header("X-Derive-Version", String(v))
        // The HTML page stays the canonical form of this document; the projection
        // also self-noindexes when the page does (unlisted, password, expiring).
        c.header("Link", `<${baseUrl}/artifacts/${refFor(artifact)}>; rel="canonical"`)
        if (!indexable) c.header("X-Robots-Tag", "noindex")
        c.header("Content-Type", "text/markdown; charset=utf-8")
        return c.body(md)
      }
      const shell = await getShell()
      if (!shell) return c.notFound()
      const governedShell = setRobotsMeta(shell, indexable ? "index,follow" : "noindex,nofollow")
      const info = await infoFor(artifact)
      c.header("Vary", "Accept")
      // Same cache line every infoFor sibling draws (see cacheFor): the injected
      // meta and title are built for a caller who cleared readable(), so a gated
      // artifact's shell must never land in a shared cache.
      c.header(
        "Cache-Control",
        artifact.expires_at ? "no-store" : cacheFor(artifact, "public, max-age=600"),
      )
      c.header("Link", `<${info.markdownUrl}>; rel="alternate"; type="text/markdown"`)
      return c.html(
        injectHead(setTitle(governedShell, `${info.title} · Derive`), unfurlMetaTags(info)),
      )
    })
  // Server-rendered profile URL: the SPA shell with profile OG/Twitter meta injected for
  // crawlers (which don't run JS). Humans get the SPA as usual (the meta is inert). Only
  // public profile fields go into the head; an unclaimed handle serves the bare shell.
  if (ctx.deps.shell || ctx.deps.shellFetch)
    app.get("/users/:handle", async (c) => {
      const shell = await getShell()
      if (!shell) return c.notFound()
      const card = await profileCardFor(c.req.param("handle"))
      if (!card) return c.html(setRobotsMeta(shell, "noindex,nofollow"), 404)
      return c.html(
        injectHead(
          setRobotsMeta(shell, "index,follow"),
          profileMetaTags({
            username: card.username,
            name: card.name,
            description: profileSummary(card),
            pageUrl: `${baseUrl}/users/${card.username}`,
            imageUrl: `${baseUrl}/v1/og/users/${card.username}`,
          }),
        ),
      )
    })
  // A copy-pasted share link with a trailing slash ("/artifacts/slug-id/") would otherwise
  // 404; canonicalize it to the no-slash form.
  app.get("/artifacts/:ref/", (c) => c.redirect(`/artifacts/${c.req.param("ref")}`, 301))

  return app
}

/**
 * The embeddable document: the artifact full-bleed in a sandboxed iframe, with a
 * plaque set into the frame's bottom-right corner — a "Made on Derive" link (to the
 * artifact page; `?ref=embed` for analytics URLs, `&src=embed_badge` so the capture
 * middleware attributes the arrival to this surface) beside an info button whose
 * hover/focus reveals a one-line "what is Derive" tooltip. The shell follows the
 * viewer's light/dark scheme with the app's own tokens; the plaque is frosted so it
 * holds over any artifact content. `null` = a private/unavailable placeholder.
 */
const embedShell = (data: { info: UnfurlInfo; src: string; plaque?: boolean } | null): string => {
  const css =
    ":root{color-scheme:light dark;--canvas:#0a0b0d;--frame:#23252b;--chip:#101216;--tx:#969aa2;--ink:#f3f4f6}" +
    "@media (prefers-color-scheme: light){:root{--canvas:#f7f8fa;--frame:#e5e7eb;--chip:#ffffff;--tx:#5c616b;--ink:#14161a}}" +
    "*{box-sizing:border-box}html,body{height:100%}" +
    "body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--canvas);color:var(--ink)}" +
    ".c{position:relative;height:100%;border:1px solid var(--frame);border-radius:8px;overflow:hidden;background:var(--canvas)}" +
    "iframe{width:100%;height:100%;border:0;display:block;background:var(--canvas)}" +
    // The plaque: a link half ("Made on Derive") + an info button, fused into the
    // frame's bottom-right corner as one unit.
    ".p{position:absolute;right:0;bottom:0;display:flex;align-items:stretch;background:var(--chip);" +
    "border-top:1px solid var(--frame);border-left:1px solid var(--frame);border-radius:6px 0 7px 0;" +
    "animation:bfade .4s ease-out .6s both}" +
    // Frosted plaque: an 80% theme tint over a blur of whatever content sits beneath.
    // Legibility comes from the tint (never from the unknown backdrop); the blur lets
    // the chip pick up a hint of the artifact's color so it harmonizes instead of
    // clashing. Solid --chip above is the graceful fallback.
    "@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){" +
    ".p{background:color-mix(in srgb,var(--chip) 80%,transparent);" +
    "-webkit-backdrop-filter:blur(22px) saturate(1.5);backdrop-filter:blur(22px) saturate(1.5)}}" +
    "@keyframes bfade{from{opacity:0}to{opacity:1}}" +
    "@media (prefers-reduced-motion:reduce){.p{animation:none}.tip{transition:none}}" +
    ".b{display:flex;align-items:center;gap:7px;padding:7px 11px 7px 10px;border-radius:6px 0 0 0;" +
    "color:var(--tx);text-decoration:none;font-size:11.5px;font-weight:600;letter-spacing:.02em;line-height:1;" +
    "transition:color .18s ease-out,background .18s ease-out}" +
    ".b:hover{background:var(--ink);color:var(--canvas)}" +
    ".b:focus-visible{outline:1px solid var(--ink);outline-offset:-3px}" +
    ".m{height:14px;width:auto;flex:0 0 auto}" +
    // Info button: a sibling of the link, not nested, so the two are distinct targets —
    // the link navigates, the button only reveals the tooltip (hover, keyboard focus,
    // and touch tap all trigger it, no JS).
    ".i{display:flex;align-items:center;justify-content:center;padding:0 9px;background:transparent;" +
    "border:0;border-left:1px solid var(--frame);border-radius:0 0 7px 0;color:var(--tx);cursor:pointer;" +
    "-webkit-appearance:none;appearance:none;transition:color .18s ease-out,background .18s ease-out}" +
    ".i:hover{background:var(--ink);color:var(--canvas)}" +
    ".i:focus-visible{outline:1px solid var(--ink);outline-offset:-3px}" +
    ".i svg{width:14px;height:14px;display:block}" +
    ".tip{position:absolute;right:0;bottom:calc(100% + 8px);width:min(272px,72vw);" +
    "padding:11px 13px;background:var(--chip);border:1px solid var(--frame);border-radius:8px;" +
    "box-shadow:0 8px 24px -8px rgba(0,0,0,.5);color:var(--tx);" +
    "font-size:11.5px;font-weight:450;letter-spacing:0;line-height:1.55;text-align:left;" +
    "opacity:0;transform:translateY(4px);pointer-events:none;" +
    "transition:opacity .16s ease-out,transform .16s ease-out}" +
    ".tip b{color:var(--ink);font-weight:650}" +
    ".i:hover ~ .tip,.i:focus ~ .tip{opacity:1;transform:none}" +
    ".empty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--tx);font-size:13.5px;text-align:center;padding:24px}"
  // The Derive mark (packages/web Logo), monochrome via currentColor so it shifts with
  // the plaque text on hover. viewBox is the tall brand ratio; height-locked, width auto.
  const mark =
    '<svg class="m" viewBox="0 0 620 824" fill="none" aria-hidden="true"><path d="M404.01 217.285L271.071 140.531L404.01 63.7773L536.95 140.531L404.01 217.285ZM343.201 686.623L343.063 686.703C298.797 712.261 243.462 680.313 243.462 629.197C243.462 605.464 256.131 583.533 276.691 571.677L348.791 530.099V466.183L215.853 542.936L83.0526 466.183L243.462 373.692V188.295L376.401 265.049V629.119C376.401 652.841 363.746 674.761 343.201 686.623ZM188.243 744.209L55.4433 667.455V514.085L188.243 590.839V744.209ZM404.01 0L188.243 124.517V341.803L0.224609 450.308V699.344L215.853 824L431.619 699.344V303.385C431.619 279.663 444.275 257.743 464.819 245.88L464.957 245.801C509.225 220.243 564.559 252.189 564.559 303.305V303.444C564.559 327.179 551.89 349.108 531.329 360.965L459.229 402.544V466.321L619.777 373.692V124.517L404.01 0Z" fill="currentColor"/></svg>'
  const infoIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v5"/><path d="M12 7.7h.01"/></svg>'
  const tip =
    "<b>Derive</b> is an open home for AI-generated artifacts: publish from a compatible agent, review the work at one durable URL, and keep every version."
  // White-label (plaque:false) keeps the framed shell, just without the mark.
  const plaqueHtml = (d: { info: UnfurlInfo }) =>
    `<div class="p"><a class="b" href="${escapeHtml(`${d.info.pageUrl}?ref=embed&src=embed_badge`)}" target="_blank" rel="noopener" title="View on Derive">${mark}Made on Derive</a><button type="button" class="i" aria-label="What is Derive?" aria-describedby="dtip">${infoIcon}</button><span class="tip" id="dtip" role="tooltip">${tip}</span></div>`
  const body = data
    ? `<div class="c"><iframe src="${escapeHtml(data.src)}" sandbox="allow-scripts allow-forms allow-popups allow-modals" title="${escapeHtml(data.info.title)}"></iframe>${data.plaque !== false ? plaqueHtml(data) : ""}</div>`
    : `<div class="empty">This artifact is private or no longer available.<br>Open it on Derive to request access.</div>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${data ? escapeHtml(data.info.title) : "Derive"}</title><style>${css}</style></head><body>${body}</body></html>`
}

/**
 * `?chrome=none`: no plaque, no border — just the sandboxed iframe, full-bleed, for
 * host pages that draw their own frame and attribution. Scheme-aware canvas only.
 */
const bareShell = (data: { info: UnfurlInfo; src: string }): string => {
  const css =
    ":root{color-scheme:light dark;--canvas:#0a0b0d}" +
    "@media (prefers-color-scheme: light){:root{--canvas:#f7f8fa}}" +
    "html,body{height:100%}body{margin:0;background:var(--canvas)}" +
    "iframe{width:100%;height:100%;border:0;display:block;background:var(--canvas)}"
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(data.info.title)}</title><style>${css}</style></head><body><iframe src="${escapeHtml(data.src)}" sandbox="allow-scripts allow-forms allow-popups allow-modals" title="${escapeHtml(data.info.title)}"></iframe></body></html>`
}
