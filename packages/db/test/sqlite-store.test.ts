import { randomUUID as uuid } from "node:crypto"
import Database from "better-sqlite3"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SqliteMetaStore } from "../src/sqlite"

// The cross-dialect query layer (repos.ts) + the SQLite driver (sqlite.ts) only get
// exercised through apps/api in the api suite, so this package reports ~5% on its
// own. Drive an in-memory store directly through each entity lifecycle so the data
// layer is verified where it lives. Postgres runs the same repos via pg.ts; the
// schema-conformance test already pins both dialects to the same DDL.
const ORG = `org_${uuid()}`
let store: SqliteMetaStore

// A minimal artifact; callers override what they assert on.
const newArtifact = (over: Partial<Parameters<SqliteMetaStore["createArtifact"]>[0]> = {}) => ({
  id: uuid(),
  short_id: uuid().slice(0, 8),
  org_id: ORG,
  slug: "doc",
  title: "Doc",
  visibility: "link" as const,
  kind: "file" as const,
  spa: 0 as const,
  ...over,
})

const newVersion = (over: Partial<Parameters<SqliteMetaStore["addVersion"]>[1]> = {}) => ({
  id: uuid(),
  blob_key: `blob_${uuid()}`,
  content_type: "text/html",
  author: "amy",
  message: "v",
  size_bytes: 10,
  ...over,
})

beforeAll(() => {
  store = new SqliteMetaStore(":memory:")
})
afterAll(() => store.close())

describe("sqlite store: workspaces + memberships", () => {
  it("creates a workspace, lists a user's workspaces with their role", async () => {
    const ws = await store.setWorkspace(ORG, "Acme")
    expect(ws.name).toBe("Acme")
    expect(await store.getWorkspace(ORG)).toMatchObject({ name: "Acme" })

    await store.setMembership({ id: uuid(), org_id: ORG, user_id: "amy", role: "owner" })
    await store.setMembership({ id: uuid(), org_id: ORG, user_id: "bob", role: "editor" })
    expect(await store.countMemberships(ORG)).toBe(2)
    expect(await store.getMembership(ORG, "amy")).toMatchObject({ role: "owner" })
    expect((await store.listMemberships(ORG)).length).toBe(2)
    const amyWs = await store.listWorkspaces("amy")
    expect(amyWs).toHaveLength(1)
    expect(amyWs[0]).toMatchObject({ role: "owner", name: "Acme" })
  })

  it("renames on a repeat setWorkspace and removes a membership", async () => {
    await store.setWorkspace(ORG, "Acme Renamed")
    expect((await store.getWorkspace(ORG))?.name).toBe("Acme Renamed")
    await store.setMembership({ id: uuid(), org_id: ORG, user_id: "temp", role: "viewer" })
    await store.removeMembership(ORG, "temp")
    expect(await store.getMembership(ORG, "temp")).toBeNull()
  })
})

