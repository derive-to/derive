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

/** Cut rendered PROSE to `max` without splitting something indivisible.
 *
 *  Only ever call this on text we escaped ourselves. It assumes every `&` starts an entity we
 *  wrote, which is true of escaped prose and false of the output as a whole — a URL's `&` is
 *  raw by design. Scanning the whole assembled string was the bug this replaced: an ordinary
 *  comment like "R&D … [tab](…?a=1&v=2)" made the URL's `&` look like a half-written entity,
 *  and trimming back to it sliced a COMPLETE link in half, leaving a dangling `<` and
 *  collapsing a 646-char message to 49. Links are now indivisible units in mrkdwnBody, so
 *  they never reach here. */
const cutProse = (s: string, max: number): string => {
  if (s.length <= max) return s
  let cut = s.slice(0, max)
  const amp = cut.lastIndexOf("&")
  if (amp > cut.lastIndexOf(";")) cut = cut.slice(0, amp)
  // A lone surrogate would reach the wire as invalid UTF-16.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return cut
}

/** Bound and escape a short identity field (an artifact title, an author name).
 *
 *  Bounds the ESCAPED length, which is the one that counts: escaping expands up to 5x (`&` ->
 *  `&amp;`), so these were escaped but never truncated and a single long title pushed a section
 *  past Slack's hard 3000-char cap. Slack answers that with invalid_blocks, and the comment
 *  mirror posts without a text fallback, so the comment dead-lettered instead of degrading. */
export const mrkdwnLabel = (s: string, max = 200): string => cutProse(escapeMrkdwn(s), max)

/** Bidi controls — a label can otherwise render right-to-left and visually impersonate another
 *  destination even after escaping. */
const BIDI = /[‪-‮⁦-⁩]/g

/** A label that is itself a URL or a bare domain. Such a label claims to BE the destination, so
 *  we refuse to hide the real one behind it (see renderLink). */
const LABEL_IS_URLISH =
  /^(?:[a-z][a-z0-9+.-]*:)?\/\/|^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]|$)/i

/** Render one markdown link as mrkdwn.
 *
 *  Rendering `[text](url)` at all means the author chooses the visible text — that is what a
 *  markdown link IS, and Derive's own UI renders comment bodies the same way, so Slack is just
 *  another renderer of the same content. What we refuse is the case where the label
 *  impersonates a destination: a label that looks like a URL or a bare domain, pointing
 *  somewhere else, is indistinguishable from a genuine link to the reader. There we drop the
 *  label and show where it actually goes. */
const renderLink = (url: string, rawLabel: string): string => {
  const plain = rawLabel.replace(BIDI, "").trim()
  if (!plain || plain === url || LABEL_IS_URLISH.test(plain)) return `<${url}>`
  return `<${url}|${escapeMrkdwn(plain)}>`
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
  // Reserve one char so an ellipsis always fits without a second, unsafe pass over the result.
  const limit = max - 1
  let out = ""
  let dropped = false
  // Assemble token by token against a budget. A link is INDIVISIBLE — it goes in whole or not
  // at all — so no clamp can ever emit a half-written one. Prose is the only thing cut, and
  // cutProse is safe on prose because we escaped it.
  const push = (rendered: string, atomic: boolean): boolean => {
    if (out.length + rendered.length <= limit) {
      out += rendered
      return true
    }
    if (!atomic) out += cutProse(rendered, limit - out.length)
    dropped = true
    return false
  }
  let last = 0
  for (const m of src.matchAll(MD_LINK)) {
    const at = m.index ?? 0
    if (!push(renderProse(escapeMrkdwn(src.slice(last, at))), false)) break
    if (!push(renderLink(m[2] ?? "", m[1] ?? ""), true)) break
    last = at + m[0].length
  }
  if (!dropped) push(renderProse(escapeMrkdwn(src.slice(last))), false)
  const body = out.trim()
  return dropped ? `${body}…` : body
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
