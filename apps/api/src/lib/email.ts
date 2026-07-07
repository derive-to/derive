// Email notifications. Runtime-neutral: an `EmailSender` abstracts the transport so
// the edge (Cloudflare Email Service `SEND_EMAIL` binding, see email-cf.ts) and Node
// self-host (log by default, or Resend over fetch) plug in without the callers caring.
// Outbound email rides the same retrying outbox as webhooks (kind="email"): content is
// pre-rendered at enqueue time (the drainer has no request context) and this sender
// just transports the finished message.

import { type ArtifactRecord, type DeliveryRecord, escapeHtml } from "@derive/core"
import { log } from "../log"
import type { ChannelSendResult } from "../webhooks"
import { commentDeepLink } from "./comments"
import { truncate } from "./text"

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

/** Render a transactional auth email (password reset, email verification, or email-change
 *  confirmation) — one clear primary action to the given URL. Same plain, readable house
 *  style as the comment email. Enqueued onto the same outbox (kind="email"). */
export const buildAuthEmail = (
  kind: "reset" | "verify" | "change_email",
  input: { to: string; name?: string | null; url: string },
): EmailMsg => {
  const copy = {
    reset: {
      subject: "Reset your Derive password",
      lead: "Reset your password",
      body: "We got a request to reset the password for your Derive account. Click below to choose a new one — the link expires in an hour.",
      cta: "Reset password",
      note: "If you didn’t request this, you can safely ignore this email; your password stays the same.",
    },
    verify: {
      subject: "Verify your email for Derive",
      lead: "Confirm your email",
      body: "Confirm this is your email address so we can keep your Derive account secure.",
      cta: "Verify email",
      note: "If you didn’t create a Derive account, you can ignore this email.",
    },
    change_email: {
      subject: "Confirm your new email for Derive",
      lead: "Confirm your new email",
      body: "Confirm you want to use this address for your Derive account. Your address won’t change until you do.",
      cta: "Confirm email",
      note: "If you didn’t request this change, ignore this email and nothing happens.",
    },
  }[kind]
  const href = escapeHtml(input.url)
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.5">
  <p style="font-size:16px;font-weight:600;margin:0 0 8px">${escapeHtml(copy.lead)}</p>
  <p>${escapeHtml(copy.body)}</p>
  <p><a href="${href}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(copy.cta)}</a></p>
  <p style="color:#666;font-size:13px">Or paste this link into your browser:<br/><a href="${href}" style="color:#666">${href}</a></p>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
  <p style="color:#999;font-size:12px">${escapeHtml(copy.note)}</p>
  </body></html>`
  const text = [`${copy.lead}`, ``, copy.body, ``, `${copy.cta}: ${input.url}`, ``, copy.note].join(
    "\n",
  )
  return { to: input.to, toName: input.name ?? undefined, subject: copy.subject, html, text }
}

/** Render a workspace-invitation email: who invited you, to which workspace, and a link
 *  to accept. Same plain house style; the link lands on the accept page (signed-in gate). */
export const buildInviteEmail = (input: {
  to: string
  workspace: string
  inviter?: string | null
  url: string
}): EmailMsg => {
  const by = input.inviter ? `${input.inviter} invited you` : "You've been invited"
  const href = escapeHtml(input.url)
  const ws = escapeHtml(input.workspace)
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.5">
  <p style="font-size:16px;font-weight:600;margin:0 0 8px">${escapeHtml(by)} to join ${ws} on Derive</p>
  <p>Derive is where teams publish living docs and review them together — with humans and agents in the same loop.</p>
  <p><a href="${href}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Accept invitation</a></p>
  <p style="color:#666;font-size:13px">Or paste this link into your browser:<br/><a href="${href}" style="color:#666">${href}</a></p>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
  <p style="color:#999;font-size:12px">If you weren't expecting this, you can ignore this email.</p>
  </body></html>`
  const text = [
    `${by} to join ${input.workspace} on Derive.`,
    ``,
    `Accept your invitation: ${input.url}`,
    ``,
    `If you weren't expecting this, ignore this email.`,
  ].join("\n")
  return { to: input.to, subject: `Join ${input.workspace} on Derive`, html, text }
}

export interface CommentEmailInput {
  author: string
  body: string
  quote?: string | null
  threadId: string
  /** Set for a mention email: the email is "X mentioned you", not "X commented". */
  mention?: boolean
}

/** Render a comment/mention notification email (subject + html + text). Plain, readable,
 *  one clear call-to-action back to the thread in Derive. */
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
  <p><strong>${escapeHtml(input.author)}</strong> ${verb} <a href="${escapeHtml(link)}">${escapeHtml(title)}</a>.</p>
  ${quote ? `<blockquote style="border-left:3px solid #ddd;margin:0 0 12px;padding:4px 12px;color:#666">${escapeHtml(quote)}</blockquote>` : ""}
  <p style="white-space:pre-wrap">${escapeHtml(body)}</p>
  <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#111;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none">View in Derive</a></p>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
  <p style="color:#999;font-size:12px">You're receiving this because you collaborate on this artifact in Derive.</p>
  </body></html>`

  const text = [
    `${input.author} ${verb} ${title}.`,
    quote ? `\n> ${quote}` : "",
    `\n${body}`,
    `\nView in Derive: ${link}`,
  ]
    .filter(Boolean)
    .join("\n")

  return { subject, html, text }
}