describe("sqlite store: artifacts + versions", () => {
  it("creates, fetches by short id and internal id, and lists", async () => {
    const a = newArtifact({ title: "Hello World" })
    const created = await store.createArtifact(a)
    expect(created.short_id).toBe(a.short_id)
    expect(await store.getByShortId(a.short_id)).toMatchObject({ id: a.id })
    expect(await store.getArtifactById(a.id)).toMatchObject({ short_id: a.short_id })
    expect(await store.getByShortId("nope")).toBeNull()
    const list = await store.listArtifacts({ orgId: ORG })
    expect(list.some((x) => x.id === a.id)).toBe(true)
    expect(await store.countArtifacts(ORG)).toBeGreaterThan(0)
  })

  it("appends versions, bumps current_version, lists newest data", async () => {
    const a = await store.createArtifact(newArtifact())
    const v1 = await store.addVersion(a.id, newVersion({ message: "first" }))
    const v2 = await store.addVersion(a.id, newVersion({ message: "second" }))
    expect(v1.n).toBe(1)
    expect(v2.n).toBe(2)
    expect((await store.getByShortId(a.short_id))?.current_version).toBe(2)
    expect(await store.listVersions(a.id)).toHaveLength(2)
    expect((await store.getVersion(a.id, 1))?.message).toBe("first")
    expect(await store.getVersion(a.id, 99)).toBeNull()
  })

  it("filters listArtifacts by title search and by id set (empty ⇒ none)", async () => {
    const a = await store.createArtifact(newArtifact({ title: "Quarterly Report XYZ" }))
    expect((await store.listArtifacts({ q: "quarterly report xyz" })).map((x) => x.id)).toContain(
      a.id,
    )
    expect((await store.listArtifacts({ ids: [a.id] })).map((x) => x.id)).toEqual([a.id])
    expect(await store.listArtifacts({ ids: [] })).toEqual([])
  })

  it("changes visibility (sets/clears the password hash)", async () => {
    const a = await store.createArtifact(newArtifact())
    await store.setVisibility(a.id, "password", "hash123")
    expect(await store.getByShortId(a.short_id)).toMatchObject({ visibility: "password" })
    await store.setVisibility(a.id, "link", null)
    expect(await store.getByShortId(a.short_id)).toMatchObject({ visibility: "link" })
  })

  it("counts storage bytes once per distinct blob (content-addressed)", async () => {
    const a = await store.createArtifact(newArtifact())
    await store.addVersion(a.id, newVersion({ blob_key: "shared", size_bytes: 100 }))
    await store.addVersion(a.id, newVersion({ blob_key: "shared", size_bytes: 100 }))
    await store.addVersion(a.id, newVersion({ blob_key: "other", size_bytes: 50 }))
    // 100 (shared, counted once) + 50 (other) = 150
    expect(await store.storageBytes(ORG)).toBeGreaterThanOrEqual(150)
  })
})

describe("sqlite store: comments + threads", () => {
  it("creates comments, filters by state, resolves a whole thread", async () => {
    const a = await store.createArtifact(newArtifact())
    const thread = uuid()
    const c = await store.createComment({
      id: uuid(),
      artifact_id: a.id,
      thread_id: thread,
      base_version: 1,
      body_md: "nice",
      author: "amy",
    })
    expect(await store.getComment(c.id)).toMatchObject({ body_md: "nice" })
    expect(await store.listComments(a.id)).toHaveLength(1)
    const edited = await store.updateComment(c.id, { body_md: "edited" })
    expect(edited?.body_md).toBe("edited")
    const n = await store.setThreadState(a.id, thread, "resolved")
    expect(n).toBe(1)
    expect(await store.listComments(a.id, { state: "open" })).toHaveLength(0)
    expect(await store.listComments(a.id, { state: "resolved" })).toHaveLength(1)
  })
})

describe("sqlite store: shares, favorites, tags", () => {
  it("sets and removes a per-artifact member (share)", async () => {
    const a = await store.createArtifact(newArtifact())
    await store.setArtifactMember({ id: uuid(), artifact_id: a.id, user_id: "bob", role: "editor" })
    expect(await store.getArtifactMember(a.id, "bob")).toMatchObject({ role: "editor" })
    expect(await store.listArtifactMembers(a.id)).toHaveLength(1)
    await store.removeArtifactMember(a.id, "bob")
    expect(await store.getArtifactMember(a.id, "bob")).toBeNull()
  })

  it("stars + unstars an artifact", async () => {
    const a = await store.createArtifact(newArtifact())
    await store.setFavorite(a.id, "amy")
    expect(await store.listUserFavoriteIds("amy")).toContain(a.id)
    await store.removeFavorite(a.id, "amy")
    expect(await store.listUserFavoriteIds("amy")).not.toContain(a.id)
  })

  it("replaces a tag set and resolves ids/counts by tag", async () => {
    const a = await store.createArtifact(newArtifact())
    await store.setArtifactTags(a.id, ["alpha", "beta"])
    expect((await store.tagsForArtifacts([a.id]))[a.id]?.sort()).toEqual(["alpha", "beta"])
    expect(await store.artifactIdsByTag("alpha")).toContain(a.id)
    expect((await store.tagCounts(ORG)).find((t) => t.tag === "alpha")?.count).toBeGreaterThan(0)
    // Replacing drops the old tags.
    await store.setArtifactTags(a.id, ["alpha"])
    expect(await store.artifactIdsByTag("beta")).not.toContain(a.id)
  })
})

