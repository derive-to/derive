import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeAuth, migrateAuth } from "../src/auth-config"
import { sha256 } from "../src/lib/crypto"

// Regression test for the MCP/OAuth "sign back in every few hours" bug.
//
// Claude Code's Derive access token expires every 24h, so every long-lived or
// parallel agent session hits the refresh grant. The oauth-provider rotates refresh tokens on
// every use and, on detecting a *reused* (already-revoked) token, calls
// invalidateRefreshFamily — which deletes EVERY refresh + access token for that
// (client, user). A concurrent refresh (an MCP client firing several requests at
// expiry) or a retry of a refresh whose 200 response was lost presents the just-
// rotated parent a second time, so the family — including the legitimate child
// token issued microseconds earlier — is wiped, and the client is forced to
// re-register a brand-new OAuth client and re-consent. Observed in prod as 11
// client registrations in 4 days.
//
// The derive-patch(refresh-rotation-grace) v2 makes reuse painless instead of merely
// less destructive: a token rotated within a 7-day grace window is HONORED — the
// server mints a fresh sibling token pair for the presenter, so parallel agent
// sessions sharing one credential store all end up with valid tokens no matter who
// wins the rotation race. A token rotated longer ago than the grace window is
// rejected, but only that request fails: the family is never invalidated, because in
// this deployment every reuse ever observed was a stale legitimate client, and the
// nuke converted one dead client into a forced re-consent for every live one.

const dir = mkdtempSync(join(tmpdir(), "derive-oauth-refresh-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Auth = ReturnType<typeof makeAuth>
type Ctx = Awaited<Auth["$context"]>

const BASE = "http://derive.test"
const SCOPES = ["openid", "offline_access", "derive:read"]

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
// the refresh_token grant — exactly how Claude Code registers against Derive.
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
// the plugin stores it (Derive's storeTokens.hash = sha256), so presenting `plaintext`
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
    userId = await createUser(ctx, "race@derive.test")
  })

  it("a reused (just-rotated) refresh token is honored with a fresh sibling pair", async () => {
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

    // Concurrent/replayed refresh presents the just-rotated parent again. Within the
    // grace window this SUCCEEDS: the loser of the rotation race gets its own fresh
    // sibling pair instead of an invalid_grant it would surface as "sign in again".
    const r2 = await tokenReq(auth, {
      grant_type: "refresh_token",
      refresh_token: RT,
      client_id: clientId,
    })
    expect(r2.status, "reused parent within grace must succeed").toBe(200)
    const RT3 = ((await r2.json()) as { refresh_token?: string }).refresh_token
    expect(RT3, "the loser gets its own fresh refresh token").toBeTruthy()
    expect(RT3, "the sibling is a new token, not the parent replayed").not.toBe(RT)

    // Both the winner's child and the loser's sibling stay live.
    const r3 = await tokenReq(auth, {
      grant_type: "refresh_token",
      refresh_token: RT2 as string,
      client_id: clientId,
    })
    expect(r3.status, "the winner's child token must stay live").toBe(200)
    const r4 = await tokenReq(auth, {
      grant_type: "refresh_token",
      refresh_token: RT3 as string,
      client_id: clientId,
    })
    expect(r4.status, "the loser's sibling token must stay live").toBe(200)
  })

  it("reuse outside the grace window fails that request only — the family survives", async () => {
    const RT_OLD = "rt_old_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const RT_LIVE = "rt_live_cccccccccccccccccccccccccccc"
    // A token rotated 8 days ago (outside the 7-day grace), plus a live sibling in
    // the same family.
    await seedRefreshToken(ctx, {
      plaintext: RT_OLD,
      clientId,
      userId,
      revoked: new Date(Date.now() - 8 * 86_400_000),
    })
    await seedRefreshToken(ctx, { plaintext: RT_LIVE, clientId, userId })

    const reuse = await tokenReq(auth, {
      grant_type: "refresh_token",
      refresh_token: RT_OLD,
      client_id: clientId,
    })
    expect(reuse.status, "token rotated beyond grace is rejected").toBe(400)

    // The rejection is scoped to the stale token: the live sibling keeps working.
    // (v1 called invalidateRefreshFamily here, turning one dead client into a forced
    // re-consent for every live one.)
    const live = await tokenReq(auth, {
      grant_type: "refresh_token",
      refresh_token: RT_LIVE,
      client_id: clientId,
    })
    expect(live.status, "the family must survive a stale-token rejection").toBe(200)
  })
})
