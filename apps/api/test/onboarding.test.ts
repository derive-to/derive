import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The activation signals behind /v1/me/onboarding (the live welcome screen + the
// getting-started checklist): agent_connected comes from the user's OAuth grants,
// published_via_agent from the first version an agent published FOR them over MCP
// (version.source = 'mcp', attributed to them). The pin here is the source stamp —
// a web publish must never count as agent activation.

describe("onboarding activation signals", () => {
  const u: TestUser = { id: "u_onb", email: "onb@derive.test", name: "Robin" }
  const { app, meta } = makeAuthedApp("onboarding", [u])

  const status = async (who: TestUser = u) =>
    (await app.request("/v1/me/onboarding", { headers: as(who.email) })).json()

  it("starts all-false for a fresh user", async () => {
    await app.request("/v1/me", { headers: as(u.email) }) // provisions the workspace
    expect(await status()).toEqual({
      agent_connected: false,
      agent_name: null,
      published_via_agent: false,
      first_artifact: null,
    })
  })

  it("a session publish stamps version.source='web' and does not count as agent activation", async () => {
    const res = await publishAs(app, "<h1>hand-made</h1>", { title: "By hand" }, as(u.email))
    expect(res.status).toBe(201)
    const { short_id } = await res.json()
    const artifact = await meta.getByShortId(short_id)
    if (!artifact) throw new Error("expected the artifact")
    const v1 = await meta.getVersion(artifact.id, 1)
    expect(v1?.source).toBe("web")
    expect(v1?.author_id).toBe(u.id)
    const s = await status()
    expect(s.published_via_agent).toBe(false)
    expect(s.first_artifact).toBeNull()
  })

  it("an MCP-stamped version flips published_via_agent and names the first artifact", async () => {
    // The MCP publish tool runs the same core publish() with source:'mcp' and
    // author_id = the human the agent acts for; addVersion is that path's write.
    const res = await publishAs(app, "<h1>draft</h1>", { title: "Agent draft" }, as(u.email))
    const { short_id } = await res.json()
    const artifact = await meta.getByShortId(short_id)
    if (!artifact) throw new Error("expected the artifact")
    const v1 = await meta.getVersion(artifact.id, 1)
    if (!v1) throw new Error("expected v1")
    await meta.addVersion(artifact.id, {
      id: "v_onb_mcp",
      blob_key: v1.blob_key,
      content_type: v1.content_type,
      author: "Claude Code",
      author_id: u.id,
      source: "mcp",
      message: "agent publish",
    })
    const s = await status()
    expect(s.published_via_agent).toBe(true)
    expect(s.first_artifact).toEqual({ short_id, title: "Agent draft" })
    // agent_connected stays false — no OAuth consent exists in this app.
    expect(s.agent_connected).toBe(false)
  })
})

// agent_connected's data source: listUserGrants reads the oauth-provider tables.
// SQLite-direct like oauth.test.ts — the tables are Better Auth's, injected raw.
describe("listUserGrants → agent_connected", () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-onb-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("a consent row surfaces as a named grant", async () => {
    const path = join(dir, "grants.db")
    const meta = new SqliteMetaStore(path)
    const db = new Database(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE IF NOT EXISTS "oauthConsent" (userId TEXT, clientId TEXT, scopes TEXT, updatedAt TEXT);
    `)
    db.prepare(`INSERT INTO "oauthClient"(clientId, name) VALUES('cl_1', 'Claude Code')`).run()
    db.prepare(
      `INSERT INTO "oauthConsent"(userId, clientId, scopes, updatedAt) VALUES('u_1', 'cl_1', '["derive:publish"]', '2026-07-17T00:00:00.000Z')`,
    ).run()
    db.close()
    const grants = await meta.listUserGrants("u_1")
    expect(grants).toHaveLength(1)
    expect(grants[0]?.clientName).toBe("Claude Code")
    expect(await meta.listUserGrants("someone-else")).toEqual([])
    meta.close()
  })
})