describe("sqlite store: collections", () => {
  it("creates a collection, adds/removes items, tracks membership roles", async () => {
    const a = await store.createArtifact(newArtifact())
    const col = await store.createCollection({
      id: uuid(),
      org_id: ORG,
      title: "Reading",
      created_by: "amy",
    })
    expect(await store.getCollection(col.id)).toMatchObject({ title: "Reading" })
    await store.addCollectionItem(col.id, a.id)
    expect(await store.collectionArtifactIds(col.id)).toContain(a.id)
    expect(await store.collectionIdsForArtifact(a.id)).toContain(col.id)
    expect((await store.listCollections(ORG)).find((c) => c.id === col.id)?.count).toBe(1)

    await store.setCollectionMember({
      id: uuid(),
      collection_id: col.id,
      user_id: "bob",
      role: "viewer",
    })
    expect(await store.getCollectionMember(col.id, "bob")).toMatchObject({ role: "viewer" })
    expect(await store.listCollectionMembers(col.id)).toHaveLength(1)
    expect(await store.collectionRolesForArtifact(a.id, "bob")).toContain("viewer")

    const renamed = await store.updateCollection(col.id, { title: "Renamed" })
    expect(renamed?.title).toBe("Renamed")
    await store.removeCollectionItem(col.id, a.id)
    expect(await store.collectionArtifactIds(col.id)).not.toContain(a.id)
    await store.removeCollectionMember(col.id, "bob")
    await store.deleteCollection(col.id)
    expect(await store.getCollection(col.id)).toBeNull()
  })
})

describe("sqlite store: proposals (reviews)", () => {
  it("creates proposals, lists open ones, records a decision", async () => {
    const a = await store.createArtifact(newArtifact())
    const p = await store.createProposal({
      id: uuid(),
      artifact_id: a.id,
      blob_key: `blob_${uuid()}`,
      content_type: "text/html",
      kind: "file",
      title: "proposed",
      message: "please review",
      author: "bob",
      base_version: 1,
    })
    expect(await store.getProposal(p.id)).toMatchObject({ state: "open" })
    expect(await store.listProposals(a.id, { state: "open" })).toHaveLength(1)
    expect((await store.openProposalCounts([a.id]))[a.id]).toBe(1)
    const decided = await store.decideProposal(p.id, {
      state: "approved",
      decided_by: "amy",
      decided_version: 2,
      decision_note: "lgtm",
    })
    expect(decided?.state).toBe("approved")
    expect((await store.openProposalCounts([a.id]))[a.id] ?? 0).toBe(0)
  })
})

describe("sqlite store: views + analytics", () => {
  it("records views and aggregates stats, de-dups, prunes", async () => {
    const a = await store.createArtifact(newArtifact())
    await store.recordView({
      id: uuid(),
      artifact_id: a.id,
      version: 1,
      viewer: "amy",
      viewer_kind: "user",
    })
    await store.recordView({
      id: uuid(),
      artifact_id: a.id,
      version: 1,
      viewer: "anon1",
      viewer_kind: "anon",
    })
    const stats = await store.viewStats(a.id)
    expect(stats.total).toBe(2)
    expect(stats.unique).toBe(2)
    expect(stats.anonViewers).toBe(1)
    expect((await store.viewCounts([a.id]))[a.id]).toBe(2)
    expect(await store.viewedSince(a.id, "amy", 1, "2000-01-01T00:00:00.000Z")).toBe(true)
    // Cleanup helpers.
    expect(await store.pruneViewsByViewers(["amy"])).toBeGreaterThanOrEqual(1)
    expect(await store.pruneViews("2999-01-01T00:00:00.000Z")).toBeGreaterThanOrEqual(1)
  })
})

