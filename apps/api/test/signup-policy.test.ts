import type { ArtifactInviteRecord, InvitationRecord } from "@derive/core"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { makeAuth, migrateAuth } from "../src/auth-config"
import {
  ADMISSION_COOKIE,
  armInviteAdmission,
  mintInviteAdmission,
  parseSignupMode,
  signupPolicy,
} from "../src/lib/signup-policy"

const SECRET = "test-secret-0123456789abcd"
const HASH = "a".repeat(64)

describe("self-host signup admission", () => {
  it("defaults to open and rejects misspelled modes", () => {
    expect(parseSignupMode(undefined)).toBe("open")
    expect(() => parseSignupMode("invte")).toThrow(/DERIVE_SIGNUP_MODE/)
  })

  it("does not let a configured-looking email bypass closed mode", async () => {
    const allowed = signupPolicy("closed", SECRET, {
      getInvitationByToken: async () => null,
      getArtifactInviteByToken: async () => null,
    })
    await expect(allowed({ email: "owner@example.com", cookieHeader: null })).resolves.toBe(false)
  })

  it("requires possession of a signed capability for a live invite", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const invite = {
      token: HASH,
      expires_at: expiresAt,
      accepted_at: null,
    } as InvitationRecord
    const allowed = signupPolicy("invite", SECRET, {
      getInvitationByToken: async (hash) => (hash === HASH ? invite : null),
      getArtifactInviteByToken: async () => null,
    })
    const minted = await mintInviteAdmission("workspace", HASH, expiresAt, SECRET)
    expect(minted).not.toBeNull()
    await expect(
      allowed({
        // Admission follows possession of the link, not a claim about this address.
        email: "stranger@example.com",
        cookieHeader: `${ADMISSION_COOKIE}=${minted?.token}`,
      }),
    ).resolves.toBe(true)
    await expect(allowed({ email: "invited@example.com", cookieHeader: null })).resolves.toBe(false)
  })

  it("accepts artifact capabilities and rejects a capability after the invite is spent", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const invite = { token: HASH, expires_at: expiresAt, accepted_at: null } as ArtifactInviteRecord
    const allowed = signupPolicy("invite", SECRET, {
      getInvitationByToken: async () => null,
      getArtifactInviteByToken: async (hash) => (hash === HASH ? invite : null),
    })
    const minted = await mintInviteAdmission("artifact", HASH, expiresAt, SECRET)
    const attempt = {
      email: "person@example.com",
      cookieHeader: `${ADMISSION_COOKIE}=${minted?.token}`,
    }
    await expect(allowed(attempt)).resolves.toBe(true)
    invite.accepted_at = new Date().toISOString()
    await expect(allowed(attempt)).resolves.toBe(false)
  })

  it("uses the session cookie policy for split web/API deployments", async () => {
    const app = new Hono()
    app.get("/invite", async (c) => {
      await armInviteAdmission(
        c,
        "workspace",
        HASH,
        new Date(Date.now() + 60_000).toISOString(),
        SECRET,
        { baseUrl: "https://api.derive.test", crossSite: true },
      )
      return c.body(null, 204)
    })
    const response = await app.request("http://internal/invite")
    expect(response.headers.get("set-cookie")).toMatch(
      /^d_admission=.*; Max-Age=\d+; Path=\/api\/auth; HttpOnly; Secure; SameSite=None$/,
    )
  })

  it("enforces the policy in Better Auth's provider-independent user-create hook", async () => {
    const db = new Database(":memory:")
    const auth = makeAuth(db, "http://derive.test", "test-secret-0123456789abcd", {
      signupAllowed: async () => false,
    })
    await migrateAuth(auth)
    const response = await auth.handler(
      new Request("http://derive.test/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Blocked Person",
          email: "blocked@example.com",
          password: "valid-password",
        }),
      }),
    )
    expect(response.status).toBe(403)
    expect(db.prepare('SELECT count(*) FROM "user"').pluck().get()).toBe(0)
    db.close()
  })

  it("forwards the admission cookie through Better Auth's user-create hook", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const invite = {
      token: HASH,
      expires_at: expiresAt,
      accepted_at: null,
    } as InvitationRecord
    const db = new Database(":memory:")
    const auth = makeAuth(db, "http://derive.test", SECRET, {
      signupAllowed: signupPolicy("invite", SECRET, {
        getInvitationByToken: async (hash) => (hash === HASH ? invite : null),
        getArtifactInviteByToken: async () => null,
      }),
    })
    await migrateAuth(auth)
    const minted = await mintInviteAdmission("workspace", HASH, expiresAt, SECRET)
    const response = await auth.handler(
      new Request("http://derive.test/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${ADMISSION_COOKIE}=${minted?.token}`,
          origin: "http://derive.test",
        },
        body: JSON.stringify({
          name: "Invited Person",
          email: "invited@example.com",
          password: "valid-password",
        }),
      }),
    )
    expect(response.status, await response.clone().text()).toBe(200)
    expect(db.prepare('SELECT count(*) FROM "user"').pluck().get()).toBe(1)
    db.close()
  })
})
