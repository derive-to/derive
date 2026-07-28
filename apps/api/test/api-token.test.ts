import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { API_TOKEN_TTL_MS, signApiToken, verifyApiToken } from "../src/lib/api-token"

import { scopeGapMessage } from "../src/lib/scope-gap"
import { dir } from "./helpers"

// Minted API tokens (lib/api-token.ts) — the agent's MCP authentication, spendable
// from its shell. The security properties that matter, each tested by trying to break
// them: the ceiling holds three ways (requested / grant scope / LIVE membership), the
// domain separation holds, expiry holds, and a minted token can never out-reach the
// grant that minted it.

const SECRET = "test-signing-secret"

describe("api token — signing and verification", () => {
  it("round-trips its claims", async () => {
    const exp = Date.now() + API_TOKEN_TTL_MS
    const tok = await signApiToken(SECRET, "u_1", "ws_1", "editor", "cli", exp)
    expect(tok.startsWith("dkapi_")).toBe(true)
    expect(await verifyApiToken(SECRET, tok, Date.now())).toEqual({
      userId: "u_1",
      orgId: "ws_1",
      role: "editor",
      clientId: "cli",
    })
  })

  it("refuses a wrong secret, a tampered payload, and an expired token", async () => {
    const exp = Date.now() + API_TOKEN_TTL_MS
    const tok = await signApiToken(SECRET, "u_1", "ws_1", "owner", "cli", exp)
    expect(await verifyApiToken("other-secret", tok, Date.now())).toBeNull()
    // Flip a payload character: the signature no longer matches.
    const tampered = `dkapi_${tok.slice(6, 20)}X${tok.slice(21)}`
    expect(await verifyApiToken(SECRET, tampered, Date.now())).toBeNull()
    // One ms past expiry is expired.
    expect(await verifyApiToken(SECRET, tok, exp + 1)).toBeNull()
  })

  it("refuses a token of another capability kind (domain separation)", async () => {
    // A run/session/upload token must never verify here even with the right secret —
    // the domain is as much a part of the key as the secret is.
    const { signUploadToken } = await import("../src/lib/upload-token")
    const upload = await signUploadToken(SECRET, "ws_1", "u_1", Date.now() + 60_000)
    expect(await verifyApiToken(SECRET, `dkapi_${upload}`, Date.now())).toBeNull()
    // And a correctly-signed api token is not accepted by the upload verifier.
    const { verifyUploadToken } = await import("../src/lib/upload-token")
    const api = await signApiToken(SECRET, "u_1", "ws_1", "editor", "cli", Date.now() + 60_000)
    expect(await verifyUploadToken(SECRET, api.slice(6), Date.now())).toBeNull()
  })

  it("refuses a malformed role in the payload (no privilege from a hand-built token)", async () => {
    const { signCapabilityToken } = await import("../src/lib/capability-token")
    const forged = `dkapi_${await signCapabilityToken(
      "derive-api-token:",
      SECRET,
      ["u_1", "ws_1", "superuser", "cli"],
      Date.now() + 60_000,
    )}`
    expect(await verifyApiToken(SECRET, forged, Date.now())).toBeNull()
  })
})

describe("scope-gap messages name the right lever", () => {
  const base = { registered: false, baseUrl: "https://derive.test" }

  it("says SCOPE when the seat would allow it but the consent didn't", () => {
    const msg = scopeGapMessage({
      ...base,
      action: "manage",
      scopeRole: "editor",
      memberRole: "owner",
    })
    expect(msg).toContain("derive:manage")
    expect(msg).toContain("/settings/agents")
    expect(msg).not.toContain("admin has to raise")
  })

  it("says SEAT when re-consenting could never help", () => {
    const msg = scopeGapMessage({
      ...base,
      action: "publish",
      scopeRole: "owner",
      memberRole: "commenter",
    })
    expect(msg).toContain("membership")
    expect(msg).toContain("Re-consenting won't change that")
  })

  it("says BOTH when both are short (fixing one changes nothing)", () => {
    const msg = scopeGapMessage({
      ...base,
      action: "manage",
      scopeRole: "commenter",
      memberRole: "editor",
    })
    expect(msg).toContain("both are below")
  })

  it("never suggests re-consent to a registered agent token (it can't)", () => {
    const msg = scopeGapMessage({
      ...base,
      registered: true,
      action: "manage",
      scopeRole: "editor",
      memberRole: "owner",
    })
    expect(msg).toContain("rotate")
    expect(msg).not.toContain("Reconnect with")
  })

  it("is null when the action is actually allowed", () => {
    expect(
      scopeGapMessage({ ...base, action: "publish", scopeRole: "owner", memberRole: "editor" }),
    ).toBeNull()
  })
})