describe("sqlite store: webhooks + outbox", () => {
  it("registers a webhook, enqueues a delivery, claims it under lease, updates it", async () => {
    const a = await store.createArtifact(newArtifact())
    const wh = await store.createWebhook({
      id: uuid(),
      org_id: ORG,
      url: "https://hook.example/x",
      secret: "s",
      kind: "generic",
      events: "version.published",
    })
    expect(await store.getWebhook(wh.id, ORG)).toMatchObject({ url: "https://hook.example/x" })
    expect(await store.listWebhooks(ORG)).toHaveLength(1)
    expect((await store.activeWebhooks(a.id, ORG)).length).toBeGreaterThanOrEqual(1)

    const d = {
      id: uuid(),
      webhook_id: wh.id,
      url: wh.url,
      secret: "s",
      kind: "generic" as const,
      event_type: "version.published",
      payload: "{}",
    }
    await store.enqueueDelivery(d)
    const claimed = await store.claimDueDeliveries(
      new Date().toISOString(),
      10,
      "2999-01-01T00:00:00.000Z",
    )
    expect(claimed.map((x) => x.id)).toContain(d.id)
    // A second claim finds nothing (the first lease hides it).
    expect(
      await store.claimDueDeliveries(new Date().toISOString(), 10, "2999-01-01T00:00:00.000Z"),
    ).toHaveLength(0)
    await store.updateDelivery(d.id, {
      status: "delivered",
      attempts: 1,
      last_error: null,
      next_attempt_at: new Date().toISOString(),
    })
    expect((await store.recentDeliveries(wh.id, 10)).find((x) => x.id === d.id)?.status).toBe(
      "delivered",
    )
    await store.deleteWebhook(wh.id, ORG)
    expect(await store.getWebhook(wh.id, ORG)).toBeNull()
  })
})

describe("sqlite store: domains", () => {
  it("claims a host (globally unique), updates status, releases it", async () => {
    const a = await store.createArtifact(newArtifact())
    const host = `${uuid().slice(0, 8)}.dockd.app`
    const dom = await store.setDomain({ host, artifact_id: a.id, org_id: ORG, kind: "subdomain" })
    expect(dom).toMatchObject({ host })
    expect(await store.getDomain(host)).toMatchObject({ host })
    // A second claim of the same host returns null (taken).
    expect(await store.setDomain({ host, org_id: ORG, kind: "custom" })).toBeNull()
    expect(await store.getArtifactDomains(a.id)).toHaveLength(1)
    await store.updateDomain(host, { status: "active" })
    expect((await store.getDomain(host))?.status).toBe("active")
    await store.deleteDomain(host, ORG)
    expect(await store.getDomain(host)).toBeNull()
  })
})

describe("sqlite store: notifications", () => {
  it("creates per-recipient notifications, counts unread, marks read", async () => {
    const a = await store.createArtifact(newArtifact())
    const base = {
      actor: "bob",
      kind: "mention" as const,
      artifact_id: a.id,
      artifact_short_id: a.short_id,
      artifact_title: "Doc",
      thread_id: uuid(),
      comment_id: uuid(),
      preview: "hey",
    }
    await store.createNotification({ id: uuid(), user_id: "amy", ...base })
    await store.createNotification({ id: uuid(), user_id: "amy", ...base })
    expect(await store.unreadNotificationCount("amy")).toBe(2)
    expect(await store.listNotifications("amy", 10)).toHaveLength(2)
    await store.markNotificationsRead("amy", "all")
    expect(await store.unreadNotificationCount("amy")).toBe(0)
  })
})

