import {
  type ArtifactRecord,
  artifactUrl,
  candidateShortIds,
  escapeHtml,
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
    const [versions, comments, version] = await Promise.all([
      meta.listVersions(artifact.id),
      meta.listComments(artifact.id),
      meta.getVersion(artifact.id, artifact.current_version),
    ])
    const ref = artifactUrl(baseUrl, artifact).slice(`${baseUrl}/artifacts/`.length)
    return {
      title: artifact.title ?? "Untitled",
      kindLabel: kindLabel(version?.content_type, artifact.kind === "bundle"),
      versionCount: versions.length,
      commentCount: comments.length,
      pageUrl: artifactUrl(baseUrl, artifact),
      imageUrl: `${baseUrl}/v1/og/${artifact.short_id}`,
      oembedUrl: `${baseUrl}/v1/oembed?url=${encodeURIComponent(artifactUrl(baseUrl, artifact))}`,
      embedUrl: `${baseUrl}/v1/embed/${ref}`,
    }
  }

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
        const gated = artifact.link_role === "none" || !!artifact.password_hash
        if (png)
          return c.body(toBody(png), 200, {
            "Content-Type": "image/png",
            "Cache-Control": gated
              ? "private, max-age=3600"
              : "public, max-age=86400, stale-while-revalidate=604800",
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
      // Cache the thumbnail hard: only anon crawlers hit this (the app never does), and
      // a gated artifact renders a title-less locked card, so there's nothing private to
      // cache at the shared edge. 1 day fresh + a week of serve-stale-while-revalidate
      // keeps regenerations rare while the card still refreshes in the background. The
      // live version/comment counts can lag up to a day here — fine for an unfurl.
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
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
      "Cache-Control": "public, max-age=600",
    })
  })

  // The embeddable view: the live artifact full-bleed in a sandboxed iframe, with one
  // small "Derive" badge overlaid in the corner linking back to the artifact page.
  // Frameable by design — no X-Frame-Options — so external sites can drop it in.
  // `?chrome=none` drops the badge and border too and serves just the sandboxed
  // iframe, for host pages that draw their own frame and attribution.
  app.get("/v1/embed/:ref", async (c) => {
    const ref = c.req.param("ref")
    const artifact = await readable(c, ref)
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=600",
      // Explicitly allow embedding anywhere; this card is meant to be iframed.
      "Content-Security-Policy": "frame-ancestors *",
    }
    if (!artifact) return c.body(embedShell(null), 200, headers)
    const info = await infoFor(artifact)
    const src = `${rawBase}/raw/${artifact.short_id}/v/${artifact.current_version}/`
    const shell =
      c.req.query("chrome") === "none" ? bareShell({ info, src }) : embedShell({ info, src })
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
 * The embeddable document: the artifact full-bleed in a sandboxed iframe, one small
 * translucent "Derive" badge overlaid bottom-right linking back to the artifact page
 * (its tooltip carries "View on Derive"). `null` = a private/unavailable placeholder.
 */
const embedShell = (data: { info: UnfurlInfo; src: string } | null): string => {
  const css =
    "*{box-sizing:border-box}html,body{height:100%}" +
    "body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0b0d;color:#f3f4f6}" +
    ".c{position:relative;height:100%;border:1px solid #23252b;border-radius:8px;overflow:hidden;background:#0a0b0d}" +
    "iframe{width:100%;height:100%;border:0;display:block;background:#0a0b0d}" +
    ".b{position:absolute;right:10px;bottom:10px;display:flex;align-items:center;gap:7px;" +
    "padding:5px 10px 5px 7px;border:1px solid #23252b;border-radius:6px;" +
    "background:rgba(12,14,17,.86);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);" +
    "box-shadow:inset 0 1px 0 rgba(255,255,255,.045);" +
    "color:#969aa2;text-decoration:none;font-size:11px;font-weight:600;letter-spacing:.02em;line-height:1;" +
    "transition:color .15s ease-out,border-color .15s ease-out;" +
    "animation:bfade .4s ease-out .6s both}" +
    "@keyframes bfade{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:translateY(0)}}" +
    "@media (prefers-reduced-motion:reduce){.b{animation:none}}" +
    ".b:hover{color:#f3f4f6;border-color:#31343c}" +
    ".b:focus-visible{outline:1px solid #f3f4f6;outline-offset:2px}" +
    ".m{width:14px;height:14px;flex:0 0 auto}" +
    ".empty{display:flex;align-items:center;justify-content:center;height:100%;color:#969aa2;font-size:13.5px;text-align:center;padding:24px}"
  const mark =
    '<svg class="m" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#16181d" stroke="#23252b"/><path d="M16 7l7 7v11h-4.6v-6.2h-4.8V25H9V14l7-7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>'
  const body = data
    ? `<div class="c"><iframe src="${escapeHtml(data.src)}" sandbox="allow-scripts allow-forms allow-popups allow-modals" title="${escapeHtml(data.info.title)}"></iframe><a class="b" href="${escapeHtml(data.info.pageUrl)}" target="_blank" rel="noopener" title="View on Derive">${mark}Derive</a></div>`
    : `<div class="empty">This artifact is private or no longer available.<br>Open it on Derive to request access.</div>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${data ? escapeHtml(data.info.title) : "Derive"}</title><style>${css}</style></head><body>${body}</body></html>`
}

/**
 * `?chrome=none`: no badge, no border — just the sandboxed iframe, full-bleed, for
 * host pages that draw their own frame and attribution.
 */
const bareShell = (data: { info: UnfurlInfo; src: string }): string => {
  const css =
    "html,body{height:100%}body{margin:0;background:#0a0b0d}" +
    "iframe{width:100%;height:100%;border:0;display:block;background:#0a0b0d}"
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(data.info.title)}</title><style>${css}</style></head><body><iframe src="${escapeHtml(data.src)}" sandbox="allow-scripts allow-forms allow-popups allow-modals" title="${escapeHtml(data.info.title)}"></iframe></body></html>`
}
