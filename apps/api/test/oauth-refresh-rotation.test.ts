import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeAuth, migrateAuth } from "../src/auth-config"
import { sha256 } from "../src/lib/crypto"

// Regression test for the MCP/OAuth "sign back in every few hours" bug.
//
// Claude Code's Dock access token is a 1h JWT, so it must hit the refresh grant
// roughly hourly under active use. The oauth-provider rotates refresh tokens on
// every use and, on detecting a *reused* (already-revoked) token, calls
// invalidateRefreshFamily — which deletes EVERY refresh + access token for that
// (client, user). A concurrent refresh (an MCP client firing several requests at
// expiry) or a retry of a refresh whose 200 response was lost presents the just-
// rotated parent a second time, so the family — including the legitimate child
// token issued microseconds earlier — is wiped, and the client is forced to
// re-register a brand-new OAuth client and re-consent. Observed in prod as 11
// client registrations in 4 days.
//
// The dock-patch(refresh-rotation-grace) adds a short grace window: a token revoked
// within the window is treated as a benign concurrent rotation — the request still
// fails (the reused token is never honored) but the family is left intact, so the
// winning refresh keeps the session alive. Genuine reuse outside the window still
// invalidates the family.

const dir = mkdtempSync(join(tmpdir(), "dock-oauth-refresh-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Auth = ReturnType<typeof makeAuth>
type Ctx = Awaited<Auth["$context"]>

const BASE = "http://dock.test"
const SCOPES = ["openid", "offline_access", "dock:read"]

const tokenReq = (auth: Auth, body: Record<string, string>) =>
  auth.handler(
    new Request(`${BASE}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    }),
  )

// Register a real public MCP-style client via Dynamic Client Registration so it
// passes validateClientCredentials (token_endpoint_auth_method=none) and is allowed
// the refresh_token grant — exactly how Claude Code registers against Dock.
async function registerClient(auth: Auth): Promise<string> {
  const res = await auth.handler(
    new Request(`${BASE}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "RaceClient",
        redirect_uris: ["http://localhost/cb"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPES.join(" "),
      }),
    }),
  )
  expect(res.status, "DCR should succeed").toBeLessThan(300)
  const j = (await res.json()) as { client_id: string }
  expect(j.client_id).toBeTruthy()
  return j.client_id
}

async function createUser(ctx: Ctx, email: string): Promise<string> {
  const now = new Date()
  const u = (await ctx.adapter.create({
    model: "user",
    data: { email, name: "Race", emailVerified: true, createdAt: now, updatedAt: now },
  })) as { id: string }
  return u.id
}

// Seed a refresh token straight into the oauth-provider table the way a completed
// authorize→consent→token dance would, so we exercise the refresh grant without the
// full PKCE/consent flow (irrelevant to the rotation bug). Stored hashed exactly as
// the plugin stores it (Dock's storeTokens.hash = sha256), so presenting `plaintext`
// resolves to this row.
async function seedRefreshToken(
  ctx: Ctx,
  opts: { plaintext: string; clientId: string; userId: string; revoked?: Date | null },
): Promise<void> {
  await ctx.adapter.create({
    model: "oauthRefreshToken",
    data: {
      token: sha256(opts.plaintext),
      clientId: opts.clientId,
      userId: opts.userId,
      referenceId: opts.userId,
      scopes: SCOPES,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      createdAt: new Date(),
      revoked: opts.revoked ?? null,
      authTime: null,
      sessionId: null,
    },
  })
}

function freshAuth(name: string): Auth {
  const db = new Database(join(dir, `${name}.db`))
  db.pragma("journal_mode = WAL")
  db.pragma("busy_timeout = 5000")
  return makeAuth(db, BASE, "test-secret-0123456789-abcdefghijklmnopqrstuv")
}

describe("OAuth refresh-token rotation survives a concurrent/replayed refresh", () => {
  let auth: Auth
  let ctx: Ctx
  let clientId: string
  let userId: string

  beforeAll(async () => {
    auth = freshAuth("grace")
    await migrateAuth(auth)
    ctx = await auth.$context
    clientId = await registerClient(auth)
    userId = await createUser(ctx, "race@dock.test")
  })

  it("a reused (just-rotated) refresh token is rejected but the live child survives", async () => {
    const RT = "rt_parent_aaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    await seedRefreshToken(ctx, { plaintext: RT, clientId, userId })

    // First refresh succeeds and rotates RT -> RT2 (RT is now revoked).
    const r1 = await tokenReq(auth, {
      grant_type: "refresh_token",
      refresh_token: RT,
      client_id: clientId,
    })
    expect(r1.status, "first refresh should succeed").toBe(200)
    const RT2 = ((await r1.json()) as { refresh_token?: string }).refresh_token
    expect(RT2, "rotation should issue a new refresh token").toBeTruthy()

    // Concurrent/replayed refresh presents the just-rotated parent again. It must be
    // rejected (the reused token is never honored)...
    const r2 = await tokenReq(auth, {
      grant_type: "refresh_token",
      refresh_token: RT,
      client_id: clientId,
    })
    expect(r2.status, "reused parent token must be rejected").toBe(400)

    // ...but it must NOT have nuked the family: the child issued by the first refresh
    // still works. Without the grace patch, invalidateRefreshFamily deletes RT2's row
    // and this returns 400 ("session not found") — the forced re-consent.
    const r3 = await tokenReq(auth, {
      grant_type: "refresh_token",
      refresh_token: RT2 as string,
      client_id: clientId,
    })
    expect(r3.status, "the live child token must survive the reuse attempt").toBe(200)
  })

  it("genuine reuse outside the grace window still invalidates the family", async () => {
    const RT_OLD = "rt_old_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const RT_LIVE = "rt_live_cccccccccccccccccccccccccccc"
    // A token revoked well before the grace window (a real replay), plus a live
    // sibling in the same family.
    await seedRefreshToken(ctx, {
      plaintext: RT_OLD,
      clientId,
      userId,
      revoked: new Date(Date.now() - 5 * 60_000),
    })
    await seedRefreshToken(ctx, { plaintext: RT_LIVE, clientId, userId })

    const reuse = await tokenReq(auth, {
      grant_type: "refresh_token",
      refresh_token: RT_OLD,
      client_id: clientId,
    })
    expect(reuse.status, "stale reused token rejected").toBe(400)

    // The whole family is invalidated, so even the live sibling no longer works —
    // reuse-detection is preserved for genuine replay.
    const live = await tokenReq(auth, {
      grant_type: "refresh_token",
      refresh_token: RT_LIVE,
      client_id: clientId,
    })
    expect(live.status, "family invalidated on real reuse").toBe(400)
  })
})