// The wire: a minted token must authenticate REST at its capped role, and must lose
// that the instant its human loses the membership behind it.
describe.skipIf(process.env.DERIVE_TEST_DB === "pg")("api token on the wire", () => {
  function app(name: string) {
    const path = join(dir, `${name}.db`)
    const meta = new SqliteMetaStore(path)
    const db = new Database(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, profession TEXT, about TEXT);
      CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
    `)
    db.prepare(`INSERT OR IGNORE INTO "user"(id,email,name) VALUES(?,?,?)`).run(
      "u_api",
      "api@x.test",
      "Api User",
    )
    db.prepare(
      `INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli','Derive CLI')`,
    ).run()
    db.prepare(`INSERT INTO workspace(id,name,created_at) VALUES(?,?,?)`).run(
      "ws_api",
      "Main",
      "2020-01-01T00:00:00.000Z",
    )
    db.prepare(`INSERT INTO membership(id,org_id,user_id,role,created_at) VALUES(?,?,?,?,?)`).run(
      "m_api",
      "ws_api",
      "u_api",
      "owner",
      "2020-01-01T00:00:00.000Z",
    )
    db.close()
    return {
      meta,
      app: createApp({
        meta,
        blobs: new FsBlobStore(join(dir, `${name}-blobs`)),
        baseUrl: "http://derive.test",
        token: "static-op-token",
        encryptionKey: SECRET,
      }),
    }
  }

  const authed = (t: string) => ({ authorization: `Bearer ${t}` })

  it("authenticates REST at the role it was minted with", async () => {
    const { app: a } = app("api-tok-wire")
    const tok = await signApiToken(SECRET, "u_api", "ws_api", "owner", "cli", Date.now() + 60_000)
    const res = await a.request("/v1/artifacts?limit=1", { headers: authed(tok) })
    expect(res.status).toBe(200)
  })

  it("a token minted BELOW the human's role can't reach past it (least privilege holds)", async () => {
    const { app: a } = app("api-tok-narrow")
    // The human is an owner; this token was minted `viewer`. Minting an agent is a
    // manage-grade route — the narrow token must be refused there.
    const narrow = await signApiToken(
      SECRET,
      "u_api",
      "ws_api",
      "viewer",
      "cli",
      Date.now() + 60_000,
    )
    const res = await a.request("/v1/agents", {
      method: "POST",
      headers: { ...authed(narrow), "content-type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    })
    expect(res.status).toBe(403)
  })

  it("dies the moment its human loses the membership behind it", async () => {
    const { app: a, meta } = app("api-tok-revoke")
    const tok = await signApiToken(SECRET, "u_api", "ws_api", "owner", "cli", Date.now() + 60_000)
    expect((await a.request("/v1/artifacts?limit=1", { headers: authed(tok) })).status).toBe(200)
    // Remove the human from the workspace; the unexpired token must stop resolving.
    await meta.removeMembership("ws_api", "u_api")
    const after = await a.request("/v1/artifacts?limit=1", { headers: authed(tok) })
    expect(after.status).toBe(401)
  })

  it("an expired token is refused on the wire", async () => {
    const { app: a } = app("api-tok-expired")
    const stale = await signApiToken(SECRET, "u_api", "ws_api", "owner", "cli", Date.now() - 1)
    expect((await a.request("/v1/artifacts?limit=1", { headers: authed(stale) })).status).toBe(401)
  })

  it("a garbage dkapi_ bearer is anonymous, never a fallback principal", async () => {
    const { app: a } = app("api-tok-garbage")
    const res = await a.request("/v1/agents", {
      method: "POST",
      headers: { ...authed("dkapi_totally-made-up"), "content-type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    })
    expect([401, 403]).toContain(res.status)
  })
})
