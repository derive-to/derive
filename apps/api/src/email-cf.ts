// Cloudflare Email Service adapter (edge-only). Wraps the Email Service `send_email`
// binding — the structured compose builder — as an `EmailSender`. Email Service delivers to
// ARBITRARY recipients (Workers Paid: 3,000/mo included, then metered) with SPF/DKIM/DMARC
// managed for the onboarded sending domain. This is distinct from the older Email Routing
// `EmailMessage` (cloudflare:email) binding, which only reached verified destinations and
// took a hand-built MIME blob. Only constructed on the Workers tier (see webhook-do.ts); the
// Node/self-host build (Resend) never imports it.

import type { EmailSender } from "./lib/email"

/** An addressed party — `{ name, email }` renders a display name ("Derive <addr>"); a bare
 *  string is just the address. */
type Addr = string | { name: string; email: string }

/** The Cloudflare Email Service `send_email` binding (declared with `remote = true`). It
 *  takes a structured message and builds the MIME itself — no `cloudflare:email` module, no
 *  manual multipart. Mirrors the `SendEmail.send()` builder in @cloudflare/workers-types.
 *  `from` must be on the onboarded sending domain. Rejects (throws) on a delivery failure,
 *  which the outbox relies on to retry. */
export interface SendEmailBinding {
  send(message: {
    from: Addr
    to: Addr
    subject: string
    html: string
    text: string
    replyTo?: Addr
    headers?: Record<string, string>
    attachments?: Array<{
      filename: string
      contentType: string
      content: Uint8Array
      contentId?: string
      disposition?: "inline" | "attachment"
    }>
  }): Promise<{ messageId: string }>
}

// Defense-in-depth: flatten CR/LF in the subject before it reaches the binding. The binding
// owns MIME construction (so this isn't the primary guard), but a comment author's name or
// an artifact title flows into the subject, and a newline there must never be able to smuggle
// a header. Cheap, and keeps the invariant local to where the untrusted text is used.
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim()

// EMAIL_FROM is shared with the Node (Resend) transport, so it's the RFC 5322 "Name <addr>"
// form. Split it into the structured { name, email } the builder wants (so the sender renders
// with its display name, "Derive"), falling back to a bare address when there's no name.
const parseAddr = (value: string): Addr => {
  const m = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  return m?.[1] && m[2] ? { name: m[1], email: m[2].trim() } : value.trim()
}

/** Adapt the Cloudflare Email Service binding to an `EmailSender`. `from` must be on the
 *  onboarded sending domain (e.g. "Derive <notifications@send.derive.to>"). */
export const cloudflareEmailSender = (binding: SendEmailBinding, from: string): EmailSender => ({
  async send(msg) {
    await binding.send({
      from: parseAddr(from),
      to: msg.toName ? { name: msg.toName, email: msg.to } : msg.to,
      subject: oneLine(msg.subject),
      html: msg.html,
      text: msg.text,
      attachments: msg.resolvedAttachments?.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: a.content,
        ...(a.contentId ? { contentId: a.contentId, disposition: "inline" as const } : {}),
      })),
    })
  },
})
