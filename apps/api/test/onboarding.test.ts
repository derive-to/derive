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
  // A second user whose ONLY agent activity is the propose → approve loop, so the
  // proposal path is pinned on its own (not shadowed by u's direct MCP version).
  const u2: TestUser = { id: "u_onb2", email: "onb2@derive.test", name: "Sam" }
  const { app, meta } = makeAuthedApp("onboarding", [u, u2])

  let firstShortId: string
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
    firstShortId = short_id
  })

  it("an approved agent proposal on the user's behalf also counts (the propose → approve loop)", async () => {
    // A propose-scoped agent never creates an 'mcp'-stamped version itself; the
    // delegation record (on_behalf_of) + the human's approval is the signal. u2's
    // ONLY agent activity is this loop, so the assertion pins the proposal branch.
    expect((await status(u2)).published_via_agent).toBe(false)
    const res = await publishAs(app, "<h1>base</h1>", { title: "Proposal target" }, as(u2.email))
    const { short_id } = await res.json()
    const artifact = await meta.getByShortId(short_id)
    if (!artifact) throw new Error("expected the artifact")
    const v1 = await meta.getVersion(artifact.id, 1)
    if (!v1) throw new Error("expected v1")
    await meta.createProposal({
      id: "p_onb",
      artifact_id: artifact.id,
      blob_key: v1.blob_key,
      content_type: v1.content_type,
      kind: artifact.kind,
      author: "Claude Code",
      author_id: "oauth:claude",
      on_behalf_of: u2.id,
      base_version: 1,
      message: "agent proposal",
    })
    // An OPEN proposal is not activation — only the human's approval is.
    expect((await status(u2)).published_via_agent).toBe(false)
    await meta.decideProposal("p_onb", {
      state: "approved",
      decided_by: u2.id,
      decided_version: 2,
    })
    const s = await status(u2)
    expect(s.published_via_agent).toBe(true)
    expect(s.first_artifact).toEqual({ short_id, title: "Proposal target" })
    // And u's earlier direct MCP publish stays THEIR first artifact, undisturbed.
    expect((await status()).first_artifact?.short_id).toBe(firstShortId)
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