describe("sqlite store: agents", () => {
  it("creates an agent, resolves it by token, queues + acks mentions", async () => {
    const a = await store.createArtifact(newArtifact())
    const token = `tok_${uuid()}`
    const agent = await store.createAgent({
      id: uuid(),
      org_id: ORG,
      name: "bot",
      token,
      role: "editor",
    })
    expect(await store.getAgentByToken(token)).toMatchObject({ id: agent.id })
    expect(await store.listAgents(ORG)).toHaveLength(1)
    const m = {
      id: uuid(),
      agent_id: agent.id,
      artifact_id: a.id,
      artifact_short_id: a.short_id,
      comment_id: uuid(),
      thread_id: uuid(),
      body: "@bot help",
      author: "amy",
    }
    await store.createAgentMention(m)
    const pending = await store.listPendingAgentMentions(agent.id, 10)
    expect(pending).toHaveLength(1)
    expect(await store.ackAgentMention(agent.id, m.id)).toBe(true)
    expect(await store.listPendingAgentMentions(agent.id, 10)).toHaveLength(0)
    await store.deleteAgent(agent.id, ORG)
    expect(await store.getAgentByToken(token)).toBeNull()
  })
})

describe("sqlite store: moderation (reports, takedown, audit)", () => {
  it("files a report, transitions it, takes down an artifact, logs the action", async () => {
    const a = await store.createArtifact(newArtifact())
    const r = await store.createReport({
      id: uuid(),
      org_id: ORG,
      artifact_id: a.id,
      artifact_short_id: a.short_id,
      reason: "spam",
      detail: "looks off",
    })
    expect(await store.getReport(r.id, ORG)).toMatchObject({ reason: "spam" })
    expect(await store.countOpenReports(ORG)).toBeGreaterThanOrEqual(1)
    expect((await store.listReports(ORG, { state: "open" })).map((x) => x.id)).toContain(r.id)
    await store.setReportState(r.id, "actioned", ORG)
    expect((await store.getReport(r.id, ORG))?.state).toBe("actioned")

    await store.setArtifactRemoved(a.id, new Date().toISOString())
    expect((await store.getArtifactById(a.id))?.removed_at).toBeTruthy()
    await store.setArtifactRemoved(a.id, null)
    expect((await store.getArtifactById(a.id))?.removed_at).toBeFalsy()

    await store.createAuditLog({
      id: uuid(),
      org_id: ORG,
      action: "takedown",
      artifact_id: a.id,
      actor: "amy",
      detail: "removed",
    })
    const log = await store.listAuditLog(ORG, { artifactId: a.id })
    expect(log.map((x) => x.action)).toContain("takedown")
  })
})

describe("sqlite store: user directory (Better Auth `user` table)", () => {
  it("tolerates the user table being absent (unmigrated fresh store)", async () => {
    // The user-dir methods read Better Auth's table, created out-of-band. Without it
    // they swallow the error and return empty rather than throwing.
    const fresh = new SqliteMetaStore(":memory:")
    expect(await fresh.findUserByEmail("nobody@x.com")).toBeNull()
    expect(await fresh.getUsers(["x"])).toEqual([])
    fresh.close()
  })

  it("resolves seeded users by email and id", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "dock-db-user-"))
    const path = join(dir, "store.db")
    const s = new SqliteMetaStore(path)
    const raw = new Database(path)
    raw.exec(
      `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT)`,
    )
    raw
      .prepare(`INSERT INTO user (id, email, name, image) VALUES (?,?,?,?)`)
      .run("u1", "amy@x.com", "Amy", null)
    raw.close()
    expect(await s.findUserByEmail("amy@x.com")).toMatchObject({ id: "u1", name: "Amy" })
    expect((await s.getUsers(["u1"])).map((u) => u.email)).toEqual(["amy@x.com"])
    expect(await s.getUsers([])).toEqual([])
    s.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
