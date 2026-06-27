// Email notifications. Runtime-neutral: an `EmailSender` abstracts the transport so
// the edge (Cloudflare Email Service `SEND_EMAIL` binding, see email-cf.ts) and Node
// self-host (log by default, or Resend over fetch) plug in without the callers caring.
// Outbound email rides the same retrying outbox as webhooks (kind="email"): content is
// pre-rendered at enqueue time (the drainer has no request context) and this sender
// just transports the finished message.

import type { ArtifactRecord, DeliveryRecord } from "@dock/core"
import { log } from "../log"
import type { ChannelSendResult } from "../webhooks"

/** A finished message, ready to transport. `from` is filled by the sender's config. */
export interface EmailMsg {
  to: string
  toName?: string
  subject: string
  html: string
  text: string
}

export interface EmailSender {
  /** Send one message. Throws on a transport failure so the outbox retries. */
  send(msg: EmailMsg): Promise<void>
}

/** Self-host / local default: record the email to the logger instead of sending. Makes
 *  notifications visible in dev without an SMTP/provider, and is a safe no-op fallback. */
export const logEmailSender = (): EmailSender => ({
  async send(msg) {
    log.info("email (log sender — not actually sent)", {
      to: msg.to,
      subject: msg.subject,
    })
  },
})

/** Resend transactional email over fetch (no SDK dependency). For self-host deployments
 *  that want real delivery without the Cloudflare Email Service binding. */
export const resendEmailSender = (apiKey: string, from: string): EmailSender => ({
  async send(msg) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    })
    if (!res.ok) throw new Error(`resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  },
})

/** Adapt an `EmailSender` into a `ChannelSenders["email"]` entry: parse the outbox
 *  row's pre-rendered payload and transport it. */
export const emailDeliverySender =
  (sender: EmailSender) =>
  async (d: DeliveryRecord): Promise<ChannelSendResult> => {
    const msg = JSON.parse(d.payload) as EmailMsg
    await sender.send(msg)
    return { ok: true, status: "sent" }
  }

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A notification email's deep link to the comment thread. */
export const commentDeepLink = (
  baseUrl: string,
  artifact: ArtifactRecord,
  threadId: string,
): string =>
  `${baseUrl.replace(/\/$/, "")}/a/${artifact.short_id}?c=${encodeURIComponent(threadId)}`

export interface CommentEmailInput {
  author: string
  body: string
  quote?: string | null
  threadId: string
  /** Set for a mention email: the email is "X mentioned you", not "X commented". */
  mention?: boolean
}

/** Render a comment/mention notification email (subject + html + text). Plain, readable,
 *  one clear call-to-action back to the thread in Dock. */
export const buildCommentEmail = (
  baseUrl: string,
  artifact: ArtifactRecord,
  input: CommentEmailInput,
): { subject: string; html: string; text: string } => {
  const title = artifact.title ?? artifact.short_id
  const link = commentDeepLink(baseUrl, artifact, input.threadId)
  const verb = input.mention ? "mentioned you on" : "commented on"
  const subject = input.mention
    ? `${input.author} mentioned you on ${title}`
    : `${input.author} commented on ${title}`
  const body = truncate(input.body, 600)
  const quote = input.quote ? truncate(input.quote, 200) : null

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.5">
  <p><strong>${esc(input.author)}</strong> ${verb} <a href="${esc(link)}">${esc(title)}</a>.</p>
  ${quote ? `<blockquote style="border-left:3px solid #ddd;margin:0 0 12px;padding:4px 12px;color:#666">${esc(quote)}</blockquote>` : ""}
  <p style="white-space:pre-wrap">${esc(body)}</p>
  <p><a href="${esc(link)}" style="display:inline-block;background:#111;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none">View in Dock</a></p>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
  <p style="color:#999;font-size:12px">You're receiving this because you collaborate on this artifact in Dock.</p>
  </body></html>`

  const text = [
    `${input.author} ${verb} ${title}.`,
    quote ? `\n> ${quote}` : "",
    `\n${body}`,
    `\nView in Dock: ${link}`,
  ]
    .filter(Boolean)
    .join("\n")

  return { subject, html, text }
}
