// Block Kit card builders for the connected Slack App — one per event family. Pure
// functions (no I/O), so they're cheap to unit-test and reused by both the outbound
// event sender (slack-events.ts) and the interactivity endpoint's fallbacks. Slack
// renders mrkdwn, never HTML, so all text passes through markdownToMrkdwn first and a
// plain-text `text` fallback rides alongside every card (used when Slack rejects the
// blocks with invalid_blocks — see the sender).

import type { WebhookEvent } from "../events"
import { truncate } from "./text"

/** A ready-to-post message: Block Kit `blocks` plus the `text` notification fallback. */
export interface SlackCard {
  blocks: unknown[]
  text: string
}

/** The normalized, self-contained shape a card reads (an EventPayload plus the orgId the
 *  interactivity handler needs to scope an action). */
export interface CardInput {
  event: WebhookEvent
  orgId: string
  artifact: { short_id: string; title: string | null; url: string }
  data: Record<string, unknown>
}

/** Compact JSON packed into a button's `value` so the interactivity endpoint can act on
 *  it. `v` is a format version; never trust it without re-authorizing the clicking user. */
export interface ButtonValue {
  v: 1
  act: "approve" | "request_changes" | "resolve" | "link_account" | "share"
  org: string
  /** Proposal id, thread id, or (for `share`) artifact short id, per action. */
  id: string
  /** Deep link used for the PR-1 "open in Derive" fallback (before identity linking). */
  url: string
}

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

const title = (a: CardInput["artifact"]) => a.title ?? a.short_id
const link = (a: CardInput["artifact"]) => `<${a.url}|${title(a)}>`

// Block Kit primitives, shared by every Slack message builder (cards, the comment mirror,
// DMs) so block scaffolding lives in one place.
export const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } })
export const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] })
export const actions = (elements: unknown[]) => ({ type: "actions", elements })
export const openButton = (url: string, text = "Open in Derive") => ({
  type: "button",
  text: { type: "plain_text", text },
  url,
})
/** A thin rule between sections — gives multi-part cards visible structure. */
export const divider = () => ({ type: "divider" })
/** A bold banner (App Home + large cards). Emoji render; other markup does not. */
export const header = (text: string) => ({
  type: "header",
  text: { type: "plain_text", text, emoji: true },
})
const actionButton = (text: string, value: ButtonValue, style?: "primary" | "danger") => ({
  type: "button",
  text: { type: "plain_text", text },
  action_id: `slack_act:${value.act}`,
  value: JSON.stringify(value),
  ...(style ? { style } : {}),
})

const str = (v: unknown, fallback = "") => (v == null ? fallback : String(v))

/**
 * Build the Slack card for an event, or null when the event has no standalone card
 * (comment.created / comment.mention are mirrored as threads by slack-comments.ts, not
 * carded here). The sender decides channel + threading; this only shapes the message.
 */
export const cardForEvent = (p: CardInput): SlackCard | null => {
  const a = p.artifact
  const d = p.data

  switch (p.event) {
    case "comment.resolved": {
      const reopened = d.state === "open"
      return {
        blocks: [context(`Thread ${reopened ? "reopened" : "resolved"}  ·  *${link(a)}*`)],
        text: `Thread ${reopened ? "reopened" : "resolved"} on ${title(a)}`,
      }
    }

    case "version.published": {
      const v = str(d.version, "?")
      const blocks: unknown[] = [section(`*${link(a)}*`)]
      if (d.message) blocks.push(section(`> ${markdownToMrkdwn(str(d.message))}`))
      blocks.push(context(`New version  ·  v${v}${d.author ? `  ·  ${str(d.author)}` : ""}`))
      blocks.push(actions([openButton(a.url)]))
      return { blocks, text: `v${v} published on ${title(a)}` }
    }

    case "proposal.created": {
      const author = str(d.author, "someone")
      const id = str(d.proposal_id)
      const blocks: unknown[] = [section(`*${link(a)}*`)]
      if (d.message) blocks.push(section(`> ${markdownToMrkdwn(str(d.message))}`))
      blocks.push(context(`Change proposed  ·  ${author}`))
      const val = (act: ButtonValue["act"]): ButtonValue => ({
        v: 1,
        act,
        org: p.orgId,
        id,
        url: a.url,
      })
      blocks.push(
        actions([
          actionButton("Approve", val("approve"), "primary"),
          actionButton("Request changes", val("request_changes")),
          openButton(a.url, "Open"),
        ]),
      )
      return { blocks, text: `${author} proposed a change to ${title(a)}` }
    }

    case "proposal.approved": {
      const who = str(d.approver, "someone")
      const v = str(d.version, "?")
      return {
        blocks: [context(`Proposal approved  ·  *${link(a)}*  ·  v${v}  ·  ${who}`)],
        text: `Proposal approved on ${title(a)}`,
      }
    }

    case "proposal.changes_requested": {
      const who = str(d.reviewer, "someone")
      return {
        blocks: [context(`Changes requested  ·  *${link(a)}*  ·  ${who}`)],
        text: `Changes requested on ${title(a)}`,
      }
    }

    case "review.requested": {
      const who = str(d.requested_by, "someone")
      const v = str(d.version, "?")
      return {
        blocks: [
          section(`*${link(a)}*`),
          context(`Review requested  ·  v${v}  ·  ${who}`),
          actions([openButton(a.url, "Open review")]),
        ],
        text: `Review requested on ${title(a)}`,
      }
    }

    case "review.approved":
      return {
        blocks: [context(`Review approved  ·  *${link(a)}*`)],
        text: `Review approved on ${title(a)}`,
      }

    case "review.sent_back":
      return {
        blocks: [context(`Review sent back  ·  *${link(a)}*`)],
        text: `Review sent back on ${title(a)}`,
      }

    // comment.created / comment.mention are mirrored as Slack threads elsewhere.
    default:
      return null
  }
}

