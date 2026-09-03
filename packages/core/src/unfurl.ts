import { LATEX_CONTENT_TYPE } from "./latex"
import { escapeHtml } from "./md"
import { LATEX_BUNDLE_CONTENT_TYPE, SKILL_CONTENT_TYPE } from "./ports"

/** A short, kind-aware label for an artifact, used on cards and in descriptions. */
export const kindLabel = (contentType: string | null | undefined, isBundle: boolean): string => {
  if (contentType === SKILL_CONTENT_TYPE) return "Skill"
  if (contentType === LATEX_BUNDLE_CONTENT_TYPE) return "LaTeX"
  if (isBundle) return "Site"
  if (contentType === "text/markdown") return "Markdown"
  if (contentType === LATEX_CONTENT_TYPE) return "LaTeX"
  if (contentType === "text/x-derive-deck") return "Deck"
  if (contentType === "text/x-derive-linked-bundle") return "Bundle"
  if (contentType === "text/x-derive-video") return "Video"
  if (contentType?.startsWith("text/html")) return "HTML"
  return "Document"
}

/** Everything an unfurl card / oEmbed / meta block needs about one artifact. */
export interface UnfurlInfo {
  title: string
  kindLabel: string
  versionCount: number
  commentCount: number
  /** Canonical share URL (`/artifacts/:ref`). */
  pageUrl: string
  /** Absolute OG image URL (`/v1/og/:ref`). */
  imageUrl: string
  /** Absolute oEmbed endpoint URL (`/v1/oembed?url=...`). */
  oembedUrl: string
  /** Absolute embeddable-view URL (`/v1/embed/:ref`). */
  embedUrl: string
  /** Absolute markdown-projection URL (`/artifacts/:ref.md`) — the agent-readable
   *  form of the share URL, advertised as a `rel=alternate` link. */
  markdownUrl: string
  /** A card-sized summary of this version's facts (`pass 48 · fail 0`), when it
   *  carries any. Leads the description: the numbers are what a reader scanning a shared
   *  link actually wants, and showing them is what rewards publishing a fact at all. */
  dataSummary?: string | null
  /** What the current version SAYS, generated at publish (apps/api summarizer.ts). Replaces
   *  the inventory tail below when present — an artifact carries no author-written description
   *  anywhere, so without this every surface answers "what is this?" and never "what is it
   *  about?".
   *
   *  UNTRUSTED: derived from document content. Sanitized at write (markup characters stripped),
   *  but any surface interpolating it into markup must still escape — the SVG card and the meta
   *  tags both do. */
  summary?: string | null
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`

/**
 * One-line human description: "HTML · 3 versions · 2 comments · on Derive".
 *
 * When the version carries facts, their summary LEADS: "pass 48 · fail 0 · HTML · 14
 * versions · on Derive". A shared link that shows its own numbers is the whole incentive
 * for emitting a fact, and it costs one line here.
 */
export const unfurlDescription = (i: {
  kindLabel: string
  versionCount: number
  commentCount: number
  dataSummary?: string | null
  summary?: string | null
}): string => {
  // The generated summary REPLACES the inventory tail rather than joining it: it is prose, the
  // tail is a spec line, and a card has one line for whichever is more use to someone deciding
  // whether to open the thing. `dataSummary` still leads either way — an author's own numbers
  // outrank both, which is the incentive the fact grammar exists to pay.
  const tail =
    i.summary ??
    `${i.kindLabel} · ${plural(i.versionCount, "version")} · ${plural(i.commentCount, "comment")} · on Derive`
  return i.dataSummary ? `${i.dataSummary} · ${tail}` : tail
}

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
    `<meta property="og:site_name" content="Derive">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${img}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<link rel="canonical" href="${url}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${img}">`,
    `<link rel="alternate" type="application/json+oembed" href="${oembed}" title="${t}">`,
    `<link rel="alternate" type="text/markdown" href="${escapeHtml(i.markdownUrl)}">`,
  ].join("\n")
}

/** Replace the shell's generic `<title>` with the page's own (escaped); inject if absent. */
export const setTitle = (shellHtml: string, title: string): string => {
  const tag = `<title>${escapeHtml(title)}</title>`
  // Non-greedy to the first close tag keeps the scan linear (see setRobotsMeta).
  const m = shellHtml.match(/<title\b[^>]*>[\s\S]*?<\/title>/i)
  if (!m || m.index === undefined) return injectHead(shellHtml, tag)
  return shellHtml.slice(0, m.index) + tag + shellHtml.slice(m.index + m[0].length)
}

/** Insert head HTML just before `</head>` (case-insensitive); prepend if none. */
export const injectHead = (shellHtml: string, headHtml: string): string => {
  const m = shellHtml.match(/<\/head>/i)
  if (!m || m.index === undefined) return `${headHtml}\n${shellHtml}`
  return `${shellHtml.slice(0, m.index)}${headHtml}\n${shellHtml.slice(m.index)}`
}

/** Replace any shell-level crawler policy with one authoritative robots tag. */
export const setRobotsMeta = (
  shellHtml: string,
  content: "index,follow" | "noindex,nofollow",
): string => {
  // Keep the scan linear on untrusted artifact HTML. A single expression with
  // overlapping `\s*` and `[^>]*` branches can backtrack polynomially on a
  // deliberately long tag. First bound each meta tag, then inspect only that
  // tag for the robots attribute.
  const withoutExisting = shellHtml.replace(/<meta\b[^>]*>/gi, (tag) =>
    /\bname\s*=\s*(?:"robots"|'robots')/i.test(tag) ? "" : tag,
  )
  return injectHead(withoutExisting, `<meta name="robots" content="${content}">`)
}

/**
 * The oEmbed `rich` response (https://oembed.com). `html` is a sandboxed iframe of
 * the embeddable view; consumers (Notion, Slack, Discord) render it inline.
 */
export interface OembedResponse {
  version: "1.0"
  type: "rich"
  provider_name: "Derive"
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
  opts: { width?: number | string; height?: number; title: string } = { title: "Derive artifact" },
): string => {
  const w = opts.width ?? "100%"
  const h = opts.height ?? EMBED_HEIGHT
  const width = typeof w === "number" ? String(w) : w
  return `<iframe src="${escapeHtml(embedUrl)}" width="${escapeHtml(width)}" height="${h}" style="border:0;border-radius:12px;max-width:100%" loading="lazy" title="${escapeHtml(opts.title)}" allowfullscreen></iframe>`
}

export const oembedResponse = (i: UnfurlInfo, providerUrl: string): OembedResponse => ({
  version: "1.0",
  type: "rich",
  provider_name: "Derive",
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
// A 1200x630 card in the Derive palette. Rendered as SVG: zero dependencies and
// identical output on Node and the Cloudflare Worker. Discord renders SVG OG
// images directly; on surfaces that prefer raster, og:title/og:description still
// unfurl. Built as a pure function so a future PNG rasterizer (satori/resvg) is a
// drop-in swap behind the same `/v1/og/:ref` route.

const OG_W = 1200
const OG_H = 630

// Derive brand chrome for the OG cards. Axiom Black on Origin White.
const OG_INK = "#030712"
const OG_PAPER = "#f4f5f8"
const OG_MUTED = "#565a66"
// The Derive mark (viewBox 620×824) placed as a 42px-tall glyph at (90,74).
const OG_MARK = `<g transform="translate(90,74) scale(0.0509)"><path d="M404.01 217.285L271.071 140.531L404.01 63.7773L536.95 140.531L404.01 217.285ZM343.201 686.623L343.063 686.703C298.797 712.261 243.462 680.313 243.462 629.197C243.462 605.464 256.131 583.533 276.691 571.677L348.791 530.099V466.183L215.853 542.936L83.0526 466.183L243.462 373.692V188.295L376.401 265.049V629.119C376.401 652.841 363.746 674.761 343.201 686.623ZM188.243 744.209L55.4433 667.455V514.085L188.243 590.839V744.209ZM404.01 -1.19209e-05L188.243 124.517V341.803L0.224609 450.308V699.344L215.853 824L431.619 699.344V303.385C431.619 279.663 444.275 257.743 464.819 245.88L464.957 245.801C509.225 220.243 564.559 252.189 564.559 303.305V303.444C564.559 327.179 551.89 349.108 531.329 360.965L459.229 402.544V466.321L619.777 373.692V124.517L404.01 -1.19209e-05Z" fill="${OG_INK}"/></g>`

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
  /** Kept so a caller spreading an `UnfurlInfo` in must decide what the picture says. The card
   *  draws its description as one unwrapped line sized for the inventory string, so the OG route
   *  passes null and keeps the spec line; the summary reaches that reader via og:description. */
  summary?: string | null
  /** When false, render a generic locked card that leaks no title (private artifact). */
  reveal?: boolean
}

// ---- Profile unfurl (people pages: /users/:handle) -----------------------------

/** Everything a profile unfurl card / meta block needs about one person. */
export interface ProfileCard {
  username: string
  name: string | null
  profession: string | null
  works: number
  followers: number
}

/** One-line profile description: "Engineering · 12 works · 48 followers · on Derive". */
export const profileSummary = (c: ProfileCard): string => {
  const parts: string[] = []
  if (c.profession) parts.push(c.profession)
  parts.push(plural(c.works, "work"))
  parts.push(plural(c.followers, "follower"))
  return `${parts.join(" · ")} · on Derive`
}

/** Initials for the avatar disc — first+last of the name, else the first two chars. */
const profileInitials = (name: string | null, username: string): string => {
  const src = (name?.trim() || username).trim()
  const parts = src.split(/\s+/).filter(Boolean)
  const chars =
    parts.length >= 2 ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}` : src.slice(0, 2)
  return chars.toUpperCase() || "?"
}

