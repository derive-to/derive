import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { API_TOKEN_TTL_MS, signApiToken, verifyApiToken } from "../src/lib/api-token"
import { sha256 } from "../src/lib/crypto"

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
    const ws = db.prepare(`INSERT INTO workspace(id,name,created_at) VALUES(?,?,?)`)
    const mem = db.prepare(
      `INSERT INTO membership(id,org_id,user_id,role,created_at) VALUES(?,?,?,?,?)`,
    )
    ws.run("ws_api", "Main", "2020-01-01T00:00:00.000Z")
    mem.run("m_api", "ws_api", "u_api", "owner", "2020-01-01T00:00:00.000Z")
    // A SECOND workspace the same human also owns — the target a pinned token must be
    // unable to reach even though its human could.
    ws.run("ws_other", "Other", "2021-01-01T00:00:00.000Z")
    mem.run("m_other", "ws_other", "u_api", "owner", "2021-01-01T00:00:00.000Z")
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

  it("THE STORY THIS EXISTS FOR: a manage-minted token creates a context over REST", async () => {
    // The exact failure that started the cleanup — authenticated over MCP, needing a
    // REST-only management route, unable to prove that authentication from the shell.
    // End to end on nothing but a minted bearer.
    const { app: a } = app("api-tok-story")
    const tok = await signApiToken(SECRET, "u_api", "ws_api", "owner", "cli", Date.now() + 60_000)
    const form = new FormData()
    form.set("file", new Blob(["# manifest"], { type: "text/markdown" }), "manifest.md")
    form.set("title", "Manifest")
    const pub = await a.request("/v1/artifacts", {
      method: "POST",
      headers: authed(tok),
      body: form,
    })
    expect(pub.status).toBe(201)
    const { short_id } = (await pub.json()) as { short_id: string }
    const res = await a.request("/v1/contexts", {
      method: "POST",
      headers: { ...authed(tok), "content-type": "application/json" },
      body: JSON.stringify({ name: "QA", manifest_short_id: short_id }),
    })
    expect(res.status).toBe(201)
    // Attributed to the HUMAN behind the grant, not to a synthetic principal.
    expect(((await res.json()) as { created_by: string }).created_by).toBe("u_api")
  })

  it("is PINNED to one workspace — X-Derive-Workspace can't re-home it", async () => {
    // An OAuth grant may roam workspaces with this header. A minted token must NOT:
    // it names one workspace and that is the whole of its reach, so a token minted
    // for a low-stakes workspace can never be aimed at a sensitive one. (The human
    // here owns both, so only the pin can be what stops it.)
    const { app: a } = app("api-tok-pin")
    const tok = await signApiToken(SECRET, "u_api", "ws_api", "owner", "cli", Date.now() + 60_000)
    const seed = new FormData()
    seed.set("file", new Blob(["# other-ws doc"], { type: "text/markdown" }), "o.md")
    seed.set("title", "OtherWorkspaceDoc")
    // Publish into ws_other using a token minted FOR ws_other (proves the doc exists).
    const otherTok = await signApiToken(
      SECRET,
      "u_api",
      "ws_other",
      "owner",
      "cli",
      Date.now() + 60_000,
    )
    expect(
      (await a.request("/v1/artifacts", { method: "POST", headers: authed(otherTok), body: seed }))
        .status,
    ).toBe(201)
    // Now the ws_api token, pointed at ws_other by header, must not see it.
    const res = await a.request("/v1/artifacts?limit=50", {
      headers: { ...authed(tok), "x-derive-workspace": "ws_other" },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { artifacts?: { title?: string | null }[] }
    expect((body.artifacts ?? []).some((x) => x.title === "OtherWorkspaceDoc")).toBe(false)
  })
})

