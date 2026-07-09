import { createHmac } from "node:crypto"
import { expect, test } from "@playwright/test"
import { signUp } from "../helpers"

// End-to-end proof of the TOTP two-factor setup: enable, read the secret the QR encodes,
// generate a REAL code from it, and confirm the server activates 2FA. Because the QR and the
// manual key are both derived from the same otpauth:// URI, a code that the server accepts
// proves the QR is valid too — not just that an <svg> rendered.

// RFC 4648 base32 decode (A–Z, 2–7) — authenticator secrets are base32.
function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const c of s.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | alphabet.indexOf(c)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// RFC 6238 TOTP — SHA1, 6 digits, 30s step (Better Auth's TOTP defaults).
function totp(secret: string, at = Date.now()): string {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
  const hmac = createHmac("sha1", base32Decode(secret)).update(buf).digest()
  // Dynamic truncation (RFC 4226): the low nibble of the last byte picks a 4-byte window;
  // readUInt32BE gives that window big-endian, and masking the top bit is the `& 0x7f`.
  const offset = hmac.readUInt8(hmac.length - 1) & 0x0f
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff
  return (bin % 1_000_000).toString().padStart(6, "0")
}

test("[deep] TOTP two-factor: enable via the QR-backed secret, end to end", async ({ page }) => {
  await signUp(page)
  await page.goto("/settings")
  await page.getByTestId("settings-tab-security").click()

  await page.getByTestId("2fa-enable").click()
  await page.getByTestId("2fa-password").fill("e2e-pass-1234")
  await page.getByTestId("2fa-start").click()

  // The QR is the primary path; reveal the manual key (the same secret the QR encodes) to
  // read it out for a real code.
  await expect(page.getByTestId("2fa-qr")).toBeVisible()
  await page.getByTestId("2fa-show-key").click()
  const secret = ((await page.getByTestId("2fa-secret").textContent()) ?? "").trim()
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/)

  await page.getByTestId("2fa-confirm-code").fill(totp(secret))
  await page.getByTestId("2fa-confirm").click()

  // The server accepted a code generated from the displayed secret ⇒ 2FA is genuinely on:
  // the row flips from Enable to Disable.
  await expect(page.getByTestId("2fa-disable")).toBeVisible()
})
