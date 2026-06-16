import { escapeHtml } from "./md"

/** A short, kind-aware label for an artifact, used on cards and in descriptions. */
export const kindLabel = (contentType: string | null | undefined, isBundle: boolean): string => {
  if (isBundle) return "Site"
  if (contentType === "text/markdown") return "Markdown"
  if (contentType === "text/x-dock-deck") return "Deck"
  if (contentType?.startsWith("text/html")) return "HTML"
  return "Document"
}

/** Everything an unfurl card / oEmbed / meta block needs about one artifact. */
export interface UnfurlInfo {
  title: string
  kindLabel: string
  versionCount: number
  commentCount: number
  /** Canonical share URL (`/a/:ref`). */
  pageUrl: string
  /** Absolute OG image URL (`/v1/og/:ref`). */
  imageUrl: string
  /** Absolute oEmbed endpoint URL (`/v1/oembed?url=...`). */
  oembedUrl: string
  /** Absolute embeddable-view URL (`/v1/embed/:ref`). */
  embedUrl: string
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`

/** One-line human description: "HTML · 3 versions · 2 comments · on Dock". */
export const unfurlDescription = (i: {
  kindLabel: string
  versionCount: number
  commentCount: number
}): string =>
  `${i.kindLabel} · ${plural(i.versionCount, "version")} · ${plural(i.commentCount, "comment")} · on Dock`

/**
 * OpenGraph + Twitter + oEmbed-discovery `<head>` tags for an artifact. Crawlers
 * (Slack, Discord, X, Facebook, LinkedIn) don't run JS, so these must be present
 * in the server-rendered HTML at the share URL. All values are HTML-escaped.
 */
export const unfurlMetaTags = (i: UnfurlInfo): string => {
  const desc = unfurlDescription(i)
  const t = escapeHtml(i.title)
  const d = escapeHtml(desc)
  const url = escapeHtml(i.pageUrl)
  const img = escapeHtml(i.imageUrl)
  const oembed = escapeHtml(i.oembedUrl)
  return [
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="Dock">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${img}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${img}">`,
    `<link rel="alternate" type="application/json+oembed" href="${oembed}" title="${t}">`,
  ].join("\n")
}

/** Insert head HTML just before `</head>` (case-insensitive); prepend if none. */
export const injectHead = (shellHtml: string, headHtml: string): string => {
  const m = shellHtml.match(/<\/head>/i)
  if (!m || m.index === undefined) return `${headHtml}\n${shellHtml}`
  return `${shellHtml.slice(0, m.index)}${headHtml}\n${shellHtml.slice(m.index)}`
}

/**
 * The oEmbed `rich` response (https://oembed.com). `html` is a sandboxed iframe of
 * the embeddable view; consumers (Notion, Slack, Discord) render it inline.
 */
export interface OembedResponse {
  version: "1.0"
  type: "rich"
  provider_name: "Dock"
  provider_url: string
  title: string
  author_name?: string
  thumbnail_url: string
  thumbnail_width: number
  thumbnail_height: number
  html: string
  width: number
  height: number
}

export const EMBED_WIDTH = 600
export const EMBED_HEIGHT = 480

/** A sandboxed iframe snippet pointing at the embeddable view. */
export const embedIframe = (
  embedUrl: string,
  opts: { width?: number | string; height?: number; title: string } = { title: "Dock artifact" },
): string => {
  const w = opts.width ?? "100%"
  const h = opts.height ?? EMBED_HEIGHT
  const width = typeof w === "number" ? String(w) : w
  return `<iframe src="${escapeHtml(embedUrl)}" width="${escapeHtml(width)}" height="${h}" style="border:0;border-radius:12px;max-width:100%" loading="lazy" title="${escapeHtml(opts.title)}" allowfullscreen></iframe>`
}

export const oembedResponse = (i: UnfurlInfo, providerUrl: string): OembedResponse => ({
  version: "1.0",
  type: "rich",
  provider_name: "Dock",
  provider_url: providerUrl,
  title: i.title,
  thumbnail_url: i.imageUrl,
  thumbnail_width: 1200,
  thumbnail_height: 630,
  html: embedIframe(i.embedUrl, { width: EMBED_WIDTH, height: EMBED_HEIGHT, title: i.title }),
  width: EMBED_WIDTH,
  height: EMBED_HEIGHT,
})

// ---- OG card image (SVG) ---------------------------------------------------
// A 1200x630 card in the Dock palette. Rendered as SVG: zero dependencies and
// identical output on Node and the Cloudflare Worker. Discord renders SVG OG
// images directly; on surfaces that prefer raster, og:title/og:description still
// unfurl. Built as a pure function so a future PNG rasterizer (satori/resvg) is a
// drop-in swap behind the same `/v1/og/:ref` route.

const OG_W = 1200
const OG_H = 630

const svgEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Greedy word-wrap into at most `maxLines` lines of ~`maxChars`, ellipsizing. */
const wrapTitle = (title: string, maxChars: number, maxLines: number): string[] => {
  const words = title.trim().split(/\s+/)
  const lines: string[] = []
  let cur = ""
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length <= maxChars) {
      cur = next
    } else {
      if (cur) lines.push(cur)
      cur = w
      if (lines.length === maxLines) break
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur)
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1]
    if (last && (cur !== last || words.join(" ").length > lines.join(" ").length))
      lines[maxLines - 1] = `${last.slice(0, maxChars - 1).trimEnd()}…`
  }
  return lines.length ? lines : ["Untitled"]
}

export interface OgCard {
  title: string
  kindLabel: string
  versionCount: number
  commentCount: number
  /** When false, render a generic locked card that leaks no title (private artifact). */
  reveal?: boolean
}

/** The OG card as a standalone SVG document string. */
export const ogCardSvg = (card: OgCard): string => {
  const reveal = card.reveal !== false
  const title = reveal ? card.title || "Untitled" : "A private artifact"
  const lines = wrapTitle(title, 26, 3)
  const lineH = 78
  const startY = 250 - (lines.length - 1) * (lineH / 2)
  const titleTspans = lines
    .map((ln, idx) => `<tspan x="90" y="${startY + idx * lineH}">${svgEscape(ln)}</tspan>`)
    .join("")
  const meta = reveal ? unfurlDescription(card) : "Open it on Dock to request access"
  const sans = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
  const mono = "'SF Mono', ui-monospace, Menlo, Consolas, monospace"
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}" viewBox="0 0 ${OG_W} ${OG_H}" role="img" aria-label="${svgEscape(title)}">
  <rect width="${OG_W}" height="${OG_H}" fill="#f6f0e3"/>
  <rect x="0" y="0" width="${OG_W}" height="10" fill="#655999"/>
  <g font-family="${mono}" font-size="26" fill="#4f447e" font-weight="600">
    <rect x="90" y="74" width="42" height="42" rx="10" fill="#2a2540"/>
    <path d="M111 84l13 13v18h-8.5v-10.4h-9V115H94v-18z" fill="none" stroke="#8a7dc0" stroke-width="2.6" stroke-linejoin="round"/>
    <text x="150" y="105" letter-spacing="1">DOCK</text>
  </g>
  <text font-family="${sans}" font-size="62" font-weight="700" fill="#2a2540" letter-spacing="-1">${titleTspans}</text>
  <text x="90" y="540" font-family="${mono}" font-size="28" fill="#6b6680">${svgEscape(meta)}</text>
  <text x="${OG_W - 90}" y="105" text-anchor="end" font-family="${mono}" font-size="24" fill="#928da3">dock.build</text>
</svg>`
}
