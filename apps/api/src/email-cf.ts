// Cloudflare Email Service adapter (edge-only). Wraps the `SEND_EMAIL` Worker binding
// as an `EmailSender`. The binding takes a MIME message (the `EmailMessage` value from
// the `cloudflare:email` virtual module); we build a minimal multipart/alternative MIME
// (text + html) by hand to avoid a mimetext dependency. Cloudflare's Email Service
// configures SPF/DKIM/DMARC for the sending domain and delivers to arbitrary recipients
// (unlike the older Email Routing `send_email` binding, which only reached verified
// destinations). Only constructed on the Workers tier (see webhook-do.ts); the Node
// build never imports it.

import type { EmailMessage } from "cloudflare:email"
import type { EmailMsg, EmailSender } from "./lib/email"

// `cloudflare:email` is a Workers-runtime virtual module: it doesn't exist under Node
// (vitest/self-host would fail to resolve a static import). Import the TYPE only above
// (erased at build), and pull the EmailMessage VALUE via a dynamic import inside send()
// — only ever reached on the edge, where the module is real. wrangler/esbuild marks
// `cloudflare:*` external, so this resolves correctly in the Worker bundle.

/** The shape of the `SEND_EMAIL` binding we rely on. */
export interface SendEmailBinding {
  send(message: EmailMessage): Promise<void>
}

const crlf = (s: string): string => s.replace(/\r?\n/g, "\r\n")

// Strip CR/LF from a header VALUE so a comment author/title (which can be attacker-chosen,
// e.g. an anonymous commenter's name) can't inject extra headers (Bcc:, etc.) via a newline.
const hdr = (s: string): string => s.replace(/[\r\n]+/g, " ").trim()

/** Build a minimal RFC 5322 multipart/alternative message (text + html). `from`/`to` are
 *  plain addresses; header values are CR/LF-stripped to prevent header injection. Exported
 *  for unit testing the header construction without the Workers runtime. */
export const buildMime = (from: string, msg: EmailMsg, dateIso: string, msgId: string): string => {
  const boundary = `derive-${msgId}`
  const headers = [
    `From: ${hdr(from)}`,
    `To: ${hdr(msg.to)}`,
    `Subject: ${hdr(msg.subject)}`,
    `Message-ID: <${msgId}@derive.to>`,
    `Date: ${new Date(dateIso).toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join("\r\n")
  const body = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    msg.text,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    msg.html,
    `--${boundary}--`,
    "",
  ].join("\r\n")
  return crlf(`${headers}\r\n\r\n${body}`)
}

/** Adapt the Cloudflare `SEND_EMAIL` binding to an `EmailSender`. `from` must be on a
 *  domain configured for the Email Service. */
export const cloudflareEmailSender = (binding: SendEmailBinding, from: string): EmailSender => ({
  async send(msg) {
    const { EmailMessage } = await import("cloudflare:email")
    const id = crypto.randomUUID().slice(0, 12)
    const raw = buildMime(from, msg, new Date().toISOString(), id)
    await binding.send(new EmailMessage(from, msg.to, raw))
  },
})
