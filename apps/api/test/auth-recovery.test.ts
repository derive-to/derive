import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { type AuthHooks, makeAuth, migrateAuth } from "../src/auth-config"

// End-to-end of the password-recovery backbone against a REAL Better Auth instance (not
// the fake-session harness): sign up → request reset → capture the emailed token → reset →
// sign in with the new password, and confirm the old one no longer works. The sendAuthEmail
// hook captures the URL the same way the outbox render does, so this exercises the exact
// wiring node.ts/worker.ts use — without needing a live mail transport.
const dir = mkdtempSync(join(tmpdir(), "derive-auth-recovery-"))
const dbPath = join(dir, "auth.db")
const db = new Database(dbPath)

// Capture reset/verify/change links instead of sending them.
const sent: { kind: string; to: string; url: string }[] = []
const hooks: AuthHooks = {
  sendAuthEmail: (kind, input) => {
    sent.push({ kind, to: input.to, url: input.url })
  },
}
const BASE = "http://localhost:8080"
const auth = makeAuth(db, BASE, "test-secret-0123456789abcd", hooks)
const app = createApp({
  meta: new SqliteMetaStore(dbPath),
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: BASE,
  auth,
})

// A browser-shaped request (Origin + cookie) so the CSRF/origin path runs like real usage.
const post = (path: string, body: unknown) =>
  app.request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie: "derive_probe=1" },
    body: JSON.stringify(body),
  })

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("auth: password recovery end-to-end", () => {
  beforeAll(async () => {
    await migrateAuth(auth)
  })

  const email = "recover@derive.test"

  it("signs up, sends a verification email, and issues a session", async () => {
    const res = await post("/api/auth/sign-up/email", {
      email,
      password: "initialPassw0rd",
      name: "Rec",
    })
    expect(res.status).toBe(200)
    // Soft-nudge verification fires on sign-up (sendOnSignUp), through our hook.
    expect(sent.some((m) => m.kind === "verify" && m.to === email)).toBe(true)
  })

  it("emails a reset link on request, and the link carries a token", async () => {
    sent.length = 0
    const res = await post("/api/auth/request-password-reset", {
      email,
      redirectTo: `${BASE}/reset-password`,
    })
    expect(res.status).toBe(200)
    const msg = sent.find((m) => m.kind === "reset" && m.to === email)
    expect(msg).toBeTruthy()
    // Better Auth's callback URL is /reset-password/:token?callbackURL=… — a real token.
    expect(msg?.url).toContain("/reset-password/")
  })

  it("does not reveal whether an unknown address has an account (neutral 200, no email)", async () => {
    sent.length = 0
    const res = await post("/api/auth/request-password-reset", {
      email: "nobody@derive.test",
      redirectTo: `${BASE}/reset-password`,
    })
    expect(res.status).toBe(200)
    expect(sent.length).toBe(0)
  })

  it("resets the password with the emailed token, then signs in with the new one", async () => {
    // Re-request to get a fresh token we control.
    sent.length = 0
    await post("/api/auth/request-password-reset", { email, redirectTo: `${BASE}/reset-password` })
    const link = sent.find((m) => m.kind === "reset")?.url as string
    // Extract the token: /reset-password/<token>?callbackURL=…
    const token = new URL(link).pathname.split("/reset-password/")[1]
    expect(token).toBeTruthy()

    const reset = await post("/api/auth/reset-password", { token, newPassword: "brandNewPassw0rd" })
    expect(reset.status).toBe(200)

    // The new password works…
    const ok = await post("/api/auth/sign-in/email", { email, password: "brandNewPassw0rd" })
    expect(ok.status).toBe(200)
    // …and the old one no longer does.
    const bad = await post("/api/auth/sign-in/email", { email, password: "initialPassw0rd" })
    expect(bad.status).toBe(401)
  })
})