/** The OG/Twitter `<head>` tags for a public profile. og:type=profile; values escaped. */
export const profileMetaTags = (i: {
  username: string
  name: string | null
  description: string
  pageUrl: string
  imageUrl: string
}): string => {
  const title = escapeHtml(i.name ? `${i.name} (@${i.username})` : `@${i.username}`)
  const d = escapeHtml(i.description)
  const url = escapeHtml(i.pageUrl)
  const img = escapeHtml(i.imageUrl)
  return [
    `<meta property="og:type" content="profile">`,
    `<meta property="og:site_name" content="Derive">`,
    `<meta property="profile:username" content="${escapeHtml(i.username)}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${img}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<link rel="canonical" href="${url}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${img}">`,
  ].join("\n")
}

/** The profile OG card as a standalone SVG (1200x630, Derive palette). Self-contained —
 *  an initials disc, not a remote avatar — so it renders identically on every crawler. */
export const ogProfileCardSvg = (card: ProfileCard): string => {
  const sans = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
  const mono = "'SF Mono', ui-monospace, Menlo, Consolas, monospace"
  const name = svgEscape(card.name?.trim() || `@${card.username}`)
  const handle = svgEscape(`@${card.username}`)
  const initials = svgEscape(profileInitials(card.name, card.username))
  const summary = svgEscape(profileSummary(card))
  const cx = 200
  const cy = 320
  const r = 110
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}" viewBox="0 0 ${OG_W} ${OG_H}" role="img" aria-label="${name}">
  <rect width="${OG_W}" height="${OG_H}" fill="${OG_PAPER}"/>
  <rect x="0" y="0" width="${OG_W}" height="10" fill="${OG_INK}"/>
  ${OG_MARK}
  <g font-family="${mono}" font-size="26" fill="${OG_INK}" font-weight="600">
    <text x="150" y="105" letter-spacing="1">DERIVE</text>
  </g>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${OG_INK}"/>
  <text x="${cx}" y="${cy + 28}" text-anchor="middle" font-family="${sans}" font-size="84" font-weight="700" fill="${OG_PAPER}" letter-spacing="2">${initials}</text>
  <text x="350" y="300" font-family="${sans}" font-size="68" font-weight="700" fill="${OG_INK}" letter-spacing="-1">${name}</text>
  <text x="350" y="360" font-family="${mono}" font-size="32" fill="${OG_MUTED}">${handle}</text>
  <text x="350" y="430" font-family="${mono}" font-size="28" fill="${OG_MUTED}">${summary}</text>
  <text x="${OG_W - 90}" y="105" text-anchor="end" font-family="${mono}" font-size="24" fill="${OG_MUTED}">derive.to</text>
</svg>`
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
  const meta = reveal ? unfurlDescription(card) : "Open it on Derive to request access"
  const sans = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
  const mono = "'SF Mono', ui-monospace, Menlo, Consolas, monospace"
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}" viewBox="0 0 ${OG_W} ${OG_H}" role="img" aria-label="${svgEscape(title)}">
  <rect width="${OG_W}" height="${OG_H}" fill="${OG_PAPER}"/>
  <rect x="0" y="0" width="${OG_W}" height="10" fill="${OG_INK}"/>
  ${OG_MARK}
  <g font-family="${mono}" font-size="26" fill="${OG_INK}" font-weight="600">
    <text x="150" y="105" letter-spacing="1">DERIVE</text>
  </g>
  <text font-family="${sans}" font-size="62" font-weight="700" fill="${OG_INK}" letter-spacing="-1">${titleTspans}</text>
  <text x="90" y="540" font-family="${mono}" font-size="28" fill="${OG_MUTED}">${svgEscape(meta)}</text>
  <text x="${OG_W - 90}" y="105" text-anchor="end" font-family="${mono}" font-size="24" fill="${OG_MUTED}">derive.to</text>
</svg>`
}