/** Events that post threaded under the comment they concern (when that comment was itself
 *  mirrored to Slack). Everything else posts top-level to the resolved channel. */
export const isThreadedEvent = (event: WebhookEvent): boolean => event === "comment.resolved"

// ---- Link unfurls / slash command / App Home --------------------------------
// These three surfaces show an artifact outside the event stream, so they read a small
// self-contained summary rather than a CardInput.

/** The compact artifact view the unfurl, share, search and Home builders render. */
export interface ArtifactSummary {
  short_id: string
  title: string | null
  url: string
  kind?: string
  version?: number
  updatedAt?: string
  openComments?: number
}

/** A localized "updated <date>" using Slack's date token (renders in the viewer's tz). */
const updatedLabel = (iso?: string): string | null => {
  if (!iso) return null
  const unix = Math.floor(new Date(iso).getTime() / 1000)
  if (!Number.isFinite(unix)) return null
  return `updated <!date^${unix}^{date_short_pretty}|${iso.slice(0, 10)}>`
}

/** The muted metadata line under a title: version, last update, open comments. */
const metaLine = (a: ArtifactSummary): string =>
  [
    a.version ? `v${a.version}` : null,
    updatedLabel(a.updatedAt),
    a.openComments ? `${a.openComments} open comment${a.openComments === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join("   ·   ")

/** One artifact as a titled row: kind glyph + bold linked title, meta as a subtitle, an
 *  optional accessory button. The single visual unit behind unfurls, share cards, search
 *  results and the App Home list, so they all read the same. */
const titleRow = (a: ArtifactSummary, accessory?: unknown) => {
  const meta = metaLine(a)
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*<${a.url}|${a.title ?? a.short_id}>*${meta ? `\n${meta}` : ""}`,
    },
    ...(accessory ? { accessory } : {}),
  }
}

/** The rich preview attached to a shared derive.to link (chat.unfurl blocks). */
export const unfurlCard = (a: ArtifactSummary): { blocks: unknown[] } => ({
  blocks: [titleRow(a)],
})

/** A "Share to channel" button that carries the artifact short id for the interactivity
 *  handler to re-resolve and post. */
const shareButton = (org: string, a: ArtifactSummary) => ({
  type: "button",
  text: { type: "plain_text", text: "Share", emoji: true },
  action_id: "slack_act:share",
  value: JSON.stringify({
    v: 1,
    act: "share",
    org,
    id: a.short_id,
    url: a.url,
  } satisfies ButtonValue),
})

/** The card `/derive share` (or the Share button) posts into a channel. */
export const shareCard = (a: ArtifactSummary): SlackCard => ({
  blocks: [titleRow(a), actions([openButton(a.url)])],
  text: `${a.title ?? a.short_id} — ${a.url}`,
})

/** The ephemeral result list for `/derive find <query>`: each hit is a titled row with a
 *  Share-to-channel button. Empty query results render a friendly miss. */
export const searchResultBlocks = (
  query: string,
  results: ArtifactSummary[],
  org: string,
): unknown[] => {
  if (results.length === 0) return [section(`No artifacts match *${query || "your search"}*.`)]
  const blocks: unknown[] = [
    context(`*${results.length}* result${results.length === 1 ? "" : "s"} for *${query}*`),
  ]
  for (const a of results) blocks.push(titleRow(a, shareButton(org, a)))
  return blocks
}

/** The per-user App Home tab (views.publish view). Linked users get a greeting + their
 *  recent artifacts; unlinked users get a prompt to link from Derive settings. */
export const homeView = (p: {
  linkedName: string | null
  items: ArtifactSummary[]
  baseUrl: string
}): { type: "home"; blocks: unknown[] } => {
  const blocks: unknown[] = [header("Derive")]
  if (p.linkedName) {
    blocks.push(context(`Signed in as *${p.linkedName}*`))
  } else {
    blocks.push(
      section("*Link your Slack account* to approve proposals and see what's waiting on you."),
      actions([openButton(`${p.baseUrl}/settings/integrations`, "Link account")]),
    )
  }
  blocks.push(divider())
  if (p.items.length) {
    blocks.push(context("Recent"))
    for (const a of p.items) blocks.push(titleRow(a, openButton(a.url, "Open")))
  } else {
    blocks.push(context("No artifacts yet."))
  }
  blocks.push(divider(), actions([openButton(p.baseUrl, "Open Derive")]))
  return { type: "home", blocks }
}