// The whole loop over the REAL wire: a live OAuth grant calls `stage target:'api'` on
// /mcp, and the token that comes back is spent against REST. Nothing hand-signed.
describe.skipIf(process.env.DERIVE_TEST_DB === "pg")("stage target:'api' over /mcp", () => {
  function granted(name: string) {
    const path = join(dir, `${name}.db`)
    const meta = new SqliteMetaStore(path)
    const db = new Database(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, profession TEXT, about TEXT);
      CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
    `)
    db.prepare(`INSERT OR IGNORE INTO "user"(id,email,name) VALUES(?,?,?)`).run(
      "u_g",
      "g@x.test",
      "Granter",
    )
    db.prepare(
      `INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli','Derive CLI')`,
    ).run()
    const exp = new Date(Date.now() + 3_600_000).toISOString()
    const ins = db.prepare(
      `INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`,
    )
    // A manage-scoped grant, and a publish-only one to prove the ceiling.
    ins.run(
      sha256("grant_manage"),
      "cli",
      "u_g",
      JSON.stringify(["openid", "derive:read", "derive:publish", "derive:manage"]),
      exp,
    )
    ins.run(
      sha256("grant_publish"),
      "cli",
      "u_g",
      JSON.stringify(["openid", "derive:read", "derive:publish"]),
      exp,
    )
    db.prepare(`INSERT INTO workspace(id,name,created_at) VALUES(?,?,?)`).run(
      "ws_g",
      "Main",
      "2020-01-01T00:00:00.000Z",
    )
    db.prepare(`INSERT INTO membership(id,org_id,user_id,role,created_at) VALUES(?,?,?,?,?)`).run(
      "m_g",
      "ws_g",
      "u_g",
      "owner",
      "2020-01-01T00:00:00.000Z",
    )
    db.close()
    return createApp({
      meta,
      blobs: new FsBlobStore(join(dir, `${name}-blobs`)),
      baseUrl: "http://derive.test",
      token: "static-op-token",
      encryptionKey: SECRET,
    })
  }

  const mcp = async (a: ReturnType<typeof granted>, bearer: string, args: object) => {
    const res = await a.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "stage", arguments: args },
      }),
    })
    const txt = await res.text()
    const out = (res.headers.get("content-type") ?? "").includes("application/json")
      ? JSON.parse(txt)
      : JSON.parse(
          (txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
        )
    const r = out?.result as { content?: { text: string }[]; isError?: boolean }
    return { text: r?.content?.[0]?.text ?? "", isError: !!r?.isError }
  }

  it("mints over MCP, and the token works against REST management", async () => {
    const a = granted("api-mcp-mint")
    const minted = await mcp(a, "grant_manage", { target: "api" })
    expect(minted.isError).toBe(false)
    const { token, acts_as, workspace } = JSON.parse(minted.text) as {
      token: string
      acts_as: string
      workspace: string
    }
    expect(token.startsWith("dkapi_")).toBe(true)
    expect(acts_as).toBe("owner")
    expect(workspace).toBe("ws_g")
    // Spend it on a manage-gated REST route.
    const res = await a.request("/v1/agents", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "MintedBot" }),
    })
    expect(res.status).toBe(201)
  })

  it("REFUSES to chain: a minted token can't mint its own successor", async () => {
    const a = granted("api-mcp-chain")
    const first = JSON.parse((await mcp(a, "grant_manage", { target: "api" })).text) as {
      token: string
    }
    const second = await mcp(a, first.token, { target: "api" })
    expect(second.isError).toBe(true)
    expect(second.text).toContain("renew itself indefinitely")
  })

  it("can't mint above the grant's scope, and says which lever is short", async () => {
    const a = granted("api-mcp-ceiling")
    // The human is an OWNER of ws_g, but this grant was consented publish-only — so
    // manage is out of reach and the SCOPE is what's short, not the seat.
    const refused = await mcp(a, "grant_publish", { target: "api", access: "manage" })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain("derive:manage")
    expect(refused.text).not.toContain("admin has to raise")
    // The same grant can still mint at or below what it holds.
    const ok = await mcp(a, "grant_publish", { target: "api", access: "publish" })
    expect(ok.isError).toBe(false)
    expect((JSON.parse(ok.text) as { acts_as: string }).acts_as).toBe("editor")
  })

  it("narrows on request (least privilege), and the narrowed token can't reach past it", async () => {
    const a = granted("api-mcp-narrow")
    const narrow = JSON.parse(
      (await mcp(a, "grant_manage", { target: "api", access: "read" })).text,
    ) as { token: string; acts_as: string }
    expect(narrow.acts_as).toBe("viewer")
    const res = await a.request("/v1/agents", {
      method: "POST",
      headers: { authorization: `Bearer ${narrow.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    })
    expect(res.status).toBe(403)
  })
})
