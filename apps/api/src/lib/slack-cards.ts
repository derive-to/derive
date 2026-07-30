// Block Kit primitives for the connected Slack App's messages: the comment thread mirror,
// channel event cards, and per-user DMs (mentions, review requests, shares). Pure functions
// (no I/O). Slack renders mrkdwn, never HTML, and there are two kinds of untrusted text with
// two different treatments:
//   - short identity fields (author, title, a Slack display name) → `escapeMrkdwn`; they are
//     labels, so rendering markdown in them would be wrong as well as unsafe.
//   - authored prose (a comment body, a proposal note, a publish message) → `mrkdwnBody`,
//     which escapes AND renders the markdown subset Slack has an equivalent for.
// A plain-text `text` fallback rides alongside every message and needs the same treatment: it
// is what the push/desktop notification shows, and what Slack renders if it rejects the blocks
// (invalid_blocks — see slack-delivery.ts).

import { truncate } from "./text"

/** Slack hard-limits a section's text to 3000 chars; leave headroom. */
export const MAX_SECTION = 2900

/** Escape the three mrkdwn control chars, so untrusted text can neither break out of a
 *  `<url|label>` link nor reach Slack's control syntax (`<!channel>`, `<!here>`, `<@U…>`).
 *  Slack unescapes them back to literals when it renders.
 *
 *  NEVER apply this to a URL we build: it rewrites `&` to `&amp;` and corrupts the query. */
export const escapeMrkdwn = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** A markdown link with an http(s) target. The URL may not contain whitespace, `)`, or any of
 *  the mrkdwn delimiters `<`, `>`, `|` — which is what lets us emit it UNESCAPED (so its query
 *  string survives) without it being able to break out of the `<url|label>` we wrap it in. A
 *  link whose URL breaks that rule simply isn't a link, and falls through to escaped prose. */
const MD_LINK = /\[([^\]\n]*)\]\((https?:\/\/[^\s<>|)]+)\)/g

/** Convert the markdown subset Slack has an equivalent for. Runs on text that is ALREADY
 *  escaped, so no rule here can be confused by a `<` or `&` in the source. Conservative on
 *  purpose: it only rewrites constructs that would otherwise render as literal characters. */
const renderProse = (s: string): string =>
  s
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/^\s*[-*]\s+/gm, "• ")

/** Clamp rendered mrkdwn to `max` without leaving a half-written entity (`&am`) or link
 *  (`<https://…` with no closing `>`) at the boundary. Both render as garbage, and Slack
 *  rejects a truncated link outright with invalid_blocks. */
const clampMrkdwn = (s: string, max: number): string => {
  if (s.length <= max) return s
  let cut = s.slice(0, max - 1)
  if (cut.lastIndexOf("<") > cut.lastIndexOf(">")) cut = cut.slice(0, cut.lastIndexOf("<"))
  if (cut.lastIndexOf("&") > cut.lastIndexOf(";")) cut = cut.slice(0, cut.lastIndexOf("&"))
  return `${cut}…`
}

/** Render an untrusted markdown body as Slack mrkdwn — safe first, pretty second.
 *
 *  The ORDER is the whole point here, and both obvious compositions of "escape" and "convert
 *  markdown" are broken: escaping after converting destroys the `<url|label>` just built, and
 *  converting after escaping both fails to find its links and corrupts any URL containing `&`.
 *  So links are tokenized out of the RAW text first; then the surrounding prose and the link
 *  LABEL are escaped, while the URL passes through untouched (safe because of MD_LINK's
 *  exclusions). Truncation is applied to the input AND the rendered output, because escaping
 *  EXPANDS text — `&` becomes 5 chars, so a body inside the cap can render well past it. */
export const mrkdwnBody = (md: string, max = MAX_SECTION): string => {
  const src = truncate(md, max)
  let out = ""
  let last = 0
  for (const m of src.matchAll(MD_LINK)) {
    const at = m.index ?? 0
    const label = escapeMrkdwn(m[1] ?? "")
    out += renderProse(escapeMrkdwn(src.slice(last, at)))
    out += label ? `<${m[2]}|${label}>` : `<${m[2]}>`
    last = at + m[0].length
  }
  out += renderProse(escapeMrkdwn(src.slice(last)))
  return clampMrkdwn(out.trim(), max)
}

// Block Kit primitives, shared by every Slack message builder (the comment mirror, DMs)
// so block scaffolding lives in one place.
export const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } })
export const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] })
export const actions = (elements: unknown[]) => ({ type: "actions", elements })
export const openButton = (url: string, text = "Open in Derive") => ({
  type: "button",
  text: { type: "plain_text", text },
  url,
})
/** An interactive button: clicking POSTs to the app's interactivity request URL with the
 *  `action_id` + `value` (unlike openButton, which is a plain link). `value` ≤ 2000 chars. */
export const actionButton = (
  actionId: string,
  text: string,
  value: string,
  style?: "primary" | "danger",
) => ({
  type: "button",
  action_id: actionId,
  text: { type: "plain_text", text },
  value,
  ...(style ? { style } : {}),
})
