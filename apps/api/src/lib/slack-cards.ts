// Block Kit primitives for the connected Slack App's messages: the comment thread mirror
// and per-user DMs (mentions, review requests, shares). Pure functions (no I/O). Slack
// renders mrkdwn, never HTML, so all text passes through markdownToMrkdwn first and a
// plain-text `text` fallback rides alongside every message (used when Slack rejects the
// blocks with invalid_blocks — see slack-delivery.ts).

import { truncate } from "./text"

const MAX_SECTION = 2900 // Slack hard-limits a section's text to 3000 chars.

/** Convert a small subset of Markdown to Slack mrkdwn. Conservative on purpose: it only
 *  rewrites constructs that would otherwise render as literal characters (links, bold,
 *  headings, bullets) and leaves everything else untouched, so it can't corrupt prose. */
export const markdownToMrkdwn = (md: string): string => {
  let s = md
  // [text](url) -> <url|text> (do this first; link text may contain other markup).
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
  // **bold** / __bold__ -> *bold* (Slack bold is a single asterisk).
  s = s.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/__(.+?)__/g, "*$1*")
  // # Heading -> *Heading* (Slack has no headings inside a section).
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
  // - item / * item -> • item
  s = s.replace(/^\s*[-*]\s+/gm, "• ")
  return truncate(s.trim(), MAX_SECTION)
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
