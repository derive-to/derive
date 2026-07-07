// Cloudflare Email Service adapter (edge-only). Wraps the Email Service `send_email`
// binding — the STRUCTURED send API — as an `EmailSender`. Email Service delivers to
// ARBITRARY recipients (Workers Paid: 3,000/mo included, then metered) with SPF/DKIM/DMARC
// managed for the onboarded sending domain. This is distinct from the older Email Routing
// `EmailMessage` (cloudflare:email) binding, which only reached verified destination
// addresses and took a hand-built MIME blob. Only constructed on the Workers tier (see
// webhook-do.ts); the Node/self-host build (Resend) never imports it.

import type { EmailSender } from "./lib/email"

/** The Cloudflare Email Service `send_email` binding (declared with `remote = true`). It
 *  takes a structured message and builds the MIME itself — no `cloudflare:email` module,
 *  no manual multipart. `from` must be on the onboarded sending domain. Rejects (throws)
 *  on a delivery failure, which the outbox relies on to retry. */
export interface SendEmailBinding {
  send(message: {
    to: string
    from: string
    subject: string
    html: string
    text: string
  }): Promise<unknown>
}

// Defense-in-depth: flatten CR/LF in the subject before it reaches the binding. The binding
// owns MIME construction (so this isn't the primary guard), but a comment author's name or
// an artifact title flows into the subject, and a newline there must never be able to smuggle
// a header. Cheap, and keeps the invariant local to where the untrusted text is used.
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim()

// The structured binding takes a BARE sender address. EMAIL_FROM is shared with the Node
// (Resend) transport, which wants the RFC 5322 "Name <addr>" form — so extract the address
// from inside the angle brackets when present, else use the value as-is. One EMAIL_FROM value
// then works across both transports and the send never fails on a from-format the Email
// Service rejects.
const bareAddress = (from: string): string => from.match(/<([^>]+)>/)?.[1]?.trim() ?? from.trim()

/** Adapt the Cloudflare Email Service binding to an `EmailSender`. `from` must be on the
 *  onboarded sending domain (e.g. "notifications@send.derive.to", or the display-name form
 *  "Derive <notifications@send.derive.to>" — the address is extracted). */
export const cloudflareEmailSender = (binding: SendEmailBinding, from: string): EmailSender => ({
  async send(msg) {
    await binding.send({
      to: msg.to,
      from: bareAddress(from),
      subject: oneLine(msg.subject),
      html: msg.html,
      text: msg.text,
    })
  },
})
