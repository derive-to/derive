import {
  type ArtifactRecord,
  artifactUrl,
  candidateShortIds,
  escapeHtml,
  factSummary,
  injectHead,
  kindLabel,
  normalizeUsername,
  oembedResponse,
  ogCardSvg,
  ogProfileCardSvg,
  type ProfileCard,
  parseRef,
  profileMetaTags,
  profileSummary,
  refFor,
  type UnfurlInfo,
  unfurlMetaTags,
} from "@derive/core"
import { type Context, Hono } from "hono"
import type { AppContext } from "../context"
import { fail, toBody } from "../lib/http"

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
  const { meta, authorize, blobs } = ctx
  const baseUrl = ctx.deps.baseUrl
  const rawBase = ctx.deps.sandboxOrigin ?? baseUrl
  const app = new Hono()

  // Everything an unfurl/embed surface needs for one artifact, plus the absolute
  // URLs of the sibling endpoints. Counts come from the live version + comment list.
  const infoFor = async (artifact: ArtifactRecord): Promise<UnfurlInfo> => {
    const [versions, comments, version, facts] = await Promise.all([
      meta.listVersions(artifact.id),
      meta.listComments(artifact.id),
      meta.getVersion(artifact.id, artifact.current_version),
      // Best-effort: a share card must never fail to render because a fact read hiccuped.
      meta.getVersionData(artifact.id, artifact.current_version).catch(() => []),
    ])
    const ref = artifactUrl(baseUrl, artifact).slice(`${baseUrl}/artifacts/`.length)
    return {
      title: artifact.title ?? "Untitled",
      kindLabel: kindLabel(version?.content_type, artifact.kind === "bundle"),
      versionCount: versions.length,
      commentCount: comments.length,
      // The reward for publishing a fact: the shared link carries its own numbers.
      dataSummary: factSummary(facts),
      pageUrl: artifactUrl(baseUrl, artifact),
      imageUrl: `${baseUrl}/v1/og/${artifact.short_id}`,
      oembedUrl: `${baseUrl}/v1/oembed?url=${encodeURIComponent(artifactUrl(baseUrl, artifact))}`,
      embedUrl: `${baseUrl}/v1/embed/${ref}`,
    }
  }

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
    let artifact: ArtifactRecord | null = null
    for (const id of candidateShortIds(ref)) {
      artifact = await meta.getByShortId(id)
      if (artifact) break
    }
    if (!artifact || artifact.removed_at) return null
    return (await authorize(c, "read", artifact)) ? artifact : null
  }

  // The OG card image. SVG: zero-dep and identical on Node + Worker. A gated or
  // missing artifact gets a generic locked card (no title leak), still 200 so the
  // unfurl shows something. Cached hard (see the Cache-Control below) — the live
  // version/comment counts on the card are allowed to lag for an unfurl preview.
  app.get("/v1/og/:ref", async (c) => {
    const artifact = await readable(c, c.req.param("ref"))
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
        if (png)
          return c.body(toBody(png), 200, {
            "Content-Type": "image/png",
            "Cache-Control": cacheFor(
              artifact,
              "public, max-age=86400, stale-while-revalidate=604800",
              3600,
            ),
            "X-Content-Type-Options": "nosniff",
          })
      }
    }
    const svg = artifact
      ? ogCardSvg({ ...(await infoFor(artifact)), reveal: true })
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
        artifact,
        "public, max-age=86400, stale-while-revalidate=604800",
        3600,
      ),
      "X-Content-Type-Options": "nosniff",
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
    const { whiteLabel } = await meta.getOrgSettings(artifact.org_id)
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
  if (ctx.deps.shell || ctx.deps.shellFetch)
    app.get("/artifacts/:ref", async (c) => {
      const shell = await getShell()
      if (!shell) return c.notFound()
      const ref = c.req.param("ref")
      const artifact = await readable(c, ref)
      // A taken-down artifact serves the bare shell (the SPA shows a tombstone) and
      // injects NO unfurl meta, so the removed title doesn't live on for crawlers.
      if (!artifact || artifact.removed_at) return c.html(shell)
      // Canonicalise any non-canonical ref (bare id, stale name, legacy order) to
      // /artifacts/<name>-<shortId> so the browser/crawler holds the readable URL. 302 (not 301)
      // so a later rename re-canonicalises instead of being cached. Only ever for an
      // artifact the actor may read (readable() already authorised), so a gated title
      // can't leak via the redirect. Preserves the @vN suffix and the query string.
      const { version } = parseRef(ref)
      const canonical = version ? `${refFor(artifact)}@v${version}` : refFor(artifact)
      if (ref !== canonical)
        return c.redirect(`/artifacts/${canonical}${new URL(c.req.url).search}`, 302)
      return c.html(injectHead(shell, unfurlMetaTags(await infoFor(artifact))))
    })
  // Server-rendered profile URL: the SPA shell with profile OG/Twitter meta injected for
  // crawlers (which don't run JS). Humans get the SPA as usual (the meta is inert). Only
  // public profile fields go into the head; an unclaimed handle serves the bare shell.
  if (ctx.deps.shell || ctx.deps.shellFetch)
    app.get("/users/:handle", async (c) => {
      const shell = await getShell()
      if (!shell) return c.notFound()
      const card = await profileCardFor(c.req.param("handle"))
      if (!card) return c.html(shell)
      return c.html(
        injectHead(
          shell,
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
    "<b>Derive</b> is the home for AI artifacts: publish from any agent, review together, and own the result at a permanent versioned URL."
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
