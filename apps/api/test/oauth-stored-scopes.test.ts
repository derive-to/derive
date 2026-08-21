import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeAuth, migrateAuth } from "../src/auth-config"
import { sha256 } from "../src/lib/crypto"

// OAUTH_SCOPES binds only NEW registrations and authorizations. The refresh grant
// re-issues from the STORED token row (better-auth's mcp plugin checks only that
// the stored scopes carry offline_access, never the configured list), so a stored
// scope string outside the configured list is inert — no action maps to it, it
// grants nothing, and it never bricks the grant. That contract is what lets
// OAUTH_SCOPES be narrowed freely: shipping a shorter list cannot strand a
// working connection, and nobody can consent to an unconfigured scope.

const dir = mkdtempSync(join(tmpdir(), "derive-oauth-stored-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Auth = ReturnType<typeof makeAuth>
type Ctx = Awaited<Auth["$context"]>

const BASE = "http://derive.test"
/** A stored grant's scope shape: the last two are outside OAUTH_SCOPES. */
const STORED_SCOPES = [
  "openid",
  "offline_access",
  "derive:read",
  "derive:comment",
  "derive:propose",
  "derive:publish",
  "derive:review",
]

const tokenReq = (auth: Auth, body: Record<string, string>) =>
  auth.handler(
    new Request(`${BASE}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    }),
  )

describe("stored scopes vs OAUTH_SCOPES", () => {
  let auth: Auth
  let ctx: Ctx
  let clientId: string
  let userId: string

  const register = (scope: string) =>
    auth.handler(
      new Request(`${BASE}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "StoredClient",
          redirect_uris: ["http://localhost/cb"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope,
        }),
      }),
    )

  let db: Database.Database
  beforeAll(async () => {
    db = new Database(join(dir, "stored.db"))
    db.pragma("journal_mode = WAL")
    db.pragma("busy_timeout = 5000")
    auth = makeAuth(db, BASE, "test-secret-0123456789-abcdefghijklmnopqrstuv")
    await migrateAuth(auth)
    ctx = await auth.$context
    const reg = await register("openid offline_access derive:read derive:comment derive:publish")
    expect(reg.status, "DCR with current scopes registers").toBeLessThan(300)
    clientId = ((await reg.json()) as { client_id: string }).client_id
    const now = new Date()
    const u = (await ctx.adapter.create({
      model: "user",
      data: {
        email: "stored@derive.test",
        name: "Stored",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    })) as { id: string }
    userId = u.id
  })

  it("refreshes a token whose stored scopes include unconfigured strings", async () => {
    // The refresh grant validates the token against the CLIENT row's own scope
    // string, never the configured OAUTH_SCOPES (those bind only NEW
    // registrations/authorizations). Put the wider string on the row.
    const table = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'oauth%'")
        .all() as { name: string }[]
    ).find((t) => /application|client/i.test(t.name))?.name
    if (!table) throw new Error("no oauth client table found")
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    )
    const scopeCol = cols.find((c) => /scope/i.test(c))
    const idCol = cols.includes("clientId") ? "clientId" : "client_id"
    if (!scopeCol) throw new Error(`no scope column in ${table}: ${cols.join(",")}`)
    db.prepare(`UPDATE ${table} SET ${scopeCol} = ? WHERE ${idCol} = ?`).run(
      STORED_SCOPES.join(" "),
      clientId,
    )
    const RT = "rt_stored_aaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    await ctx.adapter.create({
      model: "oauthRefreshToken",
      data: {
        token: sha256(RT),
        clientId,
        userId,
        referenceId: userId,
        scopes: STORED_SCOPES,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        createdAt: new Date(),
        revoked: null,
        authTime: null,
        sessionId: null,
      },
    })
    const res = await tokenReq(auth, {
      grant_type: "refresh_token",
      refresh_token: RT,
      client_id: clientId,
    })
    expect(res.status, "a stored grant must refresh, not brick").toBe(200)
    const body = (await res.json()) as { access_token?: string; refresh_token?: string }
    expect(body.access_token).toBeTruthy()
    expect(body.refresh_token).toBeTruthy()
  })

  it("a NEW registration asking for an unconfigured scope is refused", async () => {
    const reg = await register(STORED_SCOPES.join(" "))
    expect(reg.status).toBe(400)
  })
})
