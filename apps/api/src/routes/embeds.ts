import {
  type ArtifactRecord,
  artifactUrl,
  escapeHtml,
  injectHead,
  kindLabel,
  oembedResponse,
  ogCardSvg,
  parseRef,
  type UnfurlInfo,
  unfurlDescription,
  unfurlMetaTags,
} from "@dock/core"
import { type Context, Hono } from "hono"
import type { AppContext } from "../context"
import { fail } from "../lib/http"

/**
 * Unfurl + embed surface. Turns a `/a/:ref` share link into a rich card and an
 * embeddable iframe, so a Dock link looks good in Slack / Discord / X / Notion and
 * can be dropped into any page. Three public, anonymous-readable endpoints under
 * `/v1` (worker-first in both runtimes) plus a server-rendered `/a/:ref` that
 * injects OG/Twitter meta into the SPA shell for crawlers (which don't run JS):
 *
 *   GET /v1/og/:ref        the OG card image (SVG, 1200x630)
 *   GET /v1/oembed?url=…   the oEmbed document (rich; a sandboxed iframe)
 *   GET /v1/embed/:ref     the embeddable view (iframe target)
 *   GET /a/:ref            the SPA shell with per-artifact unfurl meta injected
 *
 * Visibility is honored against the *request* actor: a crawler is anonymous, so
 * org/password artifacts never leak a title — they get a generic locked card.
 */
export const embedRoutes = (ctx: AppContext) => {
  const { meta, authorize } = ctx
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
    const ref = artifactUrl(baseUrl, artifact).slice(`${baseUrl}/a/`.length)
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
    const artifact = await meta.getByShortId(parseRef(ref).shortId)
    if (!artifact || artifact.removed_at) return null
    return (await authorize(c, "read", artifact)) ? artifact : null
  }

  // The OG card image. SVG: zero-dep and identical on Node + Worker. A gated or
  // missing artifact gets a generic locked card (no title leak), still 200 so the
  // unfurl shows something. Short cache: the card carries live version/comment counts.
  app.get("/v1/og/:ref", async (c) => {
    const artifact = await readable(c, c.req.param("ref"))
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
      "Cache-Control": "public, max-age=600",
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
      const m = path.match(/^\/a\/([^/]+)$/)
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

  // The embeddable view: a small framed card (title + "View on Dock" + the live
  // artifact in a sandboxed iframe + counts). Frameable by design — no
  // X-Frame-Options — so external sites can drop it in.
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
    return c.body(embedShell({ info, src }), 200, headers)
  })

  // Server-rendered share URL: the SPA shell with per-artifact unfurl meta injected
  // into <head> for crawlers. Humans still get the SPA (the meta is inert). The shell
  // comes from `shell` (Node, read at boot) or `shellFetch` (the edge Worker, from its
  // ASSETS binding). Mounted whenever either is present; the path is worker-first so
  // the Worker reaches this handler instead of serving the raw static shell.
  const getShell = async (): Promise<string | null> =>
    ctx.deps.shell ?? (ctx.deps.shellFetch ? await ctx.deps.shellFetch() : null)
  if (ctx.deps.shell || ctx.deps.shellFetch)
    app.get("/a/:ref", async (c) => {
      const shell = await getShell()
      if (!shell) return c.notFound()
      const artifact = await readable(c, c.req.param("ref"))
      // A taken-down artifact serves the bare shell (the SPA shows a tombstone) and
      // injects NO unfurl meta, so the removed title doesn't live on for crawlers.
      if (!artifact || artifact.removed_at) return c.html(shell)
      return c.html(injectHead(shell, unfurlMetaTags(await infoFor(artifact))))
    })
    // A copy-pasted share link with a trailing slash ("/a/slug-id/") would otherwise
    // 404; canonicalize it to the no-slash form.
    app.get("/a/:ref/", (c) => c.redirect(`/a/${c.req.param("ref")}`, 301))

  return app
}

/** The embeddable card document. `null` = a private/unavailable placeholder. */
const embedShell = (data: { info: UnfurlInfo; src: string } | null): string => {
  const css =
    "*{box-sizing:border-box}body{margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f0e3;color:#2a2540}" +
    ".c{display:flex;flex-direction:column;height:100vh;border:1px solid #e4dcc9;border-radius:12px;overflow:hidden;background:#fdf8ec}" +
    ".h{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #eee7d6;font-size:14px}" +
    ".h .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}" +
    ".h a{margin-left:auto;color:#4f447e;text-decoration:none;font-size:12.5px;font-weight:600;white-space:nowrap}" +
    ".h a:hover{text-decoration:underline}" +
    ".m{width:18px;height:18px;flex:0 0 auto}" +
    "iframe{flex:1;width:100%;border:0;background:#fff}" +
    ".f{padding:7px 14px;border-top:1px solid #eee7d6;font:12px ui-monospace,Menlo,monospace;color:#6b6680}" +
    ".empty{display:flex;align-items:center;justify-content:center;height:100vh;color:#6b6680;font-size:14px;text-align:center;padding:24px}"
  const mark =
    '<svg class="m" viewBox="0 0 32 32" fill="none"><rect x="1" y="1" width="30" height="30" rx="8" fill="#2a2540"/><path d="M16 7l7 7v11h-4.6v-6.2h-4.8V25H9V14l7-7z" fill="none" stroke="#8a7dc0" stroke-width="1.7" stroke-linejoin="round"/></svg>'
  const body = data
    ? `<div class="c"><div class="h">${mark}<span class="t">${escapeHtml(data.info.title)}</span><a href="${escapeHtml(data.info.pageUrl)}" target="_blank" rel="noopener">View on Dock ↗</a></div><iframe src="${escapeHtml(data.src)}" sandbox="allow-scripts allow-forms allow-popups allow-modals" title="${escapeHtml(data.info.title)}"></iframe><div class="f">${escapeHtml(unfurlDescription(data.info))}</div></div>`
    : `<div class="empty">This artifact is private or no longer available.<br>Open it on Dock to request access.</div>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${data ? escapeHtml(data.info.title) : "Dock"}</title><style>${css}</style></head><body>${body}</body></html>`
}
