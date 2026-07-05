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
  act: "approve" | "request_changes" | "resolve" | "link_account"
  org: string
  /** Proposal id or thread id, per action. */
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
      const head = `:white_check_mark: A thread was ${reopened ? "reopened" : "resolved"} on ${link(a)}`
      return {
        blocks: [context(head)],
        text: `Thread ${reopened ? "reopened" : "resolved"} on ${title(a)}`,
      }
    }

    case "version.published": {
      const v = str(d.version, "?")
      const head = `:package: *v${v}* published on ${link(a)}`
      const lines = [head]
      if (d.message) lines.push(markdownToMrkdwn(str(d.message)))
      const blocks: unknown[] = [section(lines.join("\n"))]
      if (d.author) blocks.push(context(`by ${str(d.author)}`))
      blocks.push(actions([openButton(a.url)]))
      return { blocks, text: `v${v} published on ${title(a)}` }
    }

    case "proposal.created": {
      const author = str(d.author, "someone")
      const id = str(d.proposal_id)
      const head = `:pencil2: *${author}* proposed a change to ${link(a)}`
      const blocks: unknown[] = [section(head)]
      if (d.message) blocks.push(section(`> ${markdownToMrkdwn(str(d.message))}`))
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
        blocks: [
          context(
            `:white_check_mark: *${who}* approved a proposal on ${link(a)} — v${v} published`,
          ),
        ],
        text: `Proposal approved on ${title(a)}`,
      }
    }

    case "proposal.changes_requested": {
      const who = str(d.reviewer, "someone")
      return {
        blocks: [
          context(
            `:leftwards_arrow_with_hook: *${who}* requested changes on a proposal on ${link(a)}`,
          ),
        ],
        text: `Changes requested on ${title(a)}`,
      }
    }

    case "review.requested": {
      const who = str(d.requested_by, "someone")
      const v = str(d.version, "?")
      return {
        blocks: [
          section(`:eyes: *${who}* requested review of ${link(a)} (v${v})`),
          actions([openButton(a.url, "Open review")]),
        ],
        text: `Review requested on ${title(a)}`,
      }
    }

    case "review.approved":
      return {
        blocks: [context(`:white_check_mark: Review approved on ${link(a)}`)],
        text: `Review approved on ${title(a)}`,
      }

    case "review.sent_back":
      return {
        blocks: [context(`:leftwards_arrow_with_hook: Review sent back on ${link(a)}`)],
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
