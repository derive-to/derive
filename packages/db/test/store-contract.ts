import { randomUUID as uuid } from "node:crypto"
import type {
  MetaStore,
  NewArtifact,
  NewRun,
  NewVersion,
  SortMode,
  SubscriptionRecord,
} from "@derive/core"
import { DEFAULT_ORG_SETTINGS, maxRole } from "@derive/core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * The MetaStore contract, run against a concrete store. The cross-dialect query
 * layer (repos.ts) plus each driver (sqlite.ts / pg.ts) implement the same
 * interface, so the SAME assertions must hold on both — a wrong WHERE, a missing
 * org scope, or a broken transaction in either driver fails here. sqlite-store runs
 * this on in-memory SQLite (zero-config, every `pnpm test`); pg-store runs it on a
 * real Postgres when DERIVE_TEST_DB=pg (the `pnpm test:pg` / CI pg job), which is the
 * only place pg.ts gets exercised by this package's own suite.
 *
 * `setup` provisions an isolated store; `cleanup` tears it down (close the handle,
 * drop the pg schema). The user-directory methods (Better Auth's out-of-band table)
 * are dialect-specific and tested separately, not here.
 */
export function runStoreContract(
  label: string,
  setup: () => Promise<{ store: MetaStore; cleanup: () => void | Promise<void> }>,
): void {
  const ORG = `org_${uuid()}`
  let store: MetaStore
  let cleanup: () => void | Promise<void>

  // Default: a fully public doc (workspace seats + a world view link + listed in the
  // public directory) — the access-model v2 analogue of the old `visibility: public`.
  const newArtifact = (over: Partial<NewArtifact> = {}): NewArtifact => ({
    id: uuid(),
    short_id: uuid().slice(0, 8),
    org_id: ORG,
    slug: "doc",
    title: "Doc",
    workspace_access: "member",
    link_role: "viewer",
    listed: "public",
    kind: "file",
    spa: 0,
    ...over,
  })

  const newVersion = (over: Partial<NewVersion> = {}): NewVersion => ({
    id: uuid(),
    blob_key: `blob_${uuid()}`,
    content_type: "text/html",
    author: "amy",
    message: "v",
    size_bytes: 10,
    ...over,
  })

  beforeAll(async () => {
    ;({ store, cleanup } = await setup())
  })
  afterAll(async () => {
    await cleanup()
  })

  describe(`${label}: workspaces + memberships`, () => {
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

    it("workspacesAndOauthBinding matches the two calls it replaces", async () => {
      const orgA = `org_${uuid()}`
      const orgB = `org_${uuid()}`
      const user = `owc_${uuid()}`
      const client = `client_${uuid()}`
      await store.setWorkspace(orgA, "A")
      await store.setWorkspace(orgB, "B")
      await store.setMembership({ id: uuid(), org_id: orgA, user_id: user, role: "owner" })
      await store.setMembership({ id: uuid(), org_id: orgB, user_id: user, role: "editor" })

      // No grant binding yet — bound is empty ("all workspaces"), mine is unaffected.
      const unbound = await store.workspacesAndOauthBinding(user, client)
      expect(unbound.mine).toEqual(await store.listWorkspaces(user))
      expect(unbound.bound).toEqual([])

      // The consent multi-select narrows to orgA only.
      await store.setOAuthClientWorkspaces(user, client, [orgA])
      const bound = await store.workspacesAndOauthBinding(user, client)
      expect(bound.mine).toEqual(await store.listWorkspaces(user))
      expect(bound.bound).toEqual([orgA])

      // A DIFFERENT client's binding never leaks into this one's `bound`.
      const otherClient = `client_${uuid()}`
      expect((await store.workspacesAndOauthBinding(user, otherClient)).bound).toEqual([])

      // Empty clientId (a registered dk_agt_ token has none) never matches any binding.
      expect((await store.workspacesAndOauthBinding(user, "")).bound).toEqual([])
    })
  })

  describe(`${label}: artifacts + versions`, () => {
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

    it("sets source_path (the synced-file location) independently of the title", async () => {
      const a = await store.createArtifact(newArtifact({ title: "Taxonomy System" }))
      expect((await store.getArtifactById(a.id))?.source_path).toBeNull() // null by default
      await store.setArtifactSourcePath(a.id, "packages/core/ai-services/TAXONOMY.md")
      const got = await store.getArtifactById(a.id)
      expect(got?.source_path).toBe("packages/core/ai-services/TAXONOMY.md")
      expect(got?.title).toBe("Taxonomy System") // title untouched
      await store.setArtifactSourcePath(a.id, null)
      expect((await store.getArtifactById(a.id))?.source_path).toBeNull()
    })

    it("appends versions, bumps current_version, lists newest data", async () => {
      const a = await store.createArtifact(newArtifact())
      // updated_at is null until first versioned (read as updated_at ?? created_at).
      expect(a.updated_at).toBeNull()
      const v1 = await store.addVersion(a.id, newVersion({ message: "first" }))
      const v2 = await store.addVersion(a.id, newVersion({ message: "second" }))
      expect(v1.n).toBe(1)
      expect(v2.n).toBe(2)
      const after = await store.getByShortId(a.short_id)
      expect(after?.current_version).toBe(2)
      // A new version sets updated_at (>= create time) — drives recency sort + label.
      expect(after?.updated_at && after.updated_at >= a.created_at).toBe(true)
      expect(await store.listVersions(a.id)).toHaveLength(2)
      expect((await store.getVersion(a.id, 1))?.message).toBe("first")
      expect(await store.getVersion(a.id, 99)).toBeNull()
    })

    it("stores and reads a version's facts by name and all-at-once", async () => {
      const a = await store.createArtifact(newArtifact())
      const v = await store.addVersion(a.id, newVersion())
      await store.setVersionData(a.id, v.n, [
        { id: uuid(), slot: "checks", json: `{"pass":44}`, size_bytes: 11, gen: 1 },
        { id: uuid(), slot: "budget", json: "[1,2]", size_bytes: 5, gen: 1 },
      ])
      // All facts, ordered by fact name.
      const all = await store.getVersionData(a.id, v.n)
      expect(all.map((r) => r.slot)).toEqual(["budget", "checks"])
      expect(all[0]?.gen).toBe(1)
      // One slot by name.
      const one = await store.getVersionData(a.id, v.n, "checks")
      expect(one).toHaveLength(1)
      expect(one[0]?.json).toBe(`{"pass":44}`)
      expect(one[0]?.size_bytes).toBe(11)
      // A missing slot / version ⇒ empty.
      expect(await store.getVersionData(a.id, v.n, "nope")).toEqual([])
      expect(await store.getVersionData(a.id, 999)).toEqual([])
    })

    it("setVersionData replaces a version's facts idempotently (delete-then-insert)", async () => {
      const a = await store.createArtifact(newArtifact())
      const v = await store.addVersion(a.id, newVersion())
      await store.setVersionData(a.id, v.n, [
        { id: uuid(), slot: "x", json: "1", size_bytes: 1, gen: 1 },
      ])
      // Re-extract the same version with a different set — the old rows are gone.
      await store.setVersionData(a.id, v.n, [
        { id: uuid(), slot: "y", json: "2", size_bytes: 1, gen: 1 },
      ])
      const all = await store.getVersionData(a.id, v.n)
      expect(all.map((r) => r.slot)).toEqual(["y"])
      // Empty set clears them entirely.
      await store.setVersionData(a.id, v.n, [])
      expect(await store.getVersionData(a.id, v.n)).toEqual([])
    })

    it("reads one slot across a version range, oldest first, in one query", async () => {
      const a = await store.createArtifact(newArtifact())
      // Five versions, each carrying "checks"; only some carry "other".
      for (let day = 1; day <= 5; day++) {
        const v = await store.addVersion(a.id, newVersion())
        const rows = [
          { id: uuid(), slot: "checks", json: `{"day":${day}}`, size_bytes: 11, gen: 1 },
          ...(day % 2 === 1
            ? [{ id: uuid(), slot: "other", json: `${day}`, size_bytes: 1, gen: 1 }]
            : []),
        ]
        await store.setVersionData(a.id, v.n, rows)
      }

      const all = await store.getVersionDataSeries(a.id, "checks", 1, 5, 100)
      expect(all.map((r) => r.n)).toEqual([1, 2, 3, 4, 5])
      expect(all.map((r) => r.json)).toEqual([1, 2, 3, 4, 5].map((d) => `{"day":${d}}`))
      // Scoped to the named slot only.
      expect((await store.getVersionDataSeries(a.id, "other", 1, 5, 100)).map((r) => r.n)).toEqual([
        1, 3, 5,
      ])
      // Sub-range, and a range covering versions that carry nothing.
      expect((await store.getVersionDataSeries(a.id, "checks", 2, 3, 100)).map((r) => r.n)).toEqual(
        [2, 3],
      )
      expect(await store.getVersionDataSeries(a.id, "nosuch", 1, 5, 100)).toEqual([])
      // The limit bounds the payload and keeps the OLDEST, so paging is predictable.
      expect((await store.getVersionDataSeries(a.id, "checks", 1, 5, 2)).map((r) => r.n)).toEqual([
        1, 2,
      ])
    })

    it("reads one slot across artifacts, and only from each one's CURRENT version", async () => {
      // Two artifacts carry "xchecks"; one of them moves on to a new version, and the
      // cross-artifact read must report the NEW value — reporting a superseded row as the
      // present state is the failure that would make this quietly wrong.
      const a = await store.createArtifact(newArtifact({ title: "Nightly A" }))
      const v1 = await store.addVersion(a.id, newVersion())
      await store.setVersionData(a.id, v1.n, [
        { id: uuid(), slot: "xchecks", json: '{"pass":1}', size_bytes: 11, gen: 1 },
      ])
      const v2 = await store.addVersion(a.id, newVersion())
      await store.setVersionData(a.id, v2.n, [
        { id: uuid(), slot: "xchecks", json: '{"pass":2}', size_bytes: 11, gen: 1 },
      ])
      const b = await store.createArtifact(newArtifact({ title: "Nightly B" }))
      const bv = await store.addVersion(b.id, newVersion())
      await store.setVersionData(b.id, bv.n, [
        { id: uuid(), slot: "xchecks", json: '{"pass":9}', size_bytes: 11, gen: 1 },
        { id: uuid(), slot: "xother", json: "1", size_bytes: 1, gen: 1 },
      ])

      const rows = await store.listFactAcrossArtifacts(ORG, "xchecks")
      const byId = new Map(rows.map((r) => [r.short_id, r]))
      expect(byId.get(a.short_id)?.json).toBe('{"pass":2}') // the current version, not v1
      expect(byId.get(a.short_id)?.n).toBe(v2.n)
      expect(byId.get(b.short_id)?.json).toBe('{"pass":9}')
      // A fact nobody carries is empty, not an error.
      expect(await store.listFactAcrossArtifacts(ORG, "nosuch")).toEqual([])
      // The limit bounds the payload.
      expect((await store.listFactAcrossArtifacts(ORG, "xchecks", { limit: 1 })).length).toBe(1)
    })

    it("inverts $links into backlinks — candidates the caller confirms, current version only", async () => {
      // The corpus inversion. Every assertion here is a way the scan can be quietly wrong,
      // and quietly wrong is the whole risk: an index that under-reports reads exactly like
      // an artifact nothing links to.
      const target = "tgt99999"
      const linker = await store.createArtifact(newArtifact({ title: "Linker" }))
      const lv = await store.addVersion(linker.id, newVersion())
      await store.setDerivedVersionData(linker.id, lv.n, [
        {
          id: uuid(),
          slot: "$links",
          json: `{"refs":["${target}","zzzz0000"]}`,
          size_bytes: 40,
          gen: 2,
        },
      ])
      // SUPERSEDED: v1 links to the target, v2 does not. The current-version join must drop it.
      const moved = await store.createArtifact(newArtifact({ title: "Moved on" }))
      const mv1 = await store.addVersion(moved.id, newVersion())
      await store.setDerivedVersionData(moved.id, mv1.n, [
        { id: uuid(), slot: "$links", json: `{"refs":["${target}"]}`, size_bytes: 26, gen: 2 },
      ])
      const mv2 = await store.addVersion(moved.id, newVersion())
      await store.setDerivedVersionData(moved.id, mv2.n, [
        { id: uuid(), slot: "$links", json: '{"refs":["zzzz0000"]}', size_bytes: 26, gen: 2 },
      ])
      // NEAR MISSES the quote anchoring must exclude, and the one only the caller's parse
      // can: an unquoted occurrence inside another string is a candidate, not an edge.
      const embedded = await store.createArtifact(newArtifact({ title: "Embedded" }))
      const ev = await store.addVersion(embedded.id, newVersion())
      await store.setDerivedVersionData(embedded.id, ev.n, [
        { id: uuid(), slot: "$links", json: `{"refs":["x${target}y"]}`, size_bytes: 30, gen: 2 },
      ])
      const substring = await store.createArtifact(newArtifact({ title: "Substring" }))
      const sv = await store.addVersion(substring.id, newVersion())
      await store.setDerivedVersionData(substring.id, sv.n, [
        {
          id: uuid(),
          slot: "$links",
          json: `{"refs":["zzzz0000"],"titles":{"${target}":"Some doc"}}`,
          size_bytes: 60,
          gen: 2,
        },
      ])

      const rows = await store.listArtifactsLinkingTo(ORG, target)
      const ids = rows.map((r) => r.short_id)
      expect(ids).toContain(linker.short_id)
      expect(ids).not.toContain(moved.short_id) // superseded, via the current-version join
      expect(ids).not.toContain(embedded.short_id) // "xtgt99999y" is not "tgt99999"
      // The quote anchoring is exact only while $links holds nothing but `refs`. This row is
      // what a FOURTH deriver output looks like — the ref quoted as an object KEY — and it
      // survives the LIKE. It must die on the caller's parse, which is why the store returns
      // `json` and calls these candidates rather than answers.
      const confirmed = rows.filter((r) => (JSON.parse(r.json).refs ?? []).includes(target))
      expect(ids).toContain(substring.short_id)
      expect(confirmed.map((r) => r.short_id)).not.toContain(substring.short_id)

      // CASE: SQLite's LIKE is ASCII case-insensitive and Postgres's is not. Whatever each
      // dialect's candidate set, the confirmed answer must be identical on both.
      const upper = await store.createArtifact(newArtifact({ title: "Upper" }))
      const uv = await store.addVersion(upper.id, newVersion())
      await store.setDerivedVersionData(upper.id, uv.n, [
        { id: uuid(), slot: "$links", json: '{"refs":["TGT99999"]}', size_bytes: 26, gen: 2 },
      ])
      const afterUpper = await store.listArtifactsLinkingTo(ORG, target)
      expect(
        afterUpper
          .filter((r) => (JSON.parse(r.json).refs ?? []).includes(target))
          .map((r) => r.short_id),
      ).not.toContain(upper.short_id)

      // A tombstoned linker is out of the library, so out of the graph.
      await store.setArtifactRemoved(linker.id, new Date().toISOString())
      expect(
        (await store.listArtifactsLinkingTo(ORG, target)).map((r) => r.short_id),
      ).not.toContain(linker.short_id)

      // A self-link is an edge like any other — the deriver records it, so the inversion does.
      const selfy = await store.createArtifact(newArtifact({ title: "Selfy" }))
      const yv = await store.addVersion(selfy.id, newVersion())
      await store.setDerivedVersionData(selfy.id, yv.n, [
        {
          id: uuid(),
          slot: "$links",
          json: `{"refs":["${selfy.short_id}"]}`,
          size_bytes: 30,
          gen: 2,
        },
      ])
      expect(
        (await store.listArtifactsLinkingTo(ORG, selfy.short_id)).map((r) => r.short_id),
      ).toContain(selfy.short_id)

      // gen rides along so the caller can say the index is older than the deriver, and `at`
      // is the artifact's activity time — NOT version_data.created_at, which for a lazily
      // derived row is when the host got round to indexing.
      const self = (await store.listArtifactsLinkingTo(ORG, selfy.short_id))[0]
      expect(self?.gen).toBe(2)
      expect(self?.at).toBeTruthy()
      // Nothing links to an id nobody references; a malformed ref is empty, never a wildcard.
      expect(await store.listArtifactsLinkingTo(ORG, "nosuch99")).toEqual([])
      expect(await store.listArtifactsLinkingTo(ORG, "%")).toEqual([])
      expect((await store.listArtifactsLinkingTo(ORG, target, { limit: 1 })).length).toBe(1)
    })

    it("lists the workspace's slot vocabulary as RAW rows, uncounted, carrying artifact_id", async () => {
      const rows = await store.listWorkspaceFacts(ORG)
      // Deliberately (slot, artifact) pairs rather than counts: the count has to be taken
      // AFTER the caller's visibility gate, so the artifact_id it gates on must survive
      // this far. A pre-aggregated count would already include artifacts the caller may
      // not read, with the evidence needed to correct it thrown away.
      const checks = rows.filter((r) => r.slot === "xchecks")
      expect(new Set(checks.map((r) => r.artifact_id)).size).toBeGreaterThanOrEqual(2)
      expect(rows.filter((r) => r.slot === "xother").length).toBe(1)
      expect(checks[0]?.at).toBeTruthy()
      expect(rows.every((r) => !!r.artifact_id)).toBe(true)
      expect((await store.listWorkspaceFacts(ORG, { limit: 1 })).length).toBe(1)
    })

    it("filters listArtifacts by title search and by id set (empty ⇒ none)", async () => {
      const a = await store.createArtifact(newArtifact({ title: "Quarterly Report XYZ" }))
      expect((await store.listArtifacts({ q: "quarterly report xyz" })).map((x) => x.id)).toContain(
        a.id,
      )
      expect((await store.listArtifacts({ ids: [a.id] })).map((x) => x.id)).toEqual([a.id])
      expect(await store.listArtifacts({ ids: [] })).toEqual([])
    })

    it("setAccess changes the access triple (and sets/clears the password lock)", async () => {
      const a = await store.createArtifact(
        newArtifact({ workspace_access: "none", link_role: "none", listed: "none" }),
      )
      // Fail-closed store defaults when nothing's stamped.
      expect(a.workspace_access).toBe("none")
      expect(a.link_role).toBe("none")
      expect(a.listed).toBe("none")
      // A locked public doc: listed public + a password hash + a world view link.
      await store.setAccess(a.id, "member", "public", "viewer", "hash123")
      expect(await store.getByShortId(a.short_id)).toMatchObject({
        workspace_access: "member",
        listed: "public",
        password_hash: "hash123",
        link_role: "viewer",
      })
      // Unlock it and grant comment: hash cleared, the triple round-trips.
      await store.setAccess(a.id, "member", "public", "commenter", null)
      expect(await store.getByShortId(a.short_id)).toMatchObject({
        listed: "public",
        password_hash: null,
        link_role: "commenter",
      })
      // Editor — the full range.
      await store.setAccess(a.id, "member", "public", "editor", null)
      expect((await store.getByShortId(a.short_id))?.link_role).toBe("editor")
      // Back to invite-only (all off).
      await store.setAccess(a.id, "none", "none", "none", null)
      expect(await store.getByShortId(a.short_id)).toMatchObject({
        workspace_access: "none",
        listed: "none",
        link_role: "none",
      })
    })

    it("the world link is independent of listing — an unlisted artifact carries a live link", async () => {
      const a = await store.createArtifact(
        newArtifact({ workspace_access: "member", link_role: "none", listed: "none" }),
      )
      expect(a.link_role).toBe("none")
      // Unlisted, workspace seats + a world comment link (a shareable draft).
      await store.setAccess(a.id, "member", "none", "commenter", null)
      expect(await store.getByShortId(a.short_id)).toMatchObject({
        listed: "none",
        workspace_access: "member",
        link_role: "commenter",
      })
      // Unlisted, world view link, no workspace access (external-only).
      await store.setAccess(a.id, "none", "none", "viewer", null)
      expect(await store.getByShortId(a.short_id)).toMatchObject({
        listed: "none",
        workspace_access: "none",
        link_role: "viewer",
      })
    })

    it("createArtifact stamps an explicit access triple (the publish() path)", async () => {
      const a = await store.createArtifact(
        newArtifact({ workspace_access: "member", link_role: "commenter", listed: "none" }),
      )
      expect(a.workspace_access).toBe("member")
      expect(a.link_role).toBe("commenter")
      expect(a.listed).toBe("none")
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

  describe(`${label}: listArtifacts sort modes`, () => {
    // Space the creations far enough apart to land on DISTINCT created_at values.
    // This was 2ms, which is under the timer granularity of some virtualized
    // hosts: on a 16-vCPU CI runner two rows inserted 2ms apart came back with the
    // SAME timestamp, so `created` fell through to its `id` tiebreak — and since
    // ids are random uuids, the expected order then held or didn't by luck.
    // Nothing was wrong with the store; that tiebreak is exactly what keeps
    // production ordering deterministic under a tie. The test simply needs
    // distinct instants, and created_at is stamped by the store's own SQL default,
    // so wall-clock spacing is the only lever available. 25ms clears any plausible
    // tick and costs 75ms across the whole test.
    const tick = () => new Promise((r) => setTimeout(r, 25))

    it("orders by each mode (title sort case-insensitive + null-safe) and paginates the keyset", async () => {
      const org = `org_sort_${uuid()}`
      // Titles chosen so case-SENSITIVE byte order (B=66 < a=97) would rank "Banana" before
      // "apple", but the store's lower() ranks "apple" first — the az/za assertions only hold if
      // lower(coalesce(title,'')) is actually applied. `nullish` has a null title to exercise
      // coalesce(title,'') (sorts as "" → first under az) deterministically on both dialects.
      const banana = await store.createArtifact(newArtifact({ org_id: org, title: "Banana" }))
      await tick()
      const apple = await store.createArtifact(newArtifact({ org_id: org, title: "apple" }))
      await tick()
      const cherry = await store.createArtifact(newArtifact({ org_id: org, title: "cherry" }))
      await tick()
      const nullish = await store.createArtifact(newArtifact({ org_id: org, title: null }))
      // updated_at: distinct + independent of created order (banana oldest-created but
      // newest-updated); nullish left versionless (updated_at null → coalesces to its created_at).
      await store.setArtifactUpdatedAt(banana.id, "2030-01-01T00:00:00.000Z")
      await store.setArtifactUpdatedAt(apple.id, "2029-01-01T00:00:00.000Z")
      await store.setArtifactUpdatedAt(cherry.id, "2028-01-01T00:00:00.000Z")

      const ids = async (sort: SortMode) =>
        (await store.listArtifacts({ orgId: org, sort })).map((a) => a.id)

      // updated: banana(2030) > apple(2029) > cherry(2028) > nullish(its created_at, ~now < 2028).
      expect(await ids("updated")).toEqual([banana.id, apple.id, cherry.id, nullish.id])
      expect(await ids("updated-asc")).toEqual([nullish.id, cherry.id, apple.id, banana.id])
      // created (the store-side default) ignores versions: newest-created first.
      expect(await ids("created")).toEqual([nullish.id, cherry.id, apple.id, banana.id])
      // az: lower(coalesce(title,'')) → "" (nullish), "apple", "banana", "cherry". A case-sensitive
      // sort would rank "Banana"(66) before "apple"(97); this order proves it does not.
      expect(await ids("az")).toEqual([nullish.id, apple.id, banana.id, cherry.id])
      expect(await ids("za")).toEqual([cherry.id, banana.id, apple.id, nullish.id])

      // Keyset pagination under az across a page boundary reassembles the full set, no dup/gap.
      const p1 = await store.listArtifacts({ orgId: org, sort: "az", limit: 2 })
      const lastOfP1 = p1[p1.length - 1]
      const p2 = await store.listArtifacts({
        orgId: org,
        sort: "az",
        limit: 2,
        cursor: { key: lastOfP1.title ?? "", id: lastOfP1.id },
      })
      expect([...p1, ...p2].map((a) => a.id)).toEqual([nullish.id, apple.id, banana.id, cherry.id])
    })

    it("paginates title sort with no drop/dup, including a non-ASCII-uppercase title", async () => {
      const org = `org_sort_i18n_${uuid()}`
      // SQLite's lower() is ASCII-only (leaves Ü); the cursor key must be lowered by the same
      // engine as the ORDER BY or this row is dropped/duplicated at a page boundary.
      for (const t of ["Banana", "apple", "Über", "cherry", null]) {
        await store.createArtifact(newArtifact({ org_id: org, title: t }))
        await tick()
      }
      const full = (await store.listArtifacts({ orgId: org, sort: "az" })).map((a) => a.id)
      const walked: string[] = []
      let cursor: { key: string; id: string } | undefined
      for (let guard = 0; guard < 12; guard++) {
        const page = await store.listArtifacts({ orgId: org, sort: "az", limit: 1, cursor })
        if (page.length === 0) break
        walked.push(...page.map((a) => a.id))
        const last = page[page.length - 1]
        cursor = { key: last.title ?? "", id: last.id }
      }
      expect(walked).toEqual(full)
    })

    it("names the version bump as the newest work (the default's whole point)", async () => {
      const org = `org_bump_${uuid()}`
      const older = await store.createArtifact(newArtifact({ org_id: org, title: "older" }))
      await tick()
      const newer = await store.createArtifact(newArtifact({ org_id: org, title: "newer" }))
      // `older` is created first but gets a brand-new version → newest work.
      await store.setArtifactUpdatedAt(older.id, "2031-01-01T00:00:00.000Z")

      const updated = (await store.listArtifacts({ orgId: org, sort: "updated" })).map((a) => a.id)
      const created = (await store.listArtifacts({ orgId: org, sort: "created" })).map((a) => a.id)
      expect(updated).toEqual([older.id, newer.id]) // version bump wins
      expect(created).toEqual([newer.id, older.id]) // created ignores the bump
    })

    it("revised: re-versioned docs sort as one block above never-revised uploads", async () => {
      const org = `org_revised_${uuid()}`
      // Two genuinely revised docs (current_version >= 2), with controlled revise times.
      const reviseOld = await store.createArtifact(
        newArtifact({ org_id: org, title: "revise-old" }),
      )
      await store.addVersion(reviseOld.id, newVersion())
      await store.addVersion(reviseOld.id, newVersion())
      const reviseNew = await store.createArtifact(
        newArtifact({ org_id: org, title: "revise-new" }),
      )
      await store.addVersion(reviseNew.id, newVersion())
      await store.addVersion(reviseNew.id, newVersion())
      await store.setArtifactUpdatedAt(reviseOld.id, "2028-01-01T00:00:00.000Z")
      await store.setArtifactUpdatedAt(reviseNew.id, "2029-01-01T00:00:00.000Z")
      // A never-revised v1 upload with a DECEPTIVELY-new updated_at, and a versionless stub.
      const freshUpload = await store.createArtifact(newArtifact({ org_id: org, title: "fresh" }))
      await store.addVersion(freshUpload.id, newVersion()) // current_version = 1 (not revised)
      await store.setArtifactUpdatedAt(freshUpload.id, "2030-01-01T00:00:00.000Z")
      const stub = await store.createArtifact(newArtifact({ org_id: org, title: "stub" })) // v0

      const revisedIds = (await store.listArtifacts({ orgId: org, sort: "revised" })).map(
        (a) => a.id,
      )
      // Revised block first (newest revision first), then the never-revised uploads by activity.
      // freshUpload's 2030 stamp does NOT float it above the revised docs — it was never revised.
      expect(revisedIds).toEqual([reviseNew.id, reviseOld.id, freshUpload.id, stub.id])

      // Keyset pagination under `revised` reassembles that order one row at a time, no drop/dup.
      const walked: string[] = []
      let cursor: { key: string; id: string } | undefined
      for (let guard = 0; guard < 8; guard++) {
        const page = await store.listArtifacts({ orgId: org, sort: "revised", limit: 1, cursor })
        if (page.length === 0) break
        walked.push(...page.map((a) => a.id))
        const last = page[page.length - 1]
        const flag = last.current_version >= 2 ? "1:" : "0:"
        cursor = { key: `${flag}${last.updated_at ?? last.created_at}`, id: last.id }
      }
      expect(walked).toEqual(revisedIds)
    })
  })

  describe(`${label}: unlisted listings (the draft state)`, () => {
    it("shows unlisted rows to their members only — the owner's drafts stay theirs", async () => {
      const owner = `u_pv_owner_${uuid()}`
      const other = `u_pv_other_${uuid()}`
      const org = `${ORG}_pv_${uuid()}`
      const draft = await store.createArtifact(
        newArtifact({
          org_id: org,
          listed: "none",
          link_role: "none",
          workspace_access: "member",
          title: "Agent Draft Alpha",
        }),
      )
      await store.setArtifactMember({
        id: uuid(),
        artifact_id: draft.id,
        user_id: owner,
        role: "owner",
      })
      const listed = await store.createArtifact(
        newArtifact({ org_id: org, listed: "workspace", link_role: "none", title: "Team Doc" }),
      )

      // The owner sees their draft in an ordinary listing; a teammate never does —
      // not in the list, not via title search.
      const ownersView = (await store.listArtifacts({ orgId: org, viewerId: owner })).map(
        (x) => x.id,
      )
      expect(ownersView).toContain(draft.id)
      expect(ownersView).toContain(listed.id)
      const othersView = (await store.listArtifacts({ orgId: org, viewerId: other })).map(
        (x) => x.id,
      )
      expect(othersView).not.toContain(draft.id)
      expect(othersView).toContain(listed.id)
      expect(
        (await store.listArtifacts({ orgId: org, viewerId: other, q: "agent draft" })).map(
          (x) => x.id,
        ),
      ).toEqual([])

      // A trusted caller (no viewerId — operator/internal) still sees everything.
      expect((await store.listArtifacts({ orgId: org })).map((x) => x.id)).toContain(draft.id)
      // publicOnly (anonymous listings) never shows it.
      expect(
        (await store.listArtifacts({ orgId: org, publicOnly: true })).map((x) => x.id),
      ).not.toContain(draft.id)
    })

    it("keeps unlisted work off profiles, even across a shared workspace", async () => {
      const author = `u_pv_author_${uuid()}`
      const org = `${ORG}_pv_pp_${uuid()}`
      const draft = await store.createArtifact(
        newArtifact({ org_id: org, listed: "none", link_role: "none" }),
      )
      await store.addVersion(draft.id, newVersion({ author: "Author", author_id: author }))
      const works = await store.listUserWorks(author, [], { visibleOrgIds: [org] })
      expect(works.map((a) => a.id)).not.toContain(draft.id)
    })
  })

  describe(`${label}: author attribution (GitHub-synced)`, () => {
    it("denormalizes the version author onto the artifact, clearing GitHub fields on a non-GitHub edit", async () => {
      const a = await store.createArtifact(newArtifact())
      const v1 = await store.addVersion(
        a.id,
        newVersion({
          author: "Ada Lovelace",
          author_login: "ada",
          author_avatar: "https://avatars/ada.png",
          author_gh_id: "4242",
        }),
      )
      // The version row carries the full GitHub author…
      expect(v1).toMatchObject({
        author: "Ada Lovelace",
        author_login: "ada",
        author_avatar: "https://avatars/ada.png",
        author_gh_id: "4242",
      })
      // …and it's denormalized onto the artifact as the current author.
      expect(await store.getByShortId(a.short_id)).toMatchObject({
        author_name: "Ada Lovelace",
        author_login: "ada",
        author_avatar: "https://avatars/ada.png",
        author_gh_id: "4242",
      })

      // A later edit with no GitHub identity overwrites the current author and clears
      // the GitHub fields (the `?? null` denormalization branches).
      await store.addVersion(a.id, newVersion({ author: "bob" }))
      expect(await store.getByShortId(a.short_id)).toMatchObject({
        author_name: "bob",
        author_login: null,
        author_avatar: null,
        author_gh_id: null,
      })
      // The historical v1 keeps its own author; v2 has none.
      expect((await store.getVersion(a.id, 1))?.author_login).toBe("ada")
      expect((await store.getVersion(a.id, 2))?.author_login).toBeNull()
    })

    it("filters artifacts by author login (case-insensitive, org-scoped)", async () => {
      const mine = await store.createArtifact(newArtifact())
      await store.addVersion(mine.id, newVersion({ author: "Ada", author_login: "ada" }))
      expect(await store.artifactIdsByAuthor(ORG, "ada")).toContain(mine.id)
      expect(await store.artifactIdsByAuthor(ORG, "ADA")).toContain(mine.id) // case-insensitive
      expect(await store.artifactIdsByAuthor(ORG, "grace")).not.toContain(mine.id) // other login
      expect(await store.artifactIdsByAuthor(`${ORG}_other`, "ada")).not.toContain(mine.id) // other org
    })

    it("filters + counts artifacts by owner row (the library's Created-by-me filter)", async () => {
      const me = `u_owned_${uuid()}`
      const someoneElse = `u_owned_other_${uuid()}`
      const org = `${ORG}_owned_${uuid()}`
      const mine = await store.createArtifact(
        newArtifact({ org_id: org, listed: "none", link_role: "none", author_id: me }),
      )
      await store.setArtifactMember({
        id: uuid(),
        artifact_id: mine.id,
        user_id: me,
        role: "owner",
      })
      const theirs = await store.createArtifact(
        newArtifact({
          org_id: org,
          listed: "workspace",
          link_role: "none",
          author_id: someoneElse,
        }),
      )
      await store.setArtifactMember({
        id: uuid(),
        artifact_id: theirs.id,
        user_id: someoneElse,
        role: "owner",
      })
      // A non-owner share row must NOT put someone else's doc under "Created by me".
      await store.setArtifactMember({
        id: uuid(),
        artifact_id: theirs.id,
        user_id: me,
        role: "editor",
      })
      expect(await store.artifactIdsOwnedBy(org, me)).toEqual([mine.id])
      expect(await store.artifactIdsOwnedBy(org, someoneElse)).toEqual([theirs.id])
      expect(await store.countOwnedBy(org, me)).toBe(1)
      expect(await store.countOwnedBy(org, someoneElse)).toBe(1)
      // The listing narrow (the not-in-a-feed pending badge).
      expect(await store.countOwnedBy(org, me, "none")).toBe(1)
      expect(await store.countOwnedBy(org, me, "workspace")).toBe(0)
      // Scoped to the workspace — an owner row elsewhere doesn't leak in.
      expect(await store.countOwnedBy(`${org}_other`, me)).toBe(0)
    })

    it("keeps Created-by-me stable across republishes by others (owner row, not author_id)", async () => {
      // The exact flows that broke the author_id-keyed filter: a teammate
      // republishes your doc, then CI republishes with no author at all. The
      // artifact's denormalized author_id moves (to them, then to null) — the
      // owner row doesn't, and the filter keys on the row.
      const me = `u_owned_stable_${uuid()}`
      const org = `${ORG}_owned_stable_${uuid()}`
      const a = await store.createArtifact(
        newArtifact({ org_id: org, listed: "none", link_role: "none", author_id: me }),
      )
      await store.setArtifactMember({ id: uuid(), artifact_id: a.id, user_id: me, role: "owner" })

      await store.addVersion(
        a.id,
        newVersion({ author: "Teammate", author_id: `u_other_${uuid()}` }),
      )
      expect(await store.artifactIdsOwnedBy(org, me)).toEqual([a.id])

      await store.addVersion(a.id, newVersion({ author: "ci", author_id: null }))
      expect((await store.getArtifactById(a.id))?.author_id).toBeNull() // the denorm moved…
      expect(await store.artifactIdsOwnedBy(org, me)).toEqual([a.id]) // …the filter didn't
      expect(await store.countOwnedBy(org, me, "none")).toBe(1)
    })

    it("sets and clears the current author directly (the backfill path)", async () => {
      const a = await store.createArtifact(newArtifact())
      await store.setArtifactAuthor(a.id, {
        name: "Grace Hopper",
        login: "grace",
        avatar: "https://avatars/grace.png",
        ghId: "99",
      })
      expect(await store.getByShortId(a.short_id)).toMatchObject({
        author_name: "Grace Hopper",
        author_login: "grace",
        author_avatar: "https://avatars/grace.png",
        author_gh_id: "99",
      })
      // Null clears every author field.
      await store.setArtifactAuthor(a.id, null)
      expect(await store.getByShortId(a.short_id)).toMatchObject({
        author_name: null,
        author_login: null,
        author_avatar: null,
        author_gh_id: null,
      })
    })
  })

  describe(`${label}: comments + threads`, () => {
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

    it("computes per-artifact comment signals for a viewer (open threads, mentions, participation)", async () => {
      const me = `u_${uuid()}`
      const other = `u_${uuid()}`
      const a = await store.createArtifact(newArtifact())
      const mention = JSON.stringify({ mentions: [{ id: me, name: "Me" }] })
      // t1: OPEN, authored by other, @mentions me → mentions_me.
      const c1 = await store.createComment({
        id: uuid(),
        artifact_id: a.id,
        thread_id: "t1",
        base_version: 1,
        body_md: "hi",
        author: "other",
        author_id: other,
      })
      await store.updateComment(c1.id, { meta: mention })
      // t2: OPEN, authored by me → i_participated.
      await store.createComment({
        id: uuid(),
        artifact_id: a.id,
        thread_id: "t2",
        base_version: 1,
        body_md: "mine",
        author: "me",
        author_id: me,
      })
      // t3: RESOLVED, mentions me → must NOT count (only open threads signal).
      const c3 = await store.createComment({
        id: uuid(),
        artifact_id: a.id,
        thread_id: "t3",
        base_version: 1,
        body_md: "done",
        author: "other",
        author_id: other,
      })
      await store.updateComment(c3.id, { meta: mention })
      await store.setThreadState(a.id, "t3", "resolved")

      // The viewer sees 2 open threads, is mentioned, and participated.
      const sig = (await store.commentSignals([a.id], me))[a.id]
      expect(sig).toEqual({ open_threads: 2, mentions_me: true, i_participated: true })
      // An anonymous viewer gets the thread count but no personal flags.
      const anon = (await store.commentSignals([a.id], null))[a.id]
      expect(anon).toEqual({ open_threads: 2, mentions_me: false, i_participated: false })
      // Empty input ⇒ {}; an artifact with no comments has no entry.
      expect(await store.commentSignals([], me)).toEqual({})
      const blank = await store.createArtifact(newArtifact())
      expect((await store.commentSignals([blank.id], me))[blank.id]).toBeUndefined()
    })
  })

  describe(`${label}: shares, favorites, tags`, () => {
    it("sets and removes a per-artifact member (share)", async () => {
      const a = await store.createArtifact(newArtifact())
      await store.setArtifactMember({
        id: uuid(),
        artifact_id: a.id,
        user_id: "bob",
        role: "editor",
      })
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

    it("stars + unstars a collection, per user and idempotently", async () => {
      const col = await store.createCollection({
        id: uuid(),
        org_id: ORG,
        title: "Q3 planning",
        created_by: "amy",
      })
      await store.setCollectionFavorite(col.id, "amy")
      // Starring twice must not throw or double-insert — the rail reads this list
      // directly, so a duplicate would render the same row twice.
      await store.setCollectionFavorite(col.id, "amy")
      expect(await store.listUserFavoriteCollectionIds("amy")).toEqual([col.id])

      // A star is per user: amy's must not appear for bob.
      expect(await store.listUserFavoriteCollectionIds("bob")).not.toContain(col.id)

      await store.removeCollectionFavorite(col.id, "amy")
      expect(await store.listUserFavoriteCollectionIds("amy")).not.toContain(col.id)
      // Removing again is a no-op rather than an error.
      await store.removeCollectionFavorite(col.id, "amy")
    })

    it("reports the collections a user has worked in, and only those", async () => {
      const worked = await store.createCollection({
        id: uuid(),
        org_id: ORG,
        title: "Worked in",
        created_by: "amy",
      })
      const untouched = await store.createCollection({
        id: uuid(),
        org_id: ORG,
        title: "Never touched",
        created_by: "amy",
      })
      const a1 = await store.createArtifact(newArtifact())
      const a2 = await store.createArtifact(newArtifact())
      await store.addCollectionItem(worked.id, a1.id)
      await store.addCollectionItem(untouched.id, a2.id)

      const since = new Date(Date.now() - 30 * 86400_000).toISOString()
      // Nothing done yet. Creating a collection auto-adds you as its owner, and that
      // must NOT count — otherwise every shelf you ever made reads as active forever.
      expect(await store.collectionsWorkedIn("amy", ORG, since)).toEqual([])

      // A comment is a deliberate act, and it carries a stable author id.
      await store.createComment({
        id: uuid(),
        artifact_id: a1.id,
        thread_id: uuid(),
        base_version: 1,
        body_md: "looks right",
        author: "Amy",
        author_id: "amy",
      })
      expect(await store.collectionsWorkedIn("amy", ORG, since)).toEqual([worked.id])

      // Someone else's comment is not your activity.
      expect(await store.collectionsWorkedIn("bob", ORG, since)).toEqual([])

      // The window is real: an act older than `since` does not count.
      const future = new Date(Date.now() + 60_000).toISOString()
      expect(await store.collectionsWorkedIn("amy", ORG, future)).toEqual([])
    })

    it("previews a collection's newest artifacts, batched and capped", async () => {
      const shelf = await store.createCollection({
        id: uuid(),
        org_id: ORG,
        title: "Shelf",
        created_by: "amy",
      })
      const other = await store.createCollection({
        id: uuid(),
        org_id: ORG,
        title: "Other shelf",
        created_by: "amy",
      })
      // Five artifacts, oldest first, so the newest-first order is unambiguous.
      const made = []
      for (let i = 0; i < 5; i++) {
        const a = await store.createArtifact(
          newArtifact({ title: `Doc ${i}`, updated_at: `2026-01-0${i + 1}T00:00:00.000Z` }),
        )
        await store.addCollectionItem(shelf.id, a.id)
        made.push(a)
      }
      const lone = await store.createArtifact(newArtifact({ title: "Lone" }))
      await store.addCollectionItem(other.id, lone.id)

      const previews = await store.collectionPreviews([shelf.id, other.id], 3)
      // Capped per collection, newest first — the strip is a preview, not a listing.
      expect(previews[shelf.id]?.map((p) => p.short_id)).toEqual([
        made[4].short_id,
        made[3].short_id,
        made[2].short_id,
      ])
      // One call covers every collection on screen.
      expect(previews[other.id]?.map((p) => p.short_id)).toEqual([lone.short_id])

      // A deleted artifact leaves the strip — the shelf must not show a cover that
      // 404s when you click it.
      await store.setArtifactRemoved(made[4].id, new Date().toISOString())
      expect(previews[shelf.id]?.[0]?.short_id).toBe(made[4].short_id)
      const after = await store.collectionPreviews([shelf.id], 3)
      expect(after[shelf.id]?.map((p) => p.short_id)).toEqual([
        made[3].short_id,
        made[2].short_id,
        made[1].short_id,
      ])

      // An empty collection is absent rather than an empty array, and no ids means no
      // query at all.
      const empty = await store.createCollection({
        id: uuid(),
        org_id: ORG,
        title: "Empty",
        created_by: "amy",
      })
      expect((await store.collectionPreviews([empty.id], 3))[empty.id]).toBeUndefined()
      expect(await store.collectionPreviews([], 3)).toEqual({})
    })

    it("scopes starred collections to a workspace when one is given", async () => {
      const here = await store.createCollection({
        id: uuid(),
        org_id: ORG,
        title: "This workspace",
        created_by: "amy",
      })
      const elsewhere = await store.createCollection({
        id: uuid(),
        org_id: `org_${uuid()}`,
        title: "Another workspace",
        created_by: "amy",
      })
      await store.setCollectionFavorite(here.id, "amy")
      await store.setCollectionFavorite(elsewhere.id, "amy")

      // Unscoped: both, because the caller asked for every star this user holds.
      const all = await store.listUserFavoriteCollectionIds("amy")
      expect(all).toEqual(expect.arrayContaining([here.id, elsewhere.id]))

      // Scoped: only this workspace's — the rail must not show a star from a
      // workspace you have switched away from.
      const scoped = await store.listUserFavoriteCollectionIds("amy", ORG)
      expect(scoped).toContain(here.id)
      expect(scoped).not.toContain(elsewhere.id)
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

  describe(`${label}: list enrichment (the batched decoration call)`, () => {
    it("matches the individual queries it batches, per artifact", async () => {
      const me = `u_${uuid()}`
      const a = await store.createArtifact(newArtifact())
      const b = await store.createArtifact(newArtifact())
      // a: tags, a ready preview, views, an open comment thread, an open proposal, a share.
      await store.setArtifactTags(a.id, ["beta", "alpha"])
      await store.addVersion(a.id, newVersion())
      await store.setVersionPreview(a.id, 1, { preview_key: "png", preview_status: "ready" })
      await store.recordView({
        id: uuid(),
        artifact_id: a.id,
        version: 1,
        viewer: me,
        viewer_kind: "user",
      })
      await store.recordView({
        id: uuid(),
        artifact_id: a.id,
        version: 1,
        viewer: "x",
        viewer_kind: "anon",
      })
      await store.createComment({
        id: uuid(),
        artifact_id: a.id,
        thread_id: "t1",
        base_version: 1,
        body_md: "mine",
        author: "me",
        author_id: me,
      })
      await store.createProposal({
        id: uuid(),
        artifact_id: a.id,
        blob_key: `blob_${uuid()}`,
        content_type: "text/html",
        kind: "file",
        author: "amy",
        base_version: 1,
      })
      await store.setArtifactMember({ id: uuid(), artifact_id: a.id, user_id: me, role: "editor" })
      await store.setFavorite(a.id, me)

      const ids = [a.id, b.id]
      const enr = await store.listEnrichment({
        ids,
        ghIds: [],
        authorIds: [],
        viewerId: me,
        memberId: me,
        views: true,
      })
      // The batch must be indistinguishable from the calls it replaces.
      expect(enr.views).toEqual(await store.viewCounts(ids))
      expect(enr.tags).toEqual(await store.tagsForArtifacts(ids))
      expect(enr.previews).toEqual(await store.previewReady(ids))
      expect(enr.signals).toEqual(await store.commentSignals(ids, me))
      expect(enr.proposals).toEqual(await store.openProposalCounts(ids))
      expect(enr.shareRoles).toEqual(await store.artifactRolesFor(me, ids))
      // Page-scoped by contract: the whole-list call clipped to `ids`, which is what the
      // pg driver's arm returns natively and what the compose path has to narrow to.
      expect([...enr.favorites].sort()).toEqual(
        (await store.listUserFavoriteIds(me)).filter((id) => ids.includes(id)).sort(),
      )
      // Spot-check the shape is actually populated, not vacuously equal-empty.
      expect(enr.views[a.id]).toBe(2)
      expect(enr.tags[a.id]).toEqual(["alpha", "beta"])
      expect(enr.previews[a.id]).toBe(true)
      expect(enr.signals[a.id]?.open_threads).toBe(1)
      expect(enr.proposals[a.id]).toBe(1)
      expect(enr.shareRoles[a.id]).toBe("editor")
      expect(enr.favorites).toEqual([a.id])
      expect(enr.views[b.id]).toBeUndefined()
    })

    it("honors the gates: no views, no viewer, no member", async () => {
      const a = await store.createArtifact(newArtifact())
      await store.recordView({
        id: uuid(),
        artifact_id: a.id,
        version: 1,
        viewer: "x",
        viewer_kind: "anon",
      })
      const enr = await store.listEnrichment({
        ids: [a.id],
        ghIds: [],
        authorIds: [],
        viewerId: null,
        memberId: null,
        views: false,
      })
      expect(enr.views).toEqual({})
      expect(enr.signals).toEqual({})
      expect(enr.shareRoles).toEqual({})
      // No viewer ⇒ no star to report, on either driver.
      expect(enr.favorites).toEqual([])
    })

    it("degrades the user-directory pieces to empty instead of failing the listing", async () => {
      // The contract schemas carry no Better Auth "user"/"account" tables — exactly
      // the deployment shape those lookups are best-effort for. The core decoration
      // must still come back.
      const a = await store.createArtifact(newArtifact())
      await store.setArtifactTags(a.id, ["gamma"])
      const enr = await store.listEnrichment({
        ids: [a.id],
        ghIds: ["12345"],
        authorIds: [`u_${uuid()}`],
        viewerId: null,
        memberId: null,
        views: false,
      })
      expect(enr.handles).toEqual([])
      expect(enr.bylines).toEqual([])
      expect(enr.tags[a.id]).toEqual(["gamma"])
    })

    it("returns all-empty for an empty page", async () => {
      const enr = await store.listEnrichment({
        ids: [],
        ghIds: [],
        authorIds: [],
        viewerId: null,
        memberId: null,
        views: true,
      })
      expect(enr).toEqual({
        views: {},
        tags: {},
        previews: {},
        handles: [],
        bylines: [],
        signals: {},
        proposals: {},
        shareRoles: {},
        favorites: [],
      })
    })
  })

  describe(`${label}: follows (authors + paths)`, () => {
    it("adds (idempotent), lists, and removes a follow", async () => {
      const user = `u_${uuid()}`
      const a1 = await store.addFollow({
        id: uuid(),
        org_id: ORG,
        user_id: user,
        kind: "author",
        target: "ada",
      })
      expect(a1).toMatchObject({ kind: "author", target: "ada", org_id: ORG, user_id: user })
      // A repeat add on the same (user, org, kind, target) is a no-op that returns the
      // SAME row (idempotent on the unique key, like setFavorite).
      const a2 = await store.addFollow({
        id: uuid(),
        org_id: ORG,
        user_id: user,
        kind: "author",
        target: "ada",
      })
      expect(a2.id).toBe(a1.id)
      const p1 = await store.addFollow({
        id: uuid(),
        org_id: ORG,
        user_id: user,
        kind: "path",
        target: "docs/plans",
      })
      const list = await store.listFollows(user, ORG)
      expect(list.map((f) => `${f.kind}:${f.target}`).sort()).toEqual([
        "author:ada",
        "path:docs/plans",
      ])
      // Removing one leaves the other; removing by the wrong kind is a no-op.
      await store.removeFollow(user, ORG, "author", "nobody")
      expect(await store.listFollows(user, ORG)).toHaveLength(2)
      await store.removeFollow(user, ORG, "author", "ada")
      const after = await store.listFollows(user, ORG)
      expect(after.map((f) => f.id)).toEqual([p1.id])
    })

    it("returns [] from followedArtifactIds when the user follows nothing", async () => {
      expect(await store.followedArtifactIds(`u_${uuid()}`, ORG)).toEqual([])
    })

    it("matches artifacts by followed author (case-insensitive) and by path prefix, org-scoped", async () => {
      const user = `u_${uuid()}`
      // An artifact authored by "Ada" (login "ada").
      const byAda = await store.createArtifact(newArtifact())
      await store.addVersion(byAda.id, newVersion({ author: "Ada", author_login: "Ada" }))
      // An artifact under docs/plans/ (a followed path prefix), authored by someone else.
      const inPlans = await store.createArtifact(newArtifact())
      await store.addVersion(inPlans.id, newVersion({ author: "bob", author_login: "bob" }))
      await store.setArtifactSourcePath(inPlans.id, "docs/plans/q3.md")
      // A non-matching artifact: different author, path outside the followed prefix.
      const other = await store.createArtifact(newArtifact())
      await store.addVersion(other.id, newVersion({ author: "carol", author_login: "carol" }))
      await store.setArtifactSourcePath(other.id, "src/index.ts")
      // The same author + path in ANOTHER org (must be excluded by the org scope).
      const otherOrg = `${ORG}_feed_other`
      const elsewhere = await store.createArtifact(newArtifact({ org_id: otherOrg }))
      await store.addVersion(elsewhere.id, newVersion({ author: "Ada", author_login: "ada" }))
      await store.setArtifactSourcePath(elsewhere.id, "docs/plans/elsewhere.md")

      // Follow author "ada" (lowercased target) + path prefix "docs/plans".
      await store.addFollow({
        id: uuid(),
        org_id: ORG,
        user_id: user,
        kind: "author",
        target: "ada",
      })
      await store.addFollow({
        id: uuid(),
        org_id: ORG,
        user_id: user,
        kind: "path",
        target: "docs/plans",
      })

      const ids = await store.followedArtifactIds(user, ORG)
      expect(ids).toContain(byAda.id) // author match, case-insensitive (login "Ada")
      expect(ids).toContain(inPlans.id) // path-prefix match
      expect(ids).not.toContain(other.id) // neither author nor path matches
      expect(ids).not.toContain(elsewhere.id) // matches but in another org

      // Author-only follow set: no path follow → only the author match comes back.
      const authorOnly = `u_${uuid()}`
      await store.addFollow({
        id: uuid(),
        org_id: ORG,
        user_id: authorOnly,
        kind: "author",
        target: "ada",
      })
      const authorIds = await store.followedArtifactIds(authorOnly, ORG)
      expect(authorIds).toContain(byAda.id)
      expect(authorIds).not.toContain(inPlans.id)

      // Path-only follow set: no author follow → only the path match comes back.
      const pathOnly = `u_${uuid()}`
      await store.addFollow({
        id: uuid(),
        org_id: ORG,
        user_id: pathOnly,
        kind: "path",
        target: "docs/plans",
      })
      const pathIds = await store.followedArtifactIds(pathOnly, ORG)
      expect(pathIds).toContain(inPlans.id)
      expect(pathIds).not.toContain(byAda.id)

      // A removed (tombstoned) artifact drops out of the feed.
      await store.setArtifactRemoved(byAda.id, new Date().toISOString())
      expect(await store.followedArtifactIds(authorOnly, ORG)).not.toContain(byAda.id)
      await store.setArtifactRemoved(byAda.id, null)
    })

    it("treats a path follow as a literal prefix: respects folder boundaries + escapes LIKE metachars", async () => {
      // A folder follow (trailing slash) matches files INSIDE the folder…
      const user = `u_${uuid()}`
      const inside = await store.createArtifact(newArtifact())
      await store.addVersion(inside.id, newVersion())
      await store.setArtifactSourcePath(inside.id, "docs/plans/q3.md")
      // …but NOT a sibling folder that merely shares the prefix string.
      const sibling = await store.createArtifact(newArtifact())
      await store.addVersion(sibling.id, newVersion())
      await store.setArtifactSourcePath(sibling.id, "docs/plans2/x.md")
      await store.addFollow({
        id: uuid(),
        org_id: ORG,
        user_id: user,
        kind: "path",
        target: "docs/plans/",
      })
      const ids = await store.followedArtifactIds(user, ORG)
      expect(ids).toContain(inside.id)
      expect(ids).not.toContain(sibling.id) // "docs/plans2/…" is not under "docs/plans/"

      // A "_" in the prefix is matched literally, not as the LIKE single-char wildcard.
      const esc = `u_${uuid()}`
      const literal = await store.createArtifact(newArtifact())
      await store.addVersion(literal.id, newVersion())
      await store.setArtifactSourcePath(literal.id, "a_b/notes.md")
      const wildcardish = await store.createArtifact(newArtifact())
      await store.addVersion(wildcardish.id, newVersion())
      await store.setArtifactSourcePath(wildcardish.id, "axb/notes.md")
      await store.addFollow({
        id: uuid(),
        org_id: ORG,
        user_id: esc,
        kind: "path",
        target: "a_b/",
      })
      const escIds = await store.followedArtifactIds(esc, ORG)
      expect(escIds).toContain(literal.id)
      expect(escIds).not.toContain(wildcardish.id) // "_" escaped → literal, not "any char"
    })
  })

  describe(`${label}: follows (people, cross-workspace)`, () => {
    it("surfaces a followed person's PUBLIC work in ANY workspace, hides their private work", async () => {
      const follower = `u_${uuid()}`
      const followerOrg = `${ORG}_follower_ws` // the viewer's OWN workspace (not the author's)
      const maya = `u_maya_${uuid()}`
      const mayaOrg = `${ORG}_maya_ws` // the author publishes in HER workspace

      // Maya's PUBLIC work, in her own workspace (author_id stamped on hand-publish).
      const pub = await store.createArtifact(newArtifact({ org_id: mayaOrg, listed: "public" }))
      await store.addVersion(pub.id, newVersion({ author: "Maya", author_id: maya }))
      // Maya's PRIVATE work — must NOT leak into a follower's feed.
      const priv = await store.createArtifact(
        newArtifact({ org_id: mayaOrg, listed: "none", link_role: "none" }),
      )
      await store.addVersion(priv.id, newVersion({ author: "Maya", author_id: maya }))
      // Someone else's public work in another workspace — not followed, must not appear.
      const other = await store.createArtifact(
        newArtifact({ org_id: `${ORG}_other_ws`, listed: "public" }),
      )
      await store.addVersion(
        other.id,
        newVersion({ author: "Nora", author_id: `u_nora_${uuid()}` }),
      )

      // The follower follows Maya the PERSON (people-follows are global, org_id "*").
      await store.addFollow({
        id: uuid(),
        org_id: "*",
        user_id: follower,
        kind: "user",
        target: maya,
      })

      // The feed is queried with the FOLLOWER's active workspace — which is NOT Maya's.
      const ids = await store.followedArtifactIds(follower, followerOrg)
      expect(ids).toContain(pub.id) // public work, surfaced across workspaces
      expect(ids).not.toContain(priv.id) // private work never leaks
      expect(ids).not.toContain(other.id) // not a followed person

      // A tombstoned public work drops out of the feed.
      await store.setArtifactRemoved(pub.id, new Date().toISOString())
      expect(await store.followedArtifactIds(follower, followerOrg)).not.toContain(pub.id)
      await store.setArtifactRemoved(pub.id, null)
    })

    it("combines an author follow (workspace-scoped) with a person follow (public, anywhere)", async () => {
      const user = `u_${uuid()}`
      const homeOrg = `${ORG}_home_ws`
      const person = `u_person_${uuid()}`
      const farOrg = `${ORG}_far_ws`

      // An author-login match in the user's OWN workspace (workspace-scoped branch).
      const local = await store.createArtifact(newArtifact({ org_id: homeOrg }))
      await store.addVersion(local.id, newVersion({ author: "Ada", author_login: "ada" }))
      // The same login in another workspace — author follows stay workspace-scoped, excluded.
      const localElsewhere = await store.createArtifact(newArtifact({ org_id: farOrg }))
      await store.addVersion(localElsewhere.id, newVersion({ author: "Ada", author_login: "ada" }))
      // A followed person's public work in a far workspace (person branch, any workspace).
      const personPub = await store.createArtifact(
        newArtifact({ org_id: farOrg, listed: "public" }),
      )
      await store.addVersion(personPub.id, newVersion({ author: "Pat", author_id: person }))

      await store.addFollow({
        id: uuid(),
        org_id: homeOrg,
        user_id: user,
        kind: "author",
        target: "ada",
      })
      await store.addFollow({
        id: uuid(),
        org_id: "*",
        user_id: user,
        kind: "user",
        target: person,
      })

      const ids = await store.followedArtifactIds(user, homeOrg)
      expect(ids).toContain(local.id) // author match in the active workspace
      expect(ids).not.toContain(localElsewhere.id) // author match in another workspace — excluded
      expect(ids).toContain(personPub.id) // followed person's public work, anywhere
    })
  })

  describe(`${label}: people profiles (works, shared orgs, follower counts)`, () => {
    it("lists + counts a person's work, gated by visibility (public always; shared orgs widen)", async () => {
      const author = `u_author_${uuid()}`
      const homeOrg = `${ORG}_pp_home_${uuid()}`
      const ghId = `gh-${uuid()}` // distinctive, unused by any other test
      // Public work, hand-authored (author_id) in the author's workspace.
      const pub = await store.createArtifact(newArtifact({ org_id: homeOrg, listed: "public" }))
      await store.addVersion(pub.id, newVersion({ author: "Author", author_id: author }))
      // Org-visible (non-public) work by the same author.
      const orgWork = await store.createArtifact(
        newArtifact({ org_id: homeOrg, listed: "workspace", link_role: "none" }),
      )
      await store.addVersion(orgWork.id, newVersion({ author: "Author", author_id: author }))
      // Public work attributed by a linked GitHub id (no author_id) — matched via ghIds.
      const ghWork = await store.createArtifact(newArtifact({ org_id: homeOrg, listed: "public" }))
      await store.addVersion(
        ghWork.id,
        newVersion({ author: "Gh", author_login: "gh", author_gh_id: ghId }),
      )

      // Anonymous viewer (no shared orgs): public work only — both author_id + gh-id matches.
      const anon = await store.listUserWorks(author, [ghId], {})
      const anonIds = anon.map((a) => a.id)
      expect(anonIds).toContain(pub.id)
      expect(anonIds).toContain(ghWork.id)
      expect(anonIds).not.toContain(orgWork.id) // non-public, no shared workspace
      expect(await store.countUserWorks(author, [ghId], {})).toBe(anon.length)

      // A viewer who shares the author's workspace also sees the org-visible work.
      const shared = await store.listUserWorks(author, [], { visibleOrgIds: [homeOrg] })
      expect(shared.map((a) => a.id)).toContain(orgWork.id)
      expect(await store.countUserWorks(author, [], { visibleOrgIds: [homeOrg] })).toBe(
        shared.length,
      )

      // No author_id match and no linked gh ids → nothing.
      expect(await store.listUserWorks(`u_${uuid()}`, [], {})).toEqual([])
    })

    it("computes the shared-workspace set between two users", async () => {
      const a = `u_${uuid()}`
      const b = `u_${uuid()}`
      const shared = `${ORG}_shared_${uuid()}`
      const onlyA = `${ORG}_onlyA_${uuid()}`
      await store.setMembership({ id: uuid(), org_id: shared, user_id: a, role: "editor" })
      await store.setMembership({ id: uuid(), org_id: shared, user_id: b, role: "viewer" })
      await store.setMembership({ id: uuid(), org_id: onlyA, user_id: a, role: "owner" })
      const orgs = await store.sharedOrgIds(a, b)
      expect(orgs).toContain(shared)
      expect(orgs).not.toContain(onlyA) // only `a` is a member there
    })

    it("derives a user's GitHub login from their authored artifacts (null when unknown)", async () => {
      const gh = await store.createArtifact(newArtifact())
      await store.addVersion(
        gh.id,
        newVersion({ author: "Octo", author_login: "octocat", author_gh_id: "583231-pp" }),
      )
      expect(await store.githubLoginForUser(`u_${uuid()}`, ["583231-pp"])).toBe("octocat")
      expect(await store.githubLoginForUser(`u_${uuid()}`, [])).toBeNull() // no linked ids
      expect(await store.githubLoginForUser(`u_${uuid()}`, ["no-such-gh"])).toBeNull() // no match
    })

    it("counts a person's followers and following (people-follows only)", async () => {
      const maya = `u_maya_${uuid()}`
      const f1 = `u_${uuid()}`
      const f2 = `u_${uuid()}`
      await store.addFollow({ id: uuid(), org_id: "*", user_id: f1, kind: "user", target: maya })
      await store.addFollow({ id: uuid(), org_id: "*", user_id: f2, kind: "user", target: maya })
      await store.addFollow({ id: uuid(), org_id: "*", user_id: maya, kind: "user", target: f1 })
      expect(await store.countFollowers(maya)).toBe(2)
      expect(await store.countFollowing(maya)).toBe(1)
      // listFollowers/Following resolve names via Better Auth's user table, which this
      // contract store doesn't provision — they degrade to [] safely (no throw).
      expect(Array.isArray(await store.listFollowers(maya, 50))).toBe(true)
      expect(Array.isArray(await store.listFollowing(maya, 50))).toBe(true)
    })
  })

  describe(`${label}: collections`, () => {
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

      // listArtifacts scopes to a collection by JOIN (not an id IN(...) of every member):
      // it returns only members, and an artifact outside the collection is excluded.
      const outside = await store.createArtifact(newArtifact())
      const inCol = await store.listArtifacts({ collectionId: col.id, orgId: ORG })
      expect(inCol.map((x) => x.id)).toContain(a.id)
      expect(inCol.map((x) => x.id)).not.toContain(outside.id)

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

    it("propagates a workspace-open collection's seat role to its artifacts; invite-only does not", async () => {
      // A private artifact (workspace_access=none) no one is an explicit member of.
      const priv = await store.createArtifact(
        newArtifact({ workspace_access: "none", link_role: "none", listed: "none" }),
      )
      // carol has a workspace SEAT (editor) but is NOT an explicit collection member.
      await store.setMembership({ id: uuid(), org_id: ORG, user_id: "carol", role: "editor" })

      // A workspace-open collection hands carol her seat role on every artifact inside
      // it — even a private one — purely via her workspace membership.
      const open = await store.createCollection({
        id: uuid(),
        org_id: ORG,
        title: "Open",
        created_by: "amy",
        workspace_access: "member",
      })
      await store.addCollectionItem(open.id, priv.id)
      expect(await store.collectionRolesForArtifact(priv.id, "carol")).toContain("editor")

      // An invite-only collection (workspace_access=none) grants a bare seat nothing —
      // only its explicit members reach it.
      const invite = await store.createCollection({
        id: uuid(),
        org_id: ORG,
        title: "Invite",
        created_by: "amy",
        workspace_access: "none",
      })
      const priv2 = await store.createArtifact(
        newArtifact({ workspace_access: "none", link_role: "none", listed: "none" }),
      )
      await store.addCollectionItem(invite.id, priv2.id)
      expect(await store.collectionRolesForArtifact(priv2.id, "carol")).toHaveLength(0)
    })
  })

  describe(`${label}: github sync sources`, () => {
    it("creates a source, scopes reads by org, persists the file map, retitles + tombstones, deletes", async () => {
      const col = await store.createCollection({
        id: uuid(),
        org_id: ORG,
        title: "GitHub: acme/docs",
        created_by: "amy",
      })
      const art = await store.createArtifact(newArtifact({ title: "docs/a.md" }))
      const src = await store.createRepoSource({
        id: uuid(),
        org_id: ORG,
        collection_id: col.id,
        repo: "acme/docs",
        ref: "main",
        includes: "**/*.md",
        token: "tok",
        created_by: "amy",
      })
      expect(src.files).toBe("{}")
      // Org-scoped read: present for its org, absent for another.
      expect(await store.getRepoSource(src.id, ORG)).toMatchObject({ repo: "acme/docs" })
      expect(await store.getRepoSource(src.id, `${ORG}_other`)).toBeNull()
      expect(await store.listRepoSources(ORG)).toHaveLength(1)

      // Record a sync: the path→artifact map drives managedArtifactIds (the gate).
      await store.updateRepoSourceSync(src.id, {
        files: JSON.stringify({
          "docs/a.md": { artifact_id: art.id, short_id: art.short_id, sha: "s1" },
        }),
        last_synced_at: "2026-06-14T00:00:00.000Z",
        last_status: "ok",
      })
      expect(await store.managedArtifactIds(ORG)).toContain(art.id)

      // Live progress: a cheap JSON column the engine writes every batch (the UI bar
      // polls it). Null until a sync starts; listed cross-org so the Node entry can
      // resume mid-flight syncs on boot; cleared back to null when done.
      expect((await store.getRepoSource(src.id, ORG))?.progress).toBeNull()
      expect(await store.listSyncingRepoSources()).toHaveLength(0)
      await store.setRepoSourceProgress(
        src.id,
        JSON.stringify({
          phase: "mirroring",
          done: 3,
          total: 10,
          updatedAt: "2026-06-14T00:00:00.000Z",
        }),
      )
      expect((await store.getRepoSource(src.id, ORG))?.progress).toContain('"phase":"mirroring"')
      expect((await store.listSyncingRepoSources()).map((s) => s.id)).toContain(src.id)
      await store.setRepoSourceProgress(src.id, null)
      expect((await store.getRepoSource(src.id, ORG))?.progress).toBeNull()
      expect(await store.listSyncingRepoSources()).toHaveLength(0)

      // Rename re-homes the artifact: retitle + clear any tombstone.
      await store.setArtifactRemoved(art.id, "2026-06-14T00:00:00.000Z")
      await store.setArtifactTitle(art.id, "docs/b.md")
      await store.setArtifactRemoved(art.id, null)
      expect(await store.getArtifactById(art.id)).toMatchObject({
        title: "docs/b.md",
        removed_at: null,
      })

      await store.deleteRepoSource(src.id, ORG)
      expect(await store.getRepoSource(src.id, ORG)).toBeNull()
      expect(await store.managedArtifactIds(ORG)).not.toContain(art.id)
    })

    it("backs a source with a GitHub App installation and routes by it", async () => {
      const col = await store.createCollection({
        id: uuid(),
        org_id: ORG,
        title: "GitHub: acme/site",
        created_by: "amy",
      })
      const inst = await store.upsertGithubInstallation({
        installation_id: "4242",
        org_id: ORG,
        account_login: "acme",
        created_by: "amy",
        created_at: "2026-06-15T00:00:00.000Z",
      })
      expect(inst.account_login).toBe("acme")
      // Upsert is idempotent on installation_id (re-install refreshes, no dupe).
      await store.upsertGithubInstallation({
        installation_id: "4242",
        org_id: ORG,
        account_login: "acme-renamed",
        created_by: "amy",
        created_at: "2026-06-15T00:00:00.000Z",
      })
      expect(await store.getGithubInstallation("4242")).toMatchObject({
        account_login: "acme-renamed",
      })
      expect(await store.listGithubInstallations(ORG)).toHaveLength(1)

      const src = await store.createRepoSource({
        id: uuid(),
        org_id: ORG,
        collection_id: col.id,
        repo: "acme/site",
        ref: "main",
        includes: "**/*.md",
        installation_id: "4242",
        created_by: "amy",
      })
      expect(src.installation_id).toBe("4242")
      expect(src.token).toBeNull()
      // The webhook router resolves an installation id → its sources, cross-org.
      const byInst = await store.listRepoSourcesByInstallation("4242")
      expect(byInst.map((s) => s.id)).toContain(src.id)

      await store.deleteRepoSource(src.id, ORG)
      await store.deleteGithubInstallation("4242")
      expect(await store.getGithubInstallation("4242")).toBeNull()
    })

    it("stores the instance GitHub App credentials as a single upserted row", async () => {
      expect(await store.getGithubApp()).toBeNull()
      await store.setGithubApp({
        id: "default",
        app_id: "111",
        slug: "derive-on-acme",
        client_id: "Iv1.abc",
        client_secret: "enc-secret",
        private_key: "enc-pem",
        webhook_secret: "enc-whsec",
        created_at: "2026-06-15T00:00:00.000Z",
      })
      expect(await store.getGithubApp()).toMatchObject({ app_id: "111", slug: "derive-on-acme" })
      // Re-setup overwrites in place (still one row).
      await store.setGithubApp({
        id: "default",
        app_id: "222",
        slug: "derive-on-acme-2",
        client_id: "Iv1.def",
        client_secret: "enc-secret-2",
        private_key: "enc-pem-2",
        webhook_secret: "enc-whsec-2",
        created_at: "2026-06-15T00:00:00.000Z",
      })
      expect(await store.getGithubApp()).toMatchObject({ app_id: "222" })
    })
  })

  describe(`${label}: proposals (reviews)`, () => {
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

  describe(`${label}: views + analytics`, () => {
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

    it("stamps first_foreign_view_at on the first view only (the activation moment)", async () => {
      const a = await store.createArtifact(newArtifact())
      expect((await store.getByShortId(a.short_id))?.first_foreign_view_at).toBeNull()

      await store.recordView({
        id: uuid(),
        artifact_id: a.id,
        version: 1,
        viewer: "visitor1",
        viewer_kind: "anon",
      })
      const stamped = (await store.getByShortId(a.short_id))?.first_foreign_view_at
      expect(stamped).toBeTruthy()

      // A later view never moves the stamp — activation happened once.
      await store.recordView({
        id: uuid(),
        artifact_id: a.id,
        version: 1,
        viewer: "visitor2",
        viewer_kind: "user",
      })
      expect((await store.getByShortId(a.short_id))?.first_foreign_view_at).toBe(stamped)
    })

    it("flips public_history (off by default) without touching access", async () => {
      const a = await store.createArtifact(newArtifact())
      expect((await store.getByShortId(a.short_id))?.public_history).toBeFalsy()

      await store.setPublicHistory(a.id, 1)
      const on = await store.getByShortId(a.short_id)
      expect(on?.public_history).toBe(1)
      // The flag rides alone — the access triple is untouched.
      expect(on?.workspace_access).toBe(a.workspace_access)
      expect(on?.link_role).toBe(a.link_role)

      await store.setPublicHistory(a.id, 0)
      expect((await store.getByShortId(a.short_id))?.public_history).toBeFalsy()
    })
  })

  describe(`${label}: webhooks + outbox`, () => {
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

  describe(`${label}: domains`, () => {
    it("claims a host (globally unique), updates status, releases it", async () => {
      const a = await store.createArtifact(newArtifact())
      const host = `${uuid().slice(0, 8)}.derived.app`
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

  describe(`${label}: notifications`, () => {
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

    it("createNotifications inserts a whole fan-out in one call (empty ⇒ no-op)", async () => {
      const a = await store.createArtifact(newArtifact())
      const base = {
        actor: "bob",
        kind: "publish" as const,
        artifact_id: a.id,
        artifact_short_id: a.short_id,
        artifact_title: "Doc",
        thread_id: "",
        comment_id: "",
        preview: "shipped",
      }
      await store.createNotifications([]) // no-op, no throw
      await store.createNotifications([
        { id: uuid(), user_id: "cara", ...base },
        { id: uuid(), user_id: "dave", ...base },
        { id: uuid(), user_id: "cara", ...base },
      ])
      expect(await store.unreadNotificationCount("cara")).toBe(2)
      expect(await store.unreadNotificationCount("dave")).toBe(1)
    })
  })

  describe(`${label}: batched reads (no N+1)`, () => {
    it("getArtifactsByIds / getCollections load a set in one call (empty ⇒ [])", async () => {
      const a1 = await store.createArtifact(newArtifact({ title: "One" }))
      const a2 = await store.createArtifact(newArtifact({ title: "Two" }))
      expect(await store.getArtifactsByIds([])).toEqual([])
      const arts = await store.getArtifactsByIds([a1.id, a2.id, "missing"])
      expect(new Set(arts.map((a) => a.id))).toEqual(new Set([a1.id, a2.id]))

      const c1 = await store.createCollection({
        id: uuid(),
        org_id: ORG,
        title: "C1",
        created_by: "amy",
      })
      const c2 = await store.createCollection({
        id: uuid(),
        org_id: ORG,
        title: "C2",
        created_by: "amy",
      })
      expect(await store.getCollections([])).toEqual([])
      const cols = await store.getCollections([c1.id, c2.id])
      expect(new Set(cols.map((c) => c.title))).toEqual(new Set(["C1", "C2"]))
    })

    it("listMembershipsForOrgs returns memberships across orgs (empty ⇒ [])", async () => {
      const orgA = `org_${uuid()}`
      const orgB = `org_${uuid()}`
      await store.setWorkspace(orgA, "A")
      await store.setWorkspace(orgB, "B")
      await store.setMembership({ id: uuid(), org_id: orgA, user_id: "amy", role: "owner" })
      await store.setMembership({ id: uuid(), org_id: orgB, user_id: "amy", role: "editor" })
      await store.setMembership({ id: uuid(), org_id: orgB, user_id: "bob", role: "viewer" })
      expect(await store.listMembershipsForOrgs([])).toEqual([])
      const rows = await store.listMembershipsForOrgs([orgA, orgB])
      expect(rows.filter((m) => m.org_id === orgA)).toHaveLength(1)
      expect(rows.filter((m) => m.org_id === orgB)).toHaveLength(2)
    })

    it("setArtifactsRemoved tombstones many artifacts in one update (empty ⇒ no-op)", async () => {
      const a1 = await store.createArtifact(newArtifact())
      const a2 = await store.createArtifact(newArtifact())
      await store.setArtifactsRemoved([]) // no-op
      expect((await store.getArtifactById(a1.id))?.removed_at ?? null).toBeNull()
      await store.setArtifactsRemoved([a1.id, a2.id], "2026-01-01T00:00:00.000Z")
      expect((await store.getArtifactById(a1.id))?.removed_at).toBe("2026-01-01T00:00:00.000Z")
      expect((await store.getArtifactById(a2.id))?.removed_at).toBe("2026-01-01T00:00:00.000Z")
    })

    it("enqueueDeliveries inserts a whole subscriber fan-out in one call (empty ⇒ no-op)", async () => {
      const a = await store.createArtifact(newArtifact())
      const hook = await store.createWebhook({
        id: uuid(),
        artifact_id: a.id,
        org_id: ORG,
        url: "https://example.test/hook",
        secret: "s",
        events: "*",
        kind: "generic",
      })
      const row = (id: string) => ({
        id,
        webhook_id: hook.id,
        url: hook.url,
        secret: hook.secret,
        kind: hook.kind,
        event_type: "version.published",
        payload: "{}",
      })
      await store.enqueueDeliveries([]) // no-op
      await store.enqueueDeliveries([row(uuid()), row(uuid())])
      const due = await store.claimDueDeliveries(
        new Date(Date.now() + 60_000).toISOString(),
        10,
        new Date(Date.now() + 120_000).toISOString(),
      )
      expect(due.filter((d) => d.webhook_id === hook.id)).toHaveLength(2)
    })
  })

  describe(`${label}: round-2 batched reads`, () => {
    it("collectionRolesForUser folds explicit membership and workspace-seat access (higher wins), one call", async () => {
      const org = `org_${uuid()}`
      await store.setWorkspace(org, "Round2")
      const seated = await store.createCollection({
        id: uuid(),
        org_id: org,
        title: "Seated",
        created_by: "amy",
        workspace_access: "member",
      })
      const inviteOnly = await store.createCollection({
        id: uuid(),
        org_id: org,
        title: "Invite-only",
        created_by: "amy",
        workspace_access: "none",
      })
      const untouched = await store.createCollection({
        id: uuid(),
        org_id: org,
        title: "Untouched",
        created_by: "amy",
        workspace_access: "none",
      })
      await store.setMembership({ id: uuid(), org_id: org, user_id: "bob", role: "viewer" })
      // Explicit share on the invite-only collection, at a HIGHER role than bob's seat
      // would ever grant on the seated one — proves fold-by-max, not last-write-wins.
      await store.setCollectionMember({
        id: uuid(),
        collection_id: inviteOnly.id,
        user_id: "bob",
        role: "owner",
      })
      expect(await store.collectionRolesForUser([], "bob")).toEqual({})
      const roles = await store.collectionRolesForUser(
        [seated.id, inviteOnly.id, untouched.id],
        "bob",
      )
      expect(roles[seated.id]).toBe("viewer") // seat only
      expect(roles[inviteOnly.id]).toBe("owner") // explicit share only
      expect(roles[untouched.id]).toBeUndefined() // neither
    })

    it("notificationsPage matches listNotifications + unreadNotificationCount, and unread counts the WHOLE history not just the page", async () => {
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
      const user = `u_${uuid()}`
      for (let i = 0; i < 5; i++)
        await store.createNotification({ id: uuid(), user_id: user, ...base })
      // Page of 2, but all 5 are unread — `unread` must reflect the full 5, not the page.
      const page = await store.notificationsPage(user, 2)
      expect(page.notifications).toHaveLength(2)
      expect(page.unread).toBe(5)
      expect(page.notifications).toEqual(await store.listNotifications(user, 2))
      expect(page.unread).toBe(await store.unreadNotificationCount(user))
      await store.markNotificationsRead(user, "all")
      expect((await store.notificationsPage(user, 2)).unread).toBe(0)
    })

    it("automationsWithExecutors joins each automation's agent liveness, one call; a deleted/missing agent ⇒ null", async () => {
      const org = `org_${uuid()}`
      const agent = await store.createAgent({
        id: uuid(),
        org_id: org,
        name: "bot",
        token: `tok_${uuid()}`,
        role: "editor",
      })
      await store.touchAgentRunsSeen(agent.id, "2026-01-01T00:00:00.000Z")
      const live = await store.createAutomation({
        id: uuid(),
        org_id: org,
        agent_id: agent.id,
        trigger: JSON.stringify({ kind: "manual" }),
        instruction: "has a live executor",
      })
      const orphaned = await store.createAutomation({
        id: uuid(),
        org_id: org,
        agent_id: `ag_${uuid()}`, // no such agent row
        trigger: JSON.stringify({ kind: "manual" }),
        instruction: "agent never existed",
      })
      const rows = await store.automationsWithExecutors(org)
      expect(rows.find((r) => r.id === live.id)?.executor_seen_at).toBe("2026-01-01T00:00:00.000Z")
      expect(rows.find((r) => r.id === orphaned.id)?.executor_seen_at).toBeNull()
      // Same rows listAutomations would return, just decorated.
      expect(rows.map((r) => r.id).sort()).toEqual(
        (await store.listAutomations(org)).map((r) => r.id).sort(),
      )
    })

    it("artifactDetail matches every individual call it replaces", async () => {
      const org = `org_${uuid()}`
      await store.setWorkspace(org, "Detail")
      const viewer = `u_${uuid()}`
      const a = await store.createArtifact(newArtifact({ org_id: org }))
      await store.addVersion(a.id, newVersion())
      await store.addVersion(a.id, newVersion())
      await store.setArtifactTags(a.id, ["zeta", "alpha"])
      await store.setFavorite(a.id, viewer)
      const col = await store.createCollection({
        id: uuid(),
        org_id: org,
        title: "Holder",
        created_by: "amy",
      })
      await store.addCollectionItem(col.id, a.id)
      await store.createProposal({
        id: uuid(),
        artifact_id: a.id,
        blob_key: `blob_${uuid()}`,
        content_type: "text/html",
        kind: "file",
        author: "amy",
        base_version: 1,
      })
      // Two comments in ONE open thread + one resolved thread: openThreads counts
      // DISTINCT open threads, so this must be 1, not 2 and not 3.
      const openThread = uuid()
      for (const body of ["first", "second"])
        await store.createComment({
          id: uuid(),
          artifact_id: a.id,
          thread_id: openThread,
          base_version: 1,
          body_md: body,
          author: "amy",
        })
      const doneThread = uuid()
      await store.createComment({
        id: uuid(),
        artifact_id: a.id,
        thread_id: doneThread,
        base_version: 1,
        body_md: "done",
        author: "amy",
      })
      await store.setThreadState(a.id, doneThread, "resolved")
      await store.setOrgSettings(org, { ...DEFAULT_ORG_SETTINGS, whiteLabel: true })

      const detail = await store.artifactDetail({ artifactId: a.id, orgId: org, viewerId: viewer })
      // Indistinguishable from the calls it replaces.
      expect(detail.versions).toEqual(await store.listVersions(a.id))
      expect(detail.tags).toEqual((await store.tagsForArtifacts([a.id]))[a.id] ?? [])
      expect(detail.collectionIds).toEqual(await store.collectionIdsForArtifact(a.id))
      expect(detail.proposals).toEqual(await store.listProposals(a.id))
      expect(detail.openThreads).toBe(
        (await store.commentSignals([a.id], null))[a.id]?.open_threads ?? 0,
      )
      expect(detail.favorite).toBe((await store.listUserFavoriteIds(viewer)).includes(a.id))
      expect(detail.settings).toEqual(await store.getOrgSettings(org))
      expect(detail.managed).toBe((await store.managedArtifactIds(org)).includes(a.id))
      // Populated, not vacuously equal-empty — and ORDER matters: the route indexes its
      // mapped array against `versions[i]`, so ascending-by-n is part of the contract.
      expect(detail.versions.map((v) => v.n)).toEqual([1, 2])
      expect(detail.tags).toEqual(["alpha", "zeta"])
      expect(detail.collectionIds).toEqual([col.id])
      expect(detail.proposals).toHaveLength(1)
      expect(detail.openThreads).toBe(1)
      expect(detail.favorite).toBe(true)
      expect(detail.settings.whiteLabel).toBe(true)
      expect(detail.managed).toBe(false)

      // An anonymous viewer has no favorite; everything else is unchanged.
      const anon = await store.artifactDetail({ artifactId: a.id, orgId: org, viewerId: null })
      expect(anon.favorite).toBe(false)
      expect(anon.versions).toEqual(detail.versions)
      expect(anon.openThreads).toBe(1)
      // A DIFFERENT user's favorite must not leak into this viewer's answer.
      const stranger = await store.artifactDetail({
        artifactId: a.id,
        orgId: org,
        viewerId: `u_${uuid()}`,
      })
      expect(stranger.favorite).toBe(false)
    })

    it("artifactDetail on a bare artifact returns empties + settings defaults, no crash", async () => {
      const org = `org_${uuid()}`
      await store.setWorkspace(org, "Bare")
      const a = await store.createArtifact(newArtifact({ org_id: org }))
      const detail = await store.artifactDetail({
        artifactId: a.id,
        orgId: org,
        viewerId: `u_${uuid()}`,
      })
      expect(detail.versions).toEqual([])
      expect(detail.tags).toEqual([])
      expect(detail.collectionIds).toEqual([])
      expect(detail.proposals).toEqual([])
      expect(detail.openThreads).toBe(0)
      expect(detail.favorite).toBe(false)
      expect(detail.managed).toBe(false)
      // No org_settings row ⇒ the parsed defaults, same as getOrgSettings would give.
      expect(detail.settings).toEqual(await store.getOrgSettings(org))
    })

    it("artifactDetail scopes to ITS artifact — a sibling's versions/tags/proposals never bleed in", async () => {
      const org = `org_${uuid()}`
      await store.setWorkspace(org, "Scoping")
      const mine = await store.createArtifact(newArtifact({ org_id: org }))
      const other = await store.createArtifact(newArtifact({ org_id: org }))
      await store.addVersion(mine.id, newVersion())
      await store.addVersion(other.id, newVersion())
      await store.addVersion(other.id, newVersion())
      await store.setArtifactTags(other.id, ["not-mine"])
      await store.createProposal({
        id: uuid(),
        artifact_id: other.id,
        blob_key: `blob_${uuid()}`,
        content_type: "text/html",
        kind: "file",
        author: "amy",
        base_version: 1,
      })
      await store.createComment({
        id: uuid(),
        artifact_id: other.id,
        thread_id: uuid(),
        base_version: 1,
        body_md: "on the other one",
        author: "amy",
      })
      const detail = await store.artifactDetail({
        artifactId: mine.id,
        orgId: org,
        viewerId: null,
      })
      expect(detail.versions).toHaveLength(1)
      expect(detail.tags).toEqual([])
      expect(detail.proposals).toEqual([])
      expect(detail.openThreads).toBe(0)
    })

    it("commentsPage matches listComments + getVersion, honors ?state=, and preserves oldest-first order", async () => {
      const a = await store.createArtifact(newArtifact())
      await store.addVersion(a.id, newVersion({ message: "v1" }))
      await store.addVersion(a.id, newVersion({ message: "v2" }))
      const openThread = uuid()
      const doneThread = uuid()
      for (const [thread, body] of [
        [openThread, "first"],
        [openThread, "second"],
        [doneThread, "third"],
      ] as const)
        await store.createComment({
          id: uuid(),
          artifact_id: a.id,
          thread_id: thread,
          base_version: 1,
          body_md: body,
          author: "amy",
        })
      await store.setThreadState(a.id, doneThread, "resolved")

      const all = await store.commentsPage(a.id, 2)
      expect(all.comments).toEqual(await store.listComments(a.id))
      expect(all.version).toEqual(await store.getVersion(a.id, 2))
      expect(all.comments).toHaveLength(3)
      expect(all.version?.n).toBe(2)
      // Oldest-first is the rail's render order and part of the contract.
      const times = all.comments.map((cm) => cm.created_at)
      expect([...times].sort()).toEqual(times)
      // The state filter passes through.
      const open = await store.commentsPage(a.id, 2, { state: "open" })
      expect(open.comments).toEqual(await store.listComments(a.id, { state: "open" }))
      expect(open.comments).toHaveLength(2)
      // A version that doesn't exist ⇒ null, not a throw (and the comments still come back).
      const missing = await store.commentsPage(a.id, 99)
      expect(missing.version).toBeNull()
      expect(missing.comments).toHaveLength(3)
    })

    it("contextsWithManifests resolves each context's manifest short_id, preserving listContexts' rows, order and org scope", async () => {
      const org = `org_${uuid()}`
      await store.setWorkspace(org, "Ctx")
      const first = await store.createArtifact(newArtifact({ org_id: org }))
      const second = await store.createArtifact(newArtifact({ org_id: org }))
      const mk = (name: string, manifestId: string) =>
        store.createContext({
          id: `ctx_${uuid()}`,
          org_id: org,
          name,
          agent_id: `ag_${uuid()}`,
          manifest_artifact_id: manifestId,
          created_by: "amy",
        })
      const a = await mk("First", first.id)
      const b = await mk("Second", second.id)
      // A context in ANOTHER workspace must not leak into this list.
      const otherOrg = `org_${uuid()}`
      await store.setWorkspace(otherOrg, "Elsewhere")
      const elsewhere = await store.createArtifact(newArtifact({ org_id: otherOrg }))
      await store.createContext({
        id: `ctx_${uuid()}`,
        org_id: otherOrg,
        name: "Not yours",
        agent_id: `ag_${uuid()}`,
        manifest_artifact_id: elsewhere.id,
        created_by: "amy",
      })

      const rows = await store.contextsWithManifests(org)
      expect(rows.find((r) => r.id === a.id)?.manifest_short_id).toBe(first.short_id)
      expect(rows.find((r) => r.id === b.id)?.manifest_short_id).toBe(second.short_id)
      expect(rows.every((r) => r.org_id === org)).toBe(true)
      // Same rows, same order, as listContexts — the JOIN must not reorder or drop.
      // (Both schemas put a FK on manifest_artifact_id, so the JOIN's null branch is
      // unreachable in practice; it stays a LEFT JOIN because the code it replaces also
      // tolerated an unresolvable manifest rather than dropping the row.)
      expect(rows.map((r) => r.id)).toEqual((await store.listContexts(org)).map((r) => r.id))
    })

    it("isManagedArtifact agrees with managedArtifactIds, including the substring trap", async () => {
      const org = `org_${uuid()}`
      await store.setWorkspace(org, "Managed WS")
      const col = await store.createCollection({
        id: uuid(),
        org_id: org,
        title: "Mirror",
        created_by: "amy",
      })
      const synced = await store.createArtifact(newArtifact({ org_id: org }))
      const plain = await store.createArtifact(newArtifact({ org_id: org }))
      const src = await store.createRepoSource({
        id: uuid(),
        org_id: org,
        collection_id: col.id,
        repo: "acme/derive",
        ref: "main",
        includes: "**/*.md",
        pr_number: null,
        created_by: "amy",
      })
      // The path→artifact map is written by the sync, not at creation.
      await store.updateRepoSourceSync(src.id, {
        files: JSON.stringify({ "README.md": { artifact_id: synced.id } }),
      })

      expect(await store.isManagedArtifact(org, synced.id)).toBe(true)
      expect(await store.isManagedArtifact(org, plain.id)).toBe(false)
      // Agrees with the call it replaces, both ways.
      const all = await store.managedArtifactIds(org)
      expect(all.includes(synced.id)).toBe(true)
      expect(all.includes(plain.id)).toBe(false)
      // THE SUBSTRING TRAP: the implementation narrows with a SQL LIKE and then confirms by
      // parsing. A prefix of a managed id appears inside the stored JSON as a substring, so a
      // LIKE alone would answer true — the parse is what makes it false.
      expect(await store.isManagedArtifact(org, synced.id.slice(0, 8))).toBe(false)
      // Another workspace's mirror never counts as this one's.
      const otherOrg = `org_${uuid()}`
      await store.setWorkspace(otherOrg, "Other")
      expect(await store.isManagedArtifact(otherOrg, synced.id)).toBe(false)
    })

    it("artifactWithSettings returns the artifact and its workspace's settings together", async () => {
      const org = `org_${uuid()}`
      await store.setWorkspace(org, "Settings WS")
      const a = await store.createArtifact(newArtifact({ org_id: org }))
      // No settings row yet ⇒ the parsed defaults, same as getOrgSettings.
      const before = await store.artifactWithSettings(a.short_id)
      expect(before.artifact?.id).toBe(a.id)
      expect(before.settings).toEqual(await store.getOrgSettings(org))
      // …and after one is written, the joined value tracks it.
      await store.setOrgSettings(org, { ...DEFAULT_ORG_SETTINGS, chatBeta: true })
      const after = await store.artifactWithSettings(a.short_id)
      expect(after.settings.chatBeta).toBe(true)
      expect(after.settings).toEqual(await store.getOrgSettings(org))
      expect(after.artifact).toEqual(await store.getByShortId(a.short_id))
      // An unknown short id ⇒ null artifact + defaults, never a throw.
      const missing = await store.artifactWithSettings("nosuchid")
      expect(missing.artifact).toBeNull()
      expect(missing.settings).toEqual(DEFAULT_ORG_SETTINGS)
    })

    it("createSessionWithMessage writes session + first message + state as one unit", async () => {
      const org = `org_${uuid()}`
      await store.setWorkspace(org, "Chat WS")
      const asker = `u_${uuid()}`
      const sessionId = `ses_${uuid()}`
      const messageId = `sm_${uuid()}`
      const { session, message } = await store.createSessionWithMessage(
        {
          id: sessionId,
          context_id: null,
          context_version: null,
          org_id: org,
          asker_id: asker,
          subject_ref: JSON.stringify({ kind: "artifact", id: "abc12345" }),
        },
        { id: messageId, author_kind: "asker", author_id: asker, body_md: "First question." },
        "open",
      )
      // The returned session reflects the state that was SET, not the pre-update row —
      // the route hands this straight back to the client.
      expect(session.id).toBe(sessionId)
      expect(session.state).toBe("open")
      expect(session.context_id).toBeNull()
      expect(session.org_id).toBe(org)
      expect(message.id).toBe(messageId)
      expect(message.session_id).toBe(sessionId)
      expect(message.body_md).toBe("First question.")
      // Both rows are actually persisted, and readable exactly as the separate calls left them.
      const stored = await store.getSession(sessionId)
      expect(stored).toEqual(session)
      expect(await store.listSessionMessages(sessionId)).toEqual([message])
      // A session is never left without its first message — the whole point of doing it as
      // one statement rather than three.
      expect((await store.listSessionMessages(sessionId)).length).toBe(1)
    })

    it("unfurlInfo counts versions + comments in the database and returns the current version", async () => {
      const a = await store.createArtifact(newArtifact())
      const other = await store.createArtifact(newArtifact())
      await store.addVersion(a.id, newVersion({ message: "v1" }))
      await store.addVersion(a.id, newVersion({ message: "v2" }))
      await store.addVersion(other.id, newVersion())
      const thread = uuid()
      for (const body of ["one", "two", "three"])
        await store.createComment({
          id: uuid(),
          artifact_id: a.id,
          thread_id: thread,
          base_version: 1,
          body_md: body,
          author: "amy",
        })
      // A comment and version on ANOTHER artifact must not be counted here.
      await store.createComment({
        id: uuid(),
        artifact_id: other.id,
        thread_id: uuid(),
        base_version: 1,
        body_md: "elsewhere",
        author: "amy",
      })

      // Facts on the CURRENT version, and a decoy on v1 that must not leak into
      // the v2 read (the facts branch is keyed on the version, not just the artifact).
      await store.setVersionData(a.id, 1, [
        { id: uuid(), slot: "old", json: JSON.stringify({ stale: true }), size_bytes: 20, gen: 1 },
      ])
      await store.setVersionData(a.id, 2, [
        { id: uuid(), slot: "metrics", json: JSON.stringify({ mrr: 42 }), size_bytes: 16, gen: 1 },
        { id: uuid(), slot: "answers", json: JSON.stringify({ n: 7 }), size_bytes: 12, gen: 1 },
      ])

      const info = await store.unfurlInfo(a.id, 2)
      // Same numbers the whole-list reads it replaces would have produced.
      expect(info.versionCount).toBe((await store.listVersions(a.id)).length)
      expect(info.commentCount).toBe((await store.listComments(a.id)).length)
      expect(info.version).toEqual(await store.getVersion(a.id, 2))
      expect(info.versionCount).toBe(2)
      expect(info.commentCount).toBe(3)
      expect(info.version?.message).toBe("v2")
      // Facts match the getVersionData call this replaces, narrowed to slot+json and in
      // NAME order — factSummary reads them in order, and a UNION ALL promises none.
      expect(info.facts).toEqual(
        (await store.getVersionData(a.id, 2)).map((r) => ({ slot: r.slot, json: r.json })),
      )
      expect(info.facts).toEqual([
        { slot: "answers", json: JSON.stringify({ n: 7 }) },
        { slot: "metrics", json: JSON.stringify({ mrr: 42 }) },
      ])
      // v1's fact stays on v1 — asking for v2 never sees it.
      expect((await store.unfurlInfo(a.id, 1)).facts).toEqual([
        { slot: "old", json: JSON.stringify({ stale: true }) },
      ])
      // Counts include RESOLVED threads (the card shows total discussion, not open).
      await store.setThreadState(a.id, thread, "resolved")
      expect((await store.unfurlInfo(a.id, 2)).commentCount).toBe(3)
      // A bare artifact: zeroes, a null version and no facts, not a throw.
      const bare = await store.createArtifact(newArtifact())
      expect(await store.unfurlInfo(bare.id, 1)).toEqual({
        versionCount: 0,
        commentCount: 0,
        version: null,
        facts: [],
      })
    })

    it("currentVersions returns each artifact's CURRENT version only, matching getVersion per id", async () => {
      const a = await store.createArtifact(newArtifact())
      const b = await store.createArtifact(newArtifact())
      const noVersions = await store.createArtifact(newArtifact())
      await store.addVersion(a.id, newVersion({ message: "a1" }))
      await store.addVersion(a.id, newVersion({ message: "a2" }))
      await store.addVersion(a.id, newVersion({ message: "a3" }))
      await store.addVersion(b.id, newVersion({ message: "b1" }))

      expect(await store.currentVersions([])).toEqual({})
      const cur = await store.currentVersions([a.id, b.id, noVersions.id, "art_missing"])
      // Indistinguishable from a getVersion(id, current_version) per artifact…
      const freshA = await store.getArtifactById(a.id)
      expect(cur[a.id]).toEqual(await store.getVersion(a.id, freshA?.current_version ?? 0))
      // …and it is the CURRENT one (3), not the first or an arbitrary row.
      expect(cur[a.id]?.n).toBe(3)
      expect(cur[a.id]?.message).toBe("a3")
      expect(cur[b.id]?.n).toBe(1)
      // An artifact with no versions, and an id that doesn't exist, are simply absent.
      expect(cur[noVersions.id]).toBeUndefined()
      expect(cur.art_missing).toBeUndefined()
      // Each entry belongs to the artifact it is keyed under — no cross-wiring.
      expect(cur[a.id]?.artifact_id).toBe(a.id)
      expect(cur[b.id]?.artifact_id).toBe(b.id)
    })

    it("workspaceSummary matches the six calls it replaces, and keeps each one's scoping rules", async () => {
      const org = `org_${uuid()}`
      const otherOrg = `org_${uuid()}`
      await store.setWorkspace(org, "Summary WS")
      await store.setWorkspace(otherOrg, "Elsewhere")
      const me = `u_${uuid()}`

      // Owned + listed, owned + unlisted, and one owned by someone else.
      const listedMine = await store.createArtifact(newArtifact({ org_id: org, listed: "public" }))
      const unlistedMine = await store.createArtifact(newArtifact({ org_id: org, listed: "none" }))
      const theirs = await store.createArtifact(newArtifact({ org_id: org }))
      for (const a of [listedMine, unlistedMine])
        await store.setArtifactMember({
          id: uuid(),
          artifact_id: a.id,
          user_id: me,
          role: "owner",
        })
      await store.setArtifactMember({
        id: uuid(),
        artifact_id: theirs.id,
        user_id: `u_${uuid()}`,
        role: "owner",
      })
      await store.setArtifactTags(listedMine.id, ["alpha", "beta"])
      await store.setArtifactTags(theirs.id, ["alpha"])

      // Favorites: one live in-org (counts), one in ANOTHER workspace (must not),
      // one removed (must not) — the scoping the route's comment calls out.
      await store.setFavorite(listedMine.id, me)
      const elsewhere = await store.createArtifact(newArtifact({ org_id: otherOrg }))
      await store.setFavorite(elsewhere.id, me)
      const removed = await store.createArtifact(newArtifact({ org_id: org }))
      await store.setFavorite(removed.id, me)
      await store.setArtifactsRemoved([removed.id], "2026-01-01T00:00:00.000Z")

      const s = await store.workspaceSummary(org, me)
      // Indistinguishable from the calls it replaces.
      expect(s.total).toBe(await store.countArtifacts(org))
      expect([...s.tags].sort((a, b) => a.tag.localeCompare(b.tag))).toEqual(
        await store.tagCounts(org),
      )
      expect(s.workspace).toBe((await store.getWorkspace(org))?.name ?? null)
      expect(s.favorites).toBe((await store.listUserFavoriteIds(me, org)).length)
      expect(s.mine).toBe(await store.countOwnedBy(org, me))
      expect(s.minePrivate).toBe(await store.countOwnedBy(org, me, "none"))
      // …and the values are the ones the scoping rules demand.
      expect(s.workspace).toBe("Summary WS")
      expect(s.mine).toBe(2)
      expect(s.minePrivate).toBe(1)
      expect(s.favorites).toBe(1) // NOT 3: the other workspace's and the removed one drop
      expect(s.tags.find((t) => t.tag === "alpha")?.count).toBe(2)
      expect(s.tags.find((t) => t.tag === "beta")?.count).toBe(1)

      // An anonymous caller gets the workspace-level facts and zero per-user counts.
      const anon = await store.workspaceSummary(org, null)
      expect(anon.total).toBe(s.total)
      expect(anon.workspace).toBe("Summary WS")
      expect(anon.favorites).toBe(0)
      expect(anon.mine).toBe(0)
      expect(anon.minePrivate).toBe(0)

      // A workspace that doesn't exist ⇒ null name and zeroes, not a throw.
      const missing = await store.workspaceSummary(`org_${uuid()}`, me)
      expect(missing.workspace).toBeNull()
      expect(missing.total).toBe(0)
      expect(missing.tags).toEqual([])
      expect(missing.favorites).toBe(0)
    })

    it("collectionsOverview matches listCollections + listRepoSources for the same org", async () => {
      const org = `org_${uuid()}`
      await store.setWorkspace(org, "Overview")
      const col = await store.createCollection({
        id: uuid(),
        org_id: org,
        title: "Repo mirror",
        created_by: "amy",
      })
      await store.createRepoSource({
        id: uuid(),
        org_id: org,
        collection_id: col.id,
        repo: "acme/derive",
        ref: "main",
        includes: "**/*.md",
        pr_number: null,
        created_by: "amy",
      })
      const overview = await store.collectionsOverview(org)
      expect(overview.collections.map((c) => c.id)).toEqual(
        (await store.listCollections(org)).map((c) => c.id),
      )
      expect(overview.sources).toEqual(await store.listRepoSources(org))
      expect(overview.sources).toHaveLength(1)
      // No viewer ⇒ the per-user arms are empty rather than absent, so a caller can
      // destructure them unconditionally.
      expect(overview.starred).toEqual([])
      expect(overview.active).toEqual([])
      expect(overview.previews).toEqual({})
      // An org with nothing yields empties, not an error.
      const empty = await store.collectionsOverview(`org_${uuid()}`)
      expect(empty).toEqual({
        collections: [],
        sources: [],
        starred: [],
        active: [],
        previews: {},
      })
    })

    it("bootstrap reports the same collection roles as the batched method", async () => {
      // The boot batch and /v1/collections both feed the same UI, and a collection
      // with no role is dropped from the response entirely — so if these two disagree,
      // a collection appears on boot and vanishes on the next fetch (or the reverse).
      // Postgres shipped exactly that: its bootstrap arm counted explicit member rows
      // and forgot the workspace seat, so every workspace-open collection the caller
      // had not explicitly joined flickered. Assert the two agree rather than
      // re-asserting either one's contents.
      const org = `org_${uuid()}`
      await store.setWorkspace(org, "Roles parity")
      await store.setMembership({ id: uuid(), org_id: org, user_id: "amy", role: "editor" })
      await store.setMembership({ id: uuid(), org_id: org, user_id: "zed", role: "owner" })

      // The case that broke: workspace-open, created by someone else, amy is not an
      // explicit member. Her seat is the ONLY thing that gives her a role here.
      const open = await store.createCollection({
        id: uuid(),
        org_id: org,
        title: "Workspace-open",
        created_by: "zed",
      })
      // Invite-only, amy explicitly added — the half that never went missing.
      const invited = await store.createCollection({
        id: uuid(),
        org_id: org,
        title: "Invite only",
        created_by: "zed",
        workspace_access: "none",
      })
      await store.setCollectionMember({
        id: uuid(),
        collection_id: invited.id,
        user_id: "amy",
        role: "commenter",
      })
      // Both sources at once: the higher of seat and member row must win, which is
      // why the merge is maxRole and not last-one-in.
      const both = await store.createCollection({
        id: uuid(),
        org_id: org,
        title: "Seat and member row",
        created_by: "zed",
      })
      await store.setCollectionMember({
        id: uuid(),
        collection_id: both.id,
        user_id: "amy",
        role: "viewer",
      })

      const ids = [open.id, invited.id, both.id]
      const batched = await store.collectionRolesForUser(ids, "amy")
      const boot = await store.bootstrap(org, "amy", 20, {
        activeSince: new Date(Date.now() - 30 * 86400_000).toISOString(),
        previewPer: 4,
      })

      for (const id of ids) expect(boot.collectionRoles[id], `role for ${id}`).toBe(batched[id])
      // Not vacuously equal: the seat really does grant a role on the open one.
      expect(batched[open.id]).toBe("editor")
      expect(batched[invited.id]).toBe("commenter")
      // Seat (editor) outranks the explicit viewer row.
      expect(batched[both.id]).toBe("editor")
    })

    it("answers the viewer's stars, worked-in set, and preview strips in the same call", async () => {
      // The whole point of the viewer arms: three reads a route must NOT make separately
      // (see apps/api/test/round-trip-budget.test.ts). They must agree exactly with the
      // standalone methods, or folding them in changed behaviour rather than cost.
      const org = `org_${uuid()}`
      await store.setWorkspace(org, "Viewer overview")
      const starredCol = await store.createCollection({
        id: uuid(),
        org_id: org,
        title: "Starred",
        created_by: "amy",
      })
      const workedCol = await store.createCollection({
        id: uuid(),
        org_id: org,
        title: "Worked in",
        created_by: "amy",
      })
      await store.setCollectionFavorite(starredCol.id, "amy")

      const older = await store.createArtifact(
        newArtifact({ org_id: org, title: "Older", updated_at: "2026-01-01T00:00:00.000Z" }),
      )
      const newer = await store.createArtifact(
        newArtifact({ org_id: org, title: "Newer", updated_at: "2026-02-01T00:00:00.000Z" }),
      )
      await store.addCollectionItem(workedCol.id, older.id)
      await store.addCollectionItem(workedCol.id, newer.id)
      await store.createComment({
        id: uuid(),
        artifact_id: newer.id,
        thread_id: uuid(),
        base_version: 1,
        body_md: "worked on this",
        author: "Amy",
        author_id: "amy",
      })

      const since = new Date(Date.now() - 30 * 86400_000).toISOString()
      const viewer = { userId: "amy", activeSince: since, previewPer: 2 }
      const read = await store.collectionsOverview(org, viewer)

      expect(read.starred).toEqual(await store.listUserFavoriteCollectionIds("amy", org))
      expect(read.starred).toEqual([starredCol.id])
      expect([...read.active].sort()).toEqual(
        [...(await store.collectionsWorkedIn("amy", org, since))].sort(),
      )
      expect(read.active).toEqual([workedCol.id])

      // Newest first, capped, and each cover carries whether a static render exists.
      expect(read.previews[workedCol.id]?.map((p) => p.short_id)).toEqual([
        newer.short_id,
        older.short_id,
      ])
      expect(read.previews[workedCol.id]?.[0]?.has_preview).toBe(false)
      // A collection with nothing in it is absent, not mapped to an empty array.
      expect(read.previews[starredCol.id]).toBeUndefined()

      // Another member of the same workspace sees the org halves and none of amy's
      // personal decoration — these arms are user-scoped, not org-scoped.
      const bobs = await store.collectionsOverview(org, { ...viewer, userId: "bob" })
      expect(bobs.collections.map((c) => c.id).sort()).toEqual(
        read.collections.map((c) => c.id).sort(),
      )
      expect(bobs.starred).toEqual([])
      expect(bobs.active).toEqual([])
      // Previews are a property of the collection, not the reader, so they still come.
      expect(bobs.previews[workedCol.id]).toHaveLength(2)
    })
  })

  describe(`${label}: agents`, () => {
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

    it("rotates a token (org-scoped) and round-trips the managed flag", async () => {
      const t1 = `tok_${uuid()}`
      const agent = await store.createAgent({
        id: uuid(),
        org_id: ORG,
        name: "ctx access",
        token: t1,
        role: "editor",
        managed: 1,
      })
      // managed round-trips; an unmarked agent defaults to 0.
      expect(agent.managed).toBe(1)
      const plain = await store.createAgent({
        id: uuid(),
        org_id: ORG,
        name: "persona",
        token: `tok_${uuid()}`,
        role: "editor",
      })
      expect(plain.managed).toBe(0)
      // Rotation: the old hash dies, the new one resolves, identity is untouched.
      const t2 = `tok_${uuid()}`
      const rotated = await store.rotateAgentToken(agent.id, ORG, t2)
      expect(rotated).toMatchObject({ id: agent.id, name: "ctx access", managed: 1 })
      expect(await store.getAgentByToken(t1)).toBeNull()
      expect(await store.getAgentByToken(t2)).toMatchObject({ id: agent.id })
      // Org-scoped: a foreign org rotates nothing.
      expect(await store.rotateAgentToken(agent.id, "org_other", `tok_${uuid()}`)).toBeNull()
      // Runs-lane liveness: null until an executor polls; the stamp round-trips.
      expect(rotated?.runs_seen_at).toBeNull()
      await store.touchAgentRunsSeen(agent.id, "2026-07-24T12:00:00.000Z")
      expect((await store.getAgentByToken(t2))?.runs_seen_at).toBe("2026-07-24T12:00:00.000Z")
    })
  })

  describe(`${label}: contexts + sessions`, () => {
    const newContext = async () => {
      const manifest = await store.createArtifact(newArtifact({ kind: "bundle" }))
      return store.createContext({
        id: uuid(),
        org_id: ORG,
        name: `analytics_${uuid().slice(0, 8)}`,
        agent_id: uuid(),
        manifest_artifact_id: manifest.id,
        created_by: "rob",
      })
    }

    // The ATTENDED (chat) claim. A contextless session has no agent to check ownership through,
    // so this is its only mutual exclusion — and a primitive that works on one driver and not
    // another is worse than none, which is why it lives in the contract rather than a
    // sqlite-only test. Every driver runs these.
    it("claimAttendedSession: one winner, no double-claim, reclaim after lapse", async () => {
      const mk = async (id: string) =>
        store.createSession({
          id,
          context_id: null,
          context_version: null,
          org_id: ORG,
          asker_id: "rob",
          subject_ref: JSON.stringify({ kind: "artifact", id: "doc1" }),
        })
      const soon = () => new Date(Date.now() + 60_000).toISOString()

      // Ten concurrent callers — two tabs hitting send at once, or a retry after a timeout.
      const raceId = uuid()
      await mk(raceId)
      const claims = await Promise.all(
        Array.from({ length: 10 }, () => store.claimAttendedSession(raceId, soon())),
      )
      expect(claims.filter(Boolean)).toHaveLength(1)

      // A live lease is not re-claimable.
      expect(await store.claimAttendedSession(raceId, soon())).toBeNull()

      // A LAPSED lease is: otherwise a process that died mid-turn strands the session and the
      // UI polls it forever.
      const deadId = uuid()
      await mk(deadId)
      expect(
        await store.claimAttendedSession(deadId, new Date(Date.now() - 1000).toISOString()),
      ).not.toBeNull()
      expect(await store.claimAttendedSession(deadId, soon())).not.toBeNull()

      // Fails closed on a CONTEXT-owned session: those belong to the agent's claim, which
      // checks ownership through the context. This must not become a way around it.
      const cx = await newContext()
      const ctxSes = uuid()
      await store.createSession({
        id: ctxSes,
        context_id: cx.id,
        context_version: 1,
        org_id: ORG,
        asker_id: "rob",
      })
      expect(await store.claimAttendedSession(ctxSes, soon())).toBeNull()
    })

    it("creates a context, lists it by workspace, resolves by id", async () => {
      const ctx = await newContext()
      expect(await store.getContext(ctx.id)).toMatchObject({ name: ctx.name })
      expect((await store.listContexts(ORG)).some((x) => x.id === ctx.id)).toBe(true)
      expect(await store.listContexts(`other_${uuid()}`)).toHaveLength(0)
    })

    it("touchContextSeen stamps runner_seen_at; an unknown id is a quiet no-op", async () => {
      const ctx = await newContext()
      expect(ctx.runner_seen_at).toBeNull()
      const at = new Date().toISOString()
      await store.touchContextSeen(ctx.id, at)
      expect((await store.getContext(ctx.id))?.runner_seen_at).toBe(at)
      await expect(store.touchContextSeen(uuid(), at)).resolves.toBeUndefined()
    })

    it("ask_policy defaults to invited and is settable; the asker roster is idempotent", async () => {
      const ctx = await newContext()
      expect(ctx.ask_policy).toBe("invited")
      await store.setContextAskPolicy(ctx.id, "workspace")
      expect((await store.getContext(ctx.id))?.ask_policy).toBe("workspace")

      expect(await store.getContextAsker(ctx.id, "u_daniel")).toBeNull()
      await store.addContextAsker({
        id: uuid(),
        context_id: ctx.id,
        user_id: "u_daniel",
        added_by: "rob",
      })
      // Idempotent on (context, user) — a re-add doesn't duplicate or throw.
      await store.addContextAsker({
        id: uuid(),
        context_id: ctx.id,
        user_id: "u_daniel",
        added_by: "rob",
      })
      expect(await store.getContextAsker(ctx.id, "u_daniel")).toMatchObject({ user_id: "u_daniel" })
      expect(await store.listContextAskers(ctx.id)).toHaveLength(1)

      await store.removeContextAsker(ctx.id, "u_daniel")
      expect(await store.getContextAsker(ctx.id, "u_daniel")).toBeNull()
      await expect(store.removeContextAsker(ctx.id, "u_nobody")).resolves.toBeUndefined()
    })

    it("rejects a duplicate context name within a workspace", async () => {
      const ctx = await newContext()
      await expect(
        store.createContext({
          id: uuid(),
          org_id: ORG,
          name: ctx.name,
          agent_id: uuid(),
          manifest_artifact_id: ctx.manifest_artifact_id,
          created_by: "rob",
        }),
      ).rejects.toThrow()
    })

    it("runs a session through the ask → answer → follow-up → close turn cycle", async () => {
      const ctx = await newContext()
      const s = await store.createSession({
        id: uuid(),
        context_id: ctx.id,
        org_id: ORG,
        asker_id: "daniel",
        context_version: 1,
      })
      expect(s.state).toBe("open")

      // The asker's question is already "open"; the agent's answer settles it.
      await store.addSessionMessage(
        {
          id: uuid(),
          session_id: s.id,
          author_kind: "asker",
          author_id: "daniel",
          body_md: "churn?",
        },
        "open",
      )
      expect(await store.pendingSessions(ctx.id, 10)).toHaveLength(1)
      await store.addSessionMessage(
        {
          id: uuid(),
          session_id: s.id,
          author_kind: "agent",
          author_id: "ag_x",
          body_md: "32%",
          meta: JSON.stringify({ query: "select …", confidence: 0.9 }),
        },
        "answered",
      )
      expect(await store.pendingSessions(ctx.id, 10)).toHaveLength(0)
      expect((await store.getSession(s.id))?.state).toBe("answered")
      expect((await store.getSession(s.id))?.updated_at).not.toBeNull()

      // A follow-up re-opens (back on the queue); closing takes it off for good.
      await store.addSessionMessage(
        {
          id: uuid(),
          session_id: s.id,
          author_kind: "asker",
          author_id: "daniel",
          body_md: "and Feb?",
        },
        "open",
      )
      expect(await store.pendingSessions(ctx.id, 10)).toHaveLength(1)
      expect(await store.setSessionState(s.id, "closed")).toMatchObject({ state: "closed" })
      expect(await store.pendingSessions(ctx.id, 10)).toHaveLength(0)

      const transcript = await store.listSessionMessages(s.id)
      expect(transcript.map((m) => m.author_kind)).toEqual(["asker", "agent", "asker"])
      expect(JSON.parse(transcript[1].meta ?? "{}").confidence).toBe(0.9)

      // Batched form loads several sessions' transcripts in one call, oldest first, so a
      // caller can group by session_id instead of a listSessionMessages per session.
      const s2 = await store.createSession({
        id: uuid(),
        context_id: ctx.id,
        org_id: ORG,
        asker_id: "erin",
        context_version: 1,
      })
      await store.addSessionMessage(
        { id: uuid(), session_id: s2.id, author_kind: "asker", author_id: "erin", body_md: "hi" },
        "open",
      )
      expect(await store.listSessionMessagesFor([])).toEqual([])
      const both = await store.listSessionMessagesFor([s.id, s2.id])
      expect(both.filter((m) => m.session_id === s.id)).toHaveLength(3)
      expect(both.filter((m) => m.session_id === s2.id)).toHaveLength(1)
    })

    it("scopes session listings to one asker and orders the queue oldest first", async () => {
      const ctx = await newContext()
      const ask = (asker: string) =>
        store.createSession({
          id: uuid(),
          context_id: ctx.id,
          org_id: ORG,
          asker_id: asker,
          context_version: 1,
        })
      const first = await ask("daniel")
      await ask("sarah")
      expect(await store.listSessions(ctx.id)).toHaveLength(2)
      expect(await store.listSessions(ctx.id, { askerId: "daniel" })).toHaveLength(1)
      expect((await store.pendingSessions(ctx.id, 10))[0]?.id).toBe(first.id)
      expect(await store.pendingSessions(ctx.id, 1)).toHaveLength(1)
    })

    it("lists a person's contextless chat sessions, newest first, and nobody else's", async () => {
      const ctx = await newContext()
      // A session WITH a context must never appear here: the chat history is the sessions
      // nobody packaged, and a context's sessions have their own console.
      await store.createSession({
        id: uuid(),
        context_id: ctx.id,
        org_id: ORG,
        asker_id: "daniel",
        context_version: 1,
      })
      const chat = (asker: string, org = ORG) =>
        store.createSession({
          id: uuid(),
          context_id: null,
          org_id: org,
          asker_id: asker,
          context_version: null,
        })
      const older = await chat("daniel")
      // created_at is millisecond-precision, so two adjacent inserts can tie and make the
      // ordering assertion below a coin flip. A 2ms gap is the whole fix.
      await new Promise((r) => setTimeout(r, 2))
      const newer = await chat("daniel")
      await chat("sarah")
      await chat("daniel", "org_other")

      const mine = await store.listChatSessions(ORG, "daniel")
      expect(mine.map((s) => s.id)).toEqual([newer.id, older.id])
      expect(await store.listChatSessions(ORG, "daniel", 1)).toHaveLength(1)
      expect(await store.listChatSessions(ORG, "sarah")).toHaveLength(1)
      expect(await store.listChatSessions("org_none", "daniel")).toEqual([])
    })

    it("deleteArtifact on a manifest cascades its context, sessions, and messages", async () => {
      const ctx = await newContext()
      const s = await store.createSession({
        id: uuid(),
        context_id: ctx.id,
        org_id: ORG,
        asker_id: "daniel",
        context_version: 1,
      })
      await store.addSessionMessage(
        { id: uuid(), session_id: s.id, author_kind: "asker", author_id: "daniel", body_md: "q" },
        "open",
      )
      // Without the cascade this FK-throws on pg/D1 (context.manifest_artifact_id).
      await store.deleteArtifact(ctx.manifest_artifact_id, ORG)
      expect(await store.getContext(ctx.id)).toBeNull()
      expect(await store.getSession(s.id)).toBeNull()
    })

    it("deleteContext cascades sessions and messages, scoped to its workspace", async () => {
      const ctx = await newContext()
      const s = await store.createSession({
        id: uuid(),
        context_id: ctx.id,
        org_id: ORG,
        asker_id: "daniel",
        context_version: 1,
      })
      await store.addSessionMessage(
        { id: uuid(), session_id: s.id, author_kind: "asker", author_id: "daniel", body_md: "hi" },
        "open",
      )
      // Wrong workspace: a no-op — the scope gates the whole cascade, so another
      // tenant's delete can't wipe the sessions either.
      await store.deleteContext(ctx.id, `other_${uuid()}`)
      expect(await store.getContext(ctx.id)).not.toBeNull()
      expect(await store.getSession(s.id)).not.toBeNull()
      await store.deleteContext(ctx.id, ORG)
      expect(await store.getContext(ctx.id)).toBeNull()
      expect(await store.getSession(s.id)).toBeNull()
      expect(await store.listSessionMessages(s.id)).toHaveLength(0)
    })

    it("claim/lease queue: lapsed-lease self-heal, concurrency cap, dedupe, result binding", async () => {
      const ctx = await newContext()
      const open = (asker: string, dedupe_key?: string) =>
        store.createSession({
          id: uuid(),
          context_id: ctx.id,
          org_id: ORG,
          asker_id: asker,
          context_version: 1,
          dedupe_key,
        })

      // CLAIM flips open -> working, stamps started_at + the lease; only claimed rows return.
      const s1 = await open("a")
      const s2 = await open("b")
      const future = new Date(Date.now() + 60_000).toISOString()
      const claimed = await store.claimPendingSessions(ctx.id, 10, future)
      expect(claimed.map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort())
      expect(
        claimed.every((s) => s.state === "working" && !!s.started_at && s.lease_until === future),
      ).toBe(true)
      // A second claim gets nothing — both are working with a LIVE lease.
      expect(await store.claimPendingSessions(ctx.id, 10, future)).toHaveLength(0)
      expect(await store.countWorkingSessions(ctx.id)).toBe(2)

      // F1: a LAPSED lease drops out of the concurrency-cap count AND is reclaimable, so a
      // crashed run self-heals instead of wedging the queue. renewSessionLease sets it.
      const past = new Date(Date.now() - 60_000).toISOString()
      await store.renewSessionLease(s1.id, past)
      expect(await store.countWorkingSessions(ctx.id)).toBe(1)
      expect((await store.claimPendingSessions(ctx.id, 10, future)).map((s) => s.id)).toEqual([
        s1.id,
      ])
      expect(await store.countWorkingSessions(ctx.id)).toBe(2)

      // The living result page binds to a session.
      await store.setResultArtifact(s1.id, "art_xyz")
      expect((await store.getSession(s1.id))?.result_artifact_id).toBe("art_xyz")

      // findInflightSession is scoped to (context, asker, key): the newest live match for
      // THIS asker, null once settled.
      const k1 = await open("c", "brand-x")
      expect((await store.findInflightSession(ctx.id, "c", "brand-x"))?.id).toBe(k1.id)
      expect(await store.findInflightSession(ctx.id, "c", "missing")).toBeNull()

      // Cross-asker isolation: a DIFFERENT asker reusing the same key gets their OWN live
      // session (the unique index is per-asker), and c's lookup never returns it — the exact
      // cross-asker join-leak the asker scope closes. A global (context, key) index would
      // have rejected d's insert and joined d onto c's private session.
      const kd = await open("d", "brand-x")
      expect(kd.id).not.toBe(k1.id)
      expect((await store.findInflightSession(ctx.id, "d", "brand-x"))?.id).toBe(kd.id)
      expect((await store.findInflightSession(ctx.id, "c", "brand-x"))?.id).toBe(k1.id)

      await store.setSessionState(k1.id, "answered")
      expect(await store.findInflightSession(ctx.id, "c", "brand-x")).toBeNull()

      // Two LIVE sessions for the SAME asker can't share a dedupe key (the partial unique index).
      const k2 = await open("c", "brand-x") // ok — k1 is settled, out of the partial index
      await expect(open("c", "brand-x")).rejects.toThrow() // k2 is live: collision

      // appendFollowupReopen on a SETTLED session (k1 is answered): it goes to `open` AND
      // drops its dedupe key atomically, so it can reopen alongside the live same-key k2
      // without colliding on the partial index (folds the old F4 clear).
      await expect(
        store.appendFollowupReopen({
          id: uuid(),
          session_id: k1.id,
          author_kind: "asker",
          author_id: "c",
          body_md: "more",
        }),
      ).resolves.toBeTruthy()
      const k1re = await store.getSession(k1.id)
      expect(k1re?.state).toBe("open")
      expect(k1re?.dedupe_key).toBeNull()
      expect(k2.state).toBe("open")

      // F6: appendFollowupReopen on a WORKING session must STAY working (don't vacate the
      // active claim) — a read-then-write reopen would race a concurrent settle and could
      // strand it `working` with no runner. s2 is still working with a live lease.
      expect((await store.getSession(s2.id))?.state).toBe("working")
      await store.appendFollowupReopen({
        id: uuid(),
        session_id: s2.id,
        author_kind: "asker",
        author_id: "b",
        body_md: "still there?",
      })
      expect((await store.getSession(s2.id))?.state).toBe("working")
    })
  })

  describe(`${label}: deleteArtifact`, () => {
    it("hard-deletes the artifact row and all FK-dependent rows", async () => {
      const a = await store.createArtifact(newArtifact())
      const thread = uuid()
      const dv = await store.addVersion(a.id, newVersion())
      // Facts hang off the version by artifact_id — a delete that doesn't clear them
      // first hits a FOREIGN KEY constraint (found by deleting a fact-bearing artifact live).
      await store.setVersionData(a.id, dv.n, [
        { id: uuid(), slot: "checks", json: `{"pass":1}`, size_bytes: 10, gen: 1 },
      ])
      await store.createComment({
        id: uuid(),
        artifact_id: a.id,
        thread_id: thread,
        base_version: 1,
        body_md: "hi",
        author: "amy",
      })
      await store.setArtifactMember({
        id: uuid(),
        artifact_id: a.id,
        user_id: "bob",
        role: "viewer",
      })
      // An artifact-SCOPED webhook FKs to artifact.id too — the same trap as version_data,
      // and it was live in the codebase until scripts/check-delete-cascade.mjs named it.
      await store.createWebhook({
        id: uuid(),
        org_id: ORG,
        artifact_id: a.id,
        url: "https://example.test/hook",
        secret: "s",
        kind: "generic",
        events: "*",
      })
      await store.setFavorite(a.id, "amy")
      await store.setArtifactTags(a.id, ["del-tag"])
      await store.setSlackThreadLink({
        id: uuid(),
        org_id: ORG,
        artifact_id: a.id,
        thread_id: thread,
        channel: "C1",
        message_ts: "1.1",
        created_at: "2026-01-01T00:00:00.000Z",
      })

      await store.deleteArtifact(a.id, ORG)

      expect(await store.getByShortId(a.short_id)).toBeNull()
      expect(await store.getArtifactById(a.id)).toBeNull()
      expect(await store.listVersions(a.id)).toHaveLength(0)
      expect(await store.getVersionData(a.id, dv.n)).toHaveLength(0)
      expect(await store.listComments(a.id)).toHaveLength(0)
      expect(await store.getArtifactMember(a.id, "bob")).toBeNull()
      expect(await store.listUserFavoriteIds("amy")).not.toContain(a.id)
      expect(await store.artifactIdsByTag("del-tag")).not.toContain(a.id)
      // The Slack thread link is thread-keyed, not artifact_id-obvious — regression guard
      // that it's cleaned too (it was orphaned before).
      expect(await store.listSlackThreadLinksByThread(thread)).toHaveLength(0)
    })
  })

  describe(`${label}: deleteThread`, () => {
    it("hard-removes a thread's comments, notifications, and Slack link — scoped to the thread", async () => {
      const a = await store.createArtifact(newArtifact())
      const dead = uuid()
      const kept = uuid()
      const mkComment = (thread: string, body: string) =>
        store.createComment({
          id: uuid(),
          artifact_id: a.id,
          thread_id: thread,
          base_version: 1,
          body_md: body,
          author: "amy",
        })
      // The doomed thread (root + reply) and a sibling thread that must survive.
      await mkComment(dead, "root")
      await mkComment(dead, "reply")
      await mkComment(kept, "untouched")
      const mkNotif = (thread: string, commentId: string) =>
        store.createNotification({
          id: uuid(),
          user_id: "bob",
          actor: "amy",
          kind: "mention",
          artifact_id: a.id,
          artifact_short_id: a.short_id,
          artifact_title: null,
          thread_id: thread,
          comment_id: commentId,
          preview: "hi",
        })
      await mkNotif(dead, uuid())
      await mkNotif(kept, uuid())
      await store.setSlackThreadLink({
        id: uuid(),
        org_id: ORG,
        artifact_id: a.id,
        thread_id: dead,
        channel: "C1",
        message_ts: "1.1",
        created_at: "2026-01-01T00:00:00.000Z",
      })

      await store.deleteThread(a.id, dead)

      // The whole dead thread is gone — no ghost, no dangling notification or Slack link.
      const comments = await store.listComments(a.id)
      expect(comments.map((c) => c.thread_id)).toEqual([kept])
      expect(await store.listSlackThreadLinksByThread(dead)).toHaveLength(0)
      const notifs = await store.listNotifications("bob", 50)
      expect(notifs.map((n) => n.thread_id)).toEqual([kept]) // the sibling's survives
    })
  })

  describe(`${label}: full-text search index`, () => {
    const ids = (hits: { id: string }[]) => hits.map((h) => h.id).sort()
    it("indexes text, finds it ranked, scoped to one org; reindex/unindex mutate it", async () => {
      const a = await store.createArtifact(newArtifact())
      const b = await store.createArtifact(newArtifact())
      const elsewhere = await store.createArtifact(newArtifact({ org_id: `org_${uuid()}` }))
      await store.indexArtifact(
        a.id,
        ORG,
        "Revenue report",
        "quarterly revenue grew twenty percent",
      )
      await store.indexArtifact(b.id, ORG, "Costs", "operating costs held flat this period")
      await store.indexArtifact(elsewhere.id, elsewhere.org_id, "Revenue", "revenue in another org")

      // Relevance: "revenue" finds a, not b; "costs" finds b, not a.
      expect(ids(await store.searchArtifactIds(ORG, "revenue", 10))).toEqual([a.id])
      expect(ids(await store.searchArtifactIds(ORG, "costs", 10))).toEqual([b.id])
      // Org isolation: the same-word artifact in another org never leaks into ORG.
      expect(ids(await store.searchArtifactIds(ORG, "revenue", 10))).not.toContain(elsewhere.id)
      expect(ids(await store.searchArtifactIds(elsewhere.org_id, "revenue", 10))).toEqual([
        elsewhere.id,
      ])
      // Title is searchable too.
      expect(ids(await store.searchArtifactIds(ORG, "report", 10))).toEqual([a.id])

      // Reindex (a new version) REPLACES the prior text.
      await store.indexArtifact(a.id, ORG, "Now", "entirely different subject matter here")
      expect(await store.searchArtifactIds(ORG, "revenue", 10)).toHaveLength(0)
      expect(ids(await store.searchArtifactIds(ORG, "subject", 10))).toEqual([a.id])

      // Unindex drops it.
      await store.unindexArtifact(a.id)
      expect(await store.searchArtifactIds(ORG, "subject", 10)).toHaveLength(0)

      // A punctuation-only query yields nothing — the literal text is never read as
      // query syntax (no FTS injection / no error).
      expect(await store.searchArtifactIds(ORG, "!!! (*)", 10)).toHaveLength(0)
    })

    it("ranks a more-relevant artifact first, and honours the limit", async () => {
      const hi = await store.createArtifact(newArtifact())
      const lo = await store.createArtifact(newArtifact())
      await store.indexArtifact(hi.id, ORG, null, Array(12).fill("kestrel").join(" "))
      await store.indexArtifact(lo.id, ORG, null, "kestrel among many unrelated other words here")
      const ranked = await store.searchArtifactIds(ORG, "kestrel", 10)
      expect(ranked).toHaveLength(2)
      expect(ranked[0]?.id).toBe(hi.id) // far more occurrences → higher rank in both dialects
      expect(ranked[0]?.rank).toBeGreaterThanOrEqual(ranked[1]?.rank ?? 0)
      expect(await store.searchArtifactIds(ORG, "kestrel", 1)).toHaveLength(1)
    })

    it("prefix-matches a partial word onto its whole word (both dialects)", async () => {
      const a = await store.createArtifact(newArtifact())
      await store.indexArtifact(a.id, ORG, null, "the authentication flow uses rotating tokens")
      // A partial word finds the whole word — candidate recall; the caller's grep pass
      // still enforces the exact literal. Same behaviour on fts5 (`"auth"*`) and
      // tsvector (`auth:*`).
      expect(ids(await store.searchArtifactIds(ORG, "auth", 10))).toEqual([a.id])
      expect(ids(await store.searchArtifactIds(ORG, "rotat", 10))).toEqual([a.id])
      // Multiple prefix tokens AND together.
      expect(ids(await store.searchArtifactIds(ORG, "auth token", 10))).toEqual([a.id])
      // A word absent from the text still doesn't match.
      expect(await store.searchArtifactIds(ORG, "invoice", 10)).toHaveLength(0)
    })

    it("deleteArtifact drops the artifact's index row", async () => {
      const a = await store.createArtifact(newArtifact())
      await store.indexArtifact(a.id, ORG, "Ledger", "reconciliation of the general ledger")
      expect(ids(await store.searchArtifactIds(ORG, "reconciliation", 10))).toEqual([a.id])
      await store.deleteArtifact(a.id)
      expect(await store.searchArtifactIds(ORG, "reconciliation", 10)).toHaveLength(0)
    })

    it("moveArtifactOrg re-scopes the index row to the new workspace", async () => {
      const target = `org_${uuid()}`
      const a = await store.createArtifact(newArtifact())
      await store.indexArtifact(a.id, ORG, null, "migration playbook for the platform team")
      expect(ids(await store.searchArtifactIds(ORG, "migration", 10))).toEqual([a.id])
      await store.moveArtifactOrg(a.id, target)
      // Gone from the old workspace's search; present in the new one (its text is
      // unchanged by the move — only the scope column moves).
      expect(await store.searchArtifactIds(ORG, "migration", 10)).toHaveLength(0)
      expect(ids(await store.searchArtifactIds(target, "migration", 10))).toEqual([a.id])
    })

    it("is accent-SENSITIVE identically on both dialects (fts5 remove_diacritics 0 == tsvector 'simple')", async () => {
      const a = await store.createArtifact(newArtifact())
      await store.indexArtifact(a.id, ORG, null, "the café résumé report")
      // The exact accented form matches; the unaccented form does NOT — the same on
      // fts5 and tsvector, and consistent with the byte-literal grep-confirm ("cafe"
      // would not grep "café" either). unicode61's default would fold café→cafe and
      // silently diverge from Postgres; remove_diacritics 0 pins the parity.
      expect(ids(await store.searchArtifactIds(ORG, "café", 10))).toEqual([a.id])
      expect(ids(await store.searchArtifactIds(ORG, "résumé", 10))).toEqual([a.id])
      expect(await store.searchArtifactIds(ORG, "cafe", 10)).toHaveLength(0)
    })

    it("excludeRemoved drops taken-down rows from listArtifacts (the search visibility gate)", async () => {
      const a = await store.createArtifact(newArtifact({ listed: "workspace" }))
      const seen = async (opts: Parameters<typeof store.listArtifacts>[0]) =>
        (await store.listArtifacts(opts)).map((x) => x.id)
      expect(await seen({ orgId: ORG, ids: [a.id] })).toEqual([a.id])
      await store.setArtifactRemoved(a.id, new Date().toISOString())
      // The default (feed) listing still returns the tombstone; the search gate,
      // which reads the live blob, must exclude it — this is what keeps a moderated
      // artifact's text out of workspace search.
      expect(await seen({ orgId: ORG, ids: [a.id] })).toEqual([a.id])
      expect(
        await store.listArtifacts({ orgId: ORG, ids: [a.id], excludeRemoved: true }),
      ).toHaveLength(0)
    })
  })

  describe(`${label}: moderation (reports, takedown, audit)`, () => {
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

    it("takedownArtifact applies the tombstone, resolves open reports, and audits atomically", async () => {
      const a = await store.createArtifact(newArtifact())
      // Two open reports against this artifact, plus one against another that must
      // be left untouched (the bulk resolve is scoped to the target artifact).
      const r1 = await store.createReport({
        id: uuid(),
        org_id: ORG,
        artifact_id: a.id,
        artifact_short_id: a.short_id,
        reason: "spam",
      })
      const r2 = await store.createReport({
        id: uuid(),
        org_id: ORG,
        artifact_id: a.id,
        artifact_short_id: a.short_id,
        reason: "abuse",
      })
      const other = await store.createArtifact(newArtifact())
      const rOther = await store.createReport({
        id: uuid(),
        org_id: ORG,
        artifact_id: other.id,
        artifact_short_id: other.short_id,
        reason: "unrelated",
      })

      await store.takedownArtifact({
        artifactId: a.id,
        orgId: ORG,
        removedAt: "2026-06-14T00:00:00.000Z",
        audit: {
          id: uuid(),
          org_id: ORG,
          action: "takedown",
          artifact_id: a.id,
          actor: "amy",
          detail: "policy",
        },
      })

      // Tombstone set, both of this artifact's reports actioned, the other left open.
      expect((await store.getArtifactById(a.id))?.removed_at).toBe("2026-06-14T00:00:00.000Z")
      expect((await store.getReport(r1.id, ORG))?.state).toBe("actioned")
      expect((await store.getReport(r2.id, ORG))?.state).toBe("actioned")
      expect((await store.getReport(rOther.id, ORG))?.state).toBe("open")
      // The audit entry landed in the same step.
      const log = await store.listAuditLog(ORG, { artifactId: a.id })
      expect(log.map((x) => x.action)).toContain("takedown")
    })
  })

  describe(`${label}: integration settings + Slack`, () => {
    it("returns defaults for an unset org, then round-trips an override (insert + upsert)", async () => {
      const settingsOrg = `org_${uuid()}`
      // Unset → the full default set.
      expect(await store.getOrgSettings(settingsOrg)).toEqual(DEFAULT_ORG_SETTINGS)
      // First write (insert path). Overridden channels stick; the rest stay default on read.
      await store.setOrgSettings(settingsOrg, {
        ...DEFAULT_ORG_SETTINGS,
        githubPostComments: false,
      })
      expect(await store.getOrgSettings(settingsOrg)).toMatchObject({
        emailNotifications: true,
        githubPostComments: false,
        githubMirrorComments: true,
      })
      // Second write for the same org exercises the onConflict update path.
      await store.setOrgSettings(settingsOrg, {
        ...DEFAULT_ORG_SETTINGS,
        emailNotifications: false,
      })
      expect(await store.getOrgSettings(settingsOrg)).toMatchObject({
        emailNotifications: false,
        githubPostComments: true,
      })
    })

    it("installs, re-installs (token rotation), and deletes a Slack workspace", async () => {
      expect(await store.getSlackInstall(ORG)).toBeNull()
      await store.setSlackInstall({
        org_id: ORG,
        team_id: "T1",
        team_name: "Acme",
        bot_token: "xoxb-1",
        bot_user_id: "U1",
        created_at: "2026-06-20T00:00:00.000Z",
      })
      expect(await store.getSlackInstall(ORG)).toMatchObject({ team_id: "T1", bot_token: "xoxb-1" })
      // Re-install (onConflict update): rotate the token, rename, change channel.
      await store.setSlackInstall({
        org_id: ORG,
        team_id: "T1",
        team_name: "Acme Inc",
        bot_token: "xoxb-2",
        bot_user_id: "U1",
        created_at: "2026-06-21T00:00:00.000Z",
      })
      expect(await store.getSlackInstall(ORG)).toMatchObject({
        team_name: "Acme Inc",
        bot_token: "xoxb-2",
      })
      await store.deleteSlackInstall(ORG)
      expect(await store.getSlackInstall(ORG)).toBeNull()
    })

    it("links a Slack thread to an artifact per channel, found by (thread, channel) or channel+ts", async () => {
      const a = await store.createArtifact(newArtifact())
      const link = {
        id: uuid(),
        org_id: ORG,
        artifact_id: a.id,
        thread_id: `th_${uuid()}`,
        channel: "C9",
        message_ts: "1700000000.000100",
        created_at: "2026-06-20T00:00:00.000Z",
      }
      await store.setSlackThreadLink(link)
      expect(await store.getSlackThreadLink(link.thread_id, "C9")).toMatchObject({
        artifact_id: a.id,
        channel: "C9",
        message_ts: "1700000000.000100",
      })
      expect(await store.getSlackThreadLinkByTs("C9", "1700000000.000100")).toMatchObject({
        thread_id: link.thread_id,
      })
      // The same thread mirrored into a SECOND channel is a second link, not a conflict —
      // that is the whole point of keying on (thread_id, channel).
      await store.setSlackThreadLink({
        ...link,
        id: uuid(),
        channel: "C8",
        message_ts: "1700000000.000200",
      })
      expect(
        (await store.listSlackThreadLinksByThread(link.thread_id)).map((l) => l.channel).sort(),
      ).toEqual(["C8", "C9"])
      // Misses return null / empty.
      expect(await store.getSlackThreadLink(link.thread_id, "C-nope")).toBeNull()
      expect(await store.listSlackThreadLinksByThread(`missing_${uuid()}`)).toHaveLength(0)
      expect(await store.getSlackThreadLinkByTs("C9", "nope")).toBeNull()
    })

    it("subscribes channels to a workspace, scoped and filtered, and upserts by target", async () => {
      const org = `org_sub_${uuid()}`
      const ws = await store.upsertSlackSubscription({
        id: uuid(),
        org_id: org,
        channel_id: "C-eng",
        channel_name: "#eng",
        created_by: "u-1",
      })
      // Defaults: the whole workspace, every event, either author, live.
      expect(ws).toMatchObject({
        scope_kind: "workspace",
        scope_id: "",
        events: "*",
        authors: "all",
        active: 1,
      })

      // A collection scope on the SAME channel is a different subscription, not a conflict.
      const coll = await store.upsertSlackSubscription({
        id: uuid(),
        org_id: org,
        channel_id: "C-eng",
        scope_kind: "collection",
        scope_id: "col_1",
        events: "version.published",
        authors: "human",
      })
      expect(coll.id).not.toBe(ws.id)
      expect(await store.listSlackSubscriptions(org)).toHaveLength(2)

      // The same TARGET upserts in place rather than duplicating. This is the case a nullable
      // scope_id would have broken: SQL treats NULLs as distinct, so the workspace-scoped row
      // would have inserted a second time and the upsert would never have matched.
      const again = await store.upsertSlackSubscription({
        id: uuid(),
        org_id: org,
        channel_id: "C-eng",
        events: "comment.created",
      })
      expect(again.id).toBe(ws.id)
      expect(again.events).toBe("comment.created")
      expect(await store.listSlackSubscriptions(org)).toHaveLength(2)
    })

    it("updates and deletes subscriptions, org-scoped", async () => {
      const org = `org_sub2_${uuid()}`
      const other = `org_sub3_${uuid()}`
      const sub = await store.upsertSlackSubscription({
        id: uuid(),
        org_id: org,
        channel_id: "C-design",
      })
      expect(
        await store.updateSlackSubscription(sub.id, org, { active: 0, authors: "agent" }),
      ).toMatchObject({ active: 0, authors: "agent" })
      // A caller in another workspace can neither read nor write it.
      expect(await store.updateSlackSubscription(sub.id, other, { active: 1 })).toBeNull()
      await store.deleteSlackSubscription(sub.id, other)
      expect(await store.listSlackSubscriptions(org)).toHaveLength(1)
      await store.deleteSlackSubscription(sub.id, org)
      expect(await store.listSlackSubscriptions(org)).toHaveLength(0)
    })

    it("removes every subscription for a channel (the /derive unsubscribe path)", async () => {
      const org = `org_sub4_${uuid()}`
      await store.upsertSlackSubscription({ id: uuid(), org_id: org, channel_id: "C-x" })
      await store.upsertSlackSubscription({
        id: uuid(),
        org_id: org,
        channel_id: "C-x",
        scope_kind: "collection",
        scope_id: "col_9",
      })
      await store.upsertSlackSubscription({ id: uuid(), org_id: org, channel_id: "C-keep" })
      await store.deleteSlackSubscriptionsByChannel(org, "C-x")
      expect((await store.listSlackSubscriptions(org)).map((x) => x.channel_id)).toEqual(["C-keep"])
    })

    it("deleteUserData: removes the user's rows, anonymizes authorship, keeps others' content", async () => {
      const org = `org_del_${uuid()}`
      const leaver = `leaver_${uuid()}`
      const other = `other_${uuid()}`
      // A shared workspace + the leaver's personal one.
      await store.setWorkspace(org, "Shared")
      await store.setWorkspace(`ws_p_${leaver}`, "Leaver's Workspace")
      await store.setMembership({ id: uuid(), org_id: org, user_id: leaver, role: "owner" })
      await store.setMembership({ id: uuid(), org_id: org, user_id: other, role: "owner" })
      await store.setMembership({
        id: uuid(),
        org_id: `ws_p_${leaver}`,
        user_id: leaver,
        role: "owner",
      })
      // Two artifacts: one authored by the leaver, one by someone else.
      const mine = await store.createArtifact(newArtifact({ org_id: org, author_id: leaver }))
      const theirs = await store.createArtifact(newArtifact({ org_id: org, author_id: other }))
      // The leaver's associations: a favorite and a follow.
      await store.setFavorite(theirs.id, leaver)
      await store.addFollow({
        id: uuid(),
        user_id: leaver,
        org_id: org,
        kind: "user",
        target: other,
      })
      // The leaver's connected plan token, plus a workspace-pool row and another member's.
      const credNow = "2026-07-24T00:00:00.000Z"
      const mkCred = (userId: string, secret: string) => ({
        id: uuid(),
        org_id: org,
        user_id: userId,
        provider: "codex",
        kind: "oauth" as const,
        secret,
        hint: secret.slice(-4),
        created_at: credNow,
        updated_at: credNow,
      })
      await store.setModelCredential(mkCred(leaver, "enc-leaver"))
      await store.setModelCredential(mkCred(other, "enc-other"))
      await store.setModelCredential(mkCred("__workspace_pool__", "enc-pool"))

      await store.deleteUserData(leaver)

      // Their memberships are gone (both shared + personal); the other member stays.
      expect(await store.getMembership(org, leaver)).toBeNull()
      expect(await store.getMembership(`ws_p_${leaver}`, leaver)).toBeNull()
      expect(await store.getMembership(org, other)).not.toBeNull()
      // Their personal workspace row is dropped; the shared one survives.
      expect(await store.getWorkspace(`ws_p_${leaver}`)).toBeNull()
      expect(await store.getWorkspace(org)).not.toBeNull()
      // Associations cleared.
      expect(await store.listUserFavoriteIds(leaver)).toEqual([])
      expect(await store.listFollows(leaver, org)).toEqual([])
      // Authorship anonymized on their artifact; the other's is untouched — and BOTH
      // artifacts still exist (content is never hard-deleted).
      expect((await store.getArtifactById(mine.id))?.author_id ?? null).toBeNull()
      expect((await store.getArtifactById(theirs.id))?.author_id).toBe(other)
      // Their connected plan token is PURGED; the workspace-pool row (sentinel user) and
      // other members' plans survive untouched.
      expect(await store.getModelCredential(org, leaver, "codex")).toBeNull()
      expect((await store.getModelCredential(org, other, "codex"))?.secret).toBe("enc-other")
      expect((await store.getModelCredential(org, "__workspace_pool__", "codex"))?.secret).toBe(
        "enc-pool",
      )
    })

    it("removeMembership + deleteWorkspace purge model_credential (incl. the pool sentinel)", async () => {
      const org = `org_ws_${uuid()}`
      const member = `member_${uuid()}`
      const now = "2026-07-24T00:00:00.000Z"
      const cred = (userId: string, secret: string) => ({
        id: uuid(),
        org_id: org,
        user_id: userId,
        provider: "codex",
        kind: "login" as const,
        secret,
        hint: secret.slice(-4),
        created_at: now,
        updated_at: now,
      })
      await store.setWorkspace(org, "WS")
      await store.setMembership({ id: uuid(), org_id: org, user_id: member, role: "editor" })
      await store.setModelCredential(cred(member, "enc-member"))
      await store.setModelCredential(cred("__workspace_pool__", "enc-pool"))

      // Removing a member drops only their credential; the pool row stays.
      await store.removeMembership(org, member)
      expect(await store.getModelCredential(org, member, "codex")).toBeNull()
      expect((await store.getModelCredential(org, "__workspace_pool__", "codex"))?.secret).toBe(
        "enc-pool",
      )

      // Deleting the workspace clears the pool sentinel too — nothing orphaned.
      await store.deleteWorkspace(org)
      expect(await store.getModelCredential(org, "__workspace_pool__", "codex")).toBeNull()
    })
  })

  describe(`${label}: subscriptions (Stripe billing cache)`, () => {
    it("subscription: absent → null; upsert inserts then updates; stripe-id lookup", async () => {
      const org = `sub_org_${uuid()}`
      expect(await store.getSubscription(org)).toBeNull()
      expect(await store.getSubscriptionByStripeId("sub_nope")).toBeNull()
      const now = new Date().toISOString()
      const stripeSubscriptionId = `sub_stripe_${uuid()}`
      await store.upsertSubscription({
        org_id: org,
        stripe_customer_id: "cus_1",
        stripe_subscription_id: stripeSubscriptionId,
        tier: "team",
        billing_interval: "month",
        status: "active",
        quantity: 4,
        current_period_end: "2026-08-30T00:00:00.000Z",
        created_at: now,
        updated_at: now,
      })
      const row = await store.getSubscription(org)
      expect(row?.tier).toBe("team")
      expect(row?.quantity).toBe(4)
      expect((await store.getSubscriptionByStripeId(stripeSubscriptionId))?.org_id).toBe(org)
      // Second upsert for the same org exercises the onConflict update path.
      await store.upsertSubscription({
        ...(row as SubscriptionRecord),
        status: "canceled",
        quantity: 5,
        updated_at: new Date().toISOString(),
      })
      const updated = await store.getSubscription(org)
      expect(updated?.status).toBe("canceled")
      expect(updated?.quantity).toBe(5)
    })
  })

  describe(`${label}: automations + runs`, () => {
    it("creates automations and lists them scoped to the workspace", async () => {
      const agentId = uuid()
      const a1 = await store.createAutomation({
        id: uuid(),
        org_id: ORG,
        agent_id: agentId,
        trigger: JSON.stringify({ kind: "manual" }),
        instruction: "keep the roadmap current",
      })
      expect((await store.getAutomation(a1.id))?.instruction).toBe("keep the roadmap current")
      // An automation in another workspace must not leak into this list.
      await store.createAutomation({
        id: uuid(),
        org_id: `org_${uuid()}`,
        agent_id: agentId,
        trigger: JSON.stringify({ kind: "schedule", cron: "0 9 * * 1", tz: "UTC" }),
        instruction: "elsewhere",
      })
      const list = await store.listAutomations(ORG)
      expect(list.every((a) => a.org_id === ORG)).toBe(true)
      expect(list.some((a) => a.id === a1.id)).toBe(true)
    })

    it("updates an automation partially, org-scoped; wrong org is a null no-op", async () => {
      const rec = await store.createAutomation({
        id: uuid(),
        org_id: ORG,
        agent_id: uuid(),
        trigger: JSON.stringify({ kind: "manual" }),
        instruction: "before",
      })
      const upd = await store.updateAutomation(rec.id, ORG, {
        instruction: "after",
        enabled: 0,
      })
      expect(upd?.instruction).toBe("after")
      expect(upd?.enabled).toBe(0)
      // Untouched fields survive.
      expect(upd?.trigger).toBe(rec.trigger)
      // Cross-org: no row updated.
      expect(
        await store.updateAutomation(rec.id, "other-org", { instruction: "hijack" }),
      ).toBeNull()
      // Empty patch returns the current row.
      expect((await store.updateAutomation(rec.id, ORG, {}))?.instruction).toBe("after")
    })

    it("batch-loads automations by id in one query; empty ids ⇒ []", async () => {
      const agentId = uuid()
      const mk = () =>
        store.createAutomation({
          id: uuid(),
          org_id: ORG,
          agent_id: agentId,
          trigger: JSON.stringify({ kind: "manual" }),
          instruction: "batch me",
        })
      const [a, b] = await Promise.all([mk(), mk()])
      expect(await store.getAutomationsByIds([])).toEqual([])
      const got = await store.getAutomationsByIds([a.id, b.id, "auto_missing"])
      expect(got.map((x) => x.id).sort()).toEqual([a.id, b.id].sort())
    })

    it("model credentials: upsert, get, list per user, delete — all scoped (org, user, provider)", async () => {
      const now = "2026-07-24T00:00:00.000Z"
      const cred = (userId: string, provider: string, secret: string) => ({
        id: uuid(),
        org_id: ORG,
        user_id: userId,
        provider,
        kind: "oauth" as const,
        secret,
        hint: secret.slice(-4),
        created_at: now,
        updated_at: now,
      })
      await store.setModelCredential(cred("u1", "codex", "enc-A"))
      await store.setModelCredential(cred("u1", "claude-code", "enc-B"))
      await store.setModelCredential(cred("u2", "codex", "enc-C"))

      // Get is keyed (org, user, provider) — never leaks across users.
      expect((await store.getModelCredential(ORG, "u1", "codex"))?.secret).toBe("enc-A")
      expect((await store.getModelCredential(ORG, "u2", "codex"))?.secret).toBe("enc-C")
      expect(await store.getModelCredential(ORG, "u1", "gemini")).toBeNull()

      // Upsert replaces the secret for the same key, not a second row.
      await store.setModelCredential(cred("u1", "codex", "enc-A2"))
      expect((await store.getModelCredential(ORG, "u1", "codex"))?.secret).toBe("enc-A2")

      // List returns only that user's rows.
      const u1 = await store.listModelCredentials(ORG, "u1")
      expect(u1.map((c) => c.provider).sort()).toEqual(["claude-code", "codex"])
      expect((await store.listModelCredentials(ORG, "u2")).map((c) => c.provider)).toEqual([
        "codex",
      ])

      // Delete is scoped: removing u1/codex leaves u1/claude-code and u2/codex.
      await store.deleteModelCredential(ORG, "u1", "codex")
      expect(await store.getModelCredential(ORG, "u1", "codex")).toBeNull()
      expect((await store.getModelCredential(ORG, "u1", "claude-code"))?.secret).toBe("enc-B")
      expect((await store.getModelCredential(ORG, "u2", "codex"))?.secret).toBe("enc-C")
    })

    it("queue + ledger: enqueue → claim (running) → finish; a second claim gets nothing", async () => {
      const agentId = uuid()
      // A queued run due in the past.
      const queued = await store.createRun({
        id: uuid(),
        org_id: ORG,
        agent_id: agentId,
        reason: "manual:u1",
        // First-class wallet key, round-tripped — never parsed out of `reason`.
        initiated_by: "u1",
        scheduled_for: "2000-01-01T00:00:00.000Z",
      })
      expect(queued.status).toBe("queued")
      expect(queued.initiated_by).toBe("u1")
      // getRun round-trips it; a clock run (no initiator) stays null; unknown id is null.
      expect((await store.getRun(queued.id))?.initiated_by).toBe("u1")
      expect(await store.getRun(uuid())).toBeNull()
      // A future run is NOT due yet — and a clock run carries no initiator.
      const clockRun = await store.createRun({
        id: uuid(),
        org_id: ORG,
        agent_id: agentId,
        reason: "schedule",
        scheduled_for: "2999-01-01T00:00:00.000Z",
      })
      expect(clockRun.initiated_by).toBeNull()

      const now = "2100-01-01T00:00:00.000Z"
      const claimed = await store.claimDueRuns(agentId, now)
      expect(claimed).toHaveLength(1)
      expect(claimed[0]?.id).toBe(queued.id)
      expect(claimed[0]?.status).toBe("running")
      // Claimed once: a second claim finds no queued-due run.
      expect(await store.claimDueRuns(agentId, now)).toHaveLength(0)
      // A different agent never claims this agent's run.
      expect(await store.claimDueRuns(uuid(), now)).toHaveLength(0)

      const done = await store.finishRun(queued.id, agentId, {
        status: "succeeded",
        finishedAt: now,
        costMicroUsd: 1200,
        meta: JSON.stringify({ outcome: "published" }),
      })
      expect(done?.status).toBe("succeeded")
      expect(done?.cost_micro_usd).toBe(1200)
      // The wrong agent can't finish it.
      const wrong = await store.finishRun(queued.id, uuid(), {
        status: "failed",
        finishedAt: now,
      })
      expect(wrong).toBeNull()
    })

    it("listRuns is the ledger: workspace-scoped", async () => {
      const agentId = uuid()
      await store.createRun({
        id: uuid(),
        org_id: ORG,
        agent_id: agentId,
        reason: "ask",
        status: "succeeded",
      })
      await store.createRun({
        id: uuid(),
        org_id: `org_${uuid()}`,
        agent_id: agentId,
        reason: "ask",
        status: "succeeded",
      })
      const runs = await store.listRuns(ORG, 50)
      expect(runs.every((r) => r.org_id === ORG)).toBe(true)
      expect(runs.length).toBeGreaterThan(0)
    })

    it("finishRun is a strict running → terminal transition (guards the ledger)", async () => {
      const agentId = uuid()
      // A queued (never-claimed) run can't be finished — no clobbering the queue.
      const queued = await store.createRun({
        id: uuid(),
        org_id: ORG,
        agent_id: agentId,
        reason: "manual:u1",
        scheduled_for: "2000-01-01T00:00:00.000Z",
      })
      const early = await store.finishRun(queued.id, agentId, {
        status: "succeeded",
        finishedAt: "2100-01-01T00:00:00.000Z",
      })
      expect(early).toBeNull()
      // Claim it (→ running), finish it once, then a duplicate finish is a no-op.
      const now = "2100-01-01T00:00:00.000Z"
      await store.claimDueRuns(agentId, now)
      const first = await store.finishRun(queued.id, agentId, {
        status: "succeeded",
        finishedAt: now,
        costMicroUsd: 500,
      })
      expect(first?.status).toBe("succeeded")
      const dup = await store.finishRun(queued.id, agentId, {
        status: "failed",
        finishedAt: now,
        costMicroUsd: 0,
      })
      expect(dup).toBeNull()
    })

    it("run cost ACCUMULATES across attempts and never nulls out a banked total", async () => {
      // A retry reuses the SAME run row, so cost has to add rather than replace. Replacing meant
      // a run that burned an expensive failed attempt and then settled cheaply reported only the
      // cheap number — undercounting exactly the runs that cost the most, in the column the
      // monthly budget sums. Driver-level because both adapters implement it and must agree.
      const agentId = uuid()
      const r = await store.createRun({
        id: uuid(),
        org_id: ORG,
        agent_id: agentId,
        reason: "manual:u1",
        scheduled_for: "2000-01-01T00:00:00.000Z",
      })
      await store.claimDueRuns(agentId, "2100-01-01T00:00:00.000Z")

      // Attempt 1 fails retryably having spent 900k; the requeue banks it. Scheduled in the past
      // so the next claim picks it straight back up (the API path uses a real 60s backoff).
      const requeued = await store.requeueRun(r.id, agentId, {
        scheduledFor: "2000-01-01T00:00:00.000Z",
        costMicroUsd: 900_000,
      })
      expect(requeued?.status).toBe("queued")
      expect(requeued?.cost_micro_usd).toBe(900_000)

      // Attempt 2 settles having spent 100k. The run cost 1,000,000, not 100,000.
      await store.claimDueRuns(agentId, "2100-01-01T00:00:00.000Z")
      const settled = await store.finishRun(r.id, agentId, {
        status: "succeeded",
        finishedAt: "2100-01-01T00:00:00.000Z",
        costMicroUsd: 100_000,
      })
      expect(settled?.cost_micro_usd).toBe(1_000_000)

      // A provider that reports NOTHING (Codex plain-text, an older CLI) must read as unknown and
      // leave the banked total alone. An unconditional `cost = value ?? null` write erased it.
      const r2 = await store.createRun({
        id: uuid(),
        org_id: ORG,
        agent_id: agentId,
        reason: "manual:u1",
        scheduled_for: "2000-01-01T00:00:00.000Z",
      })
      await store.claimDueRuns(agentId, "2100-01-01T00:00:00.000Z")
      await store.requeueRun(r2.id, agentId, {
        scheduledFor: "2000-01-01T00:00:00.000Z",
        costMicroUsd: 500_000,
      })
      await store.claimDueRuns(agentId, "2100-01-01T00:00:00.000Z")
      const quiet = await store.finishRun(r2.id, agentId, {
        status: "succeeded",
        finishedAt: "2100-01-01T00:00:00.000Z",
      })
      expect(quiet?.cost_micro_usd).toBe(500_000)
    })

    it("deleteAutomation cancels its queued runs and is org-scoped", async () => {
      const agentId = uuid()
      const a = await store.createAutomation({
        id: uuid(),
        org_id: ORG,
        agent_id: agentId,
        trigger: JSON.stringify({ kind: "manual" }),
        instruction: "keep current",
      })
      const pending = await store.createRun({
        id: uuid(),
        org_id: ORG,
        agent_id: agentId,
        automation_id: a.id,
        reason: "manual:u1",
        scheduled_for: "2000-01-01T00:00:00.000Z",
      })
      // Wrong org can't delete it (still there after).
      await store.deleteAutomation(a.id, `org_${uuid()}`)
      expect(await store.getAutomation(a.id)).not.toBeNull()
      // Correct org: the automation and its queued run are both gone.
      await store.deleteAutomation(a.id, ORG)
      expect(await store.getAutomation(a.id)).toBeNull()
      expect(await store.claimDueRuns(agentId, "2100-01-01T00:00:00.000Z")).not.toContainEqual(
        expect.objectContaining({ id: pending.id }),
      )
    })
  })

  describe(`${label}: standalone image assets (POST /v1/assets -> GET /blob/:hash)`, () => {
    it("stages an asset, reads it back by hash, and is idempotent on re-upload", async () => {
      const hash = uuid().replace(/-/g, "").padEnd(64, "0")
      const created = await store.createAsset({
        hash,
        org_id: ORG,
        content_type: "image/png",
        size_bytes: 1234,
      })
      expect(created).toMatchObject({
        hash,
        org_id: ORG,
        content_type: "image/png",
        size_bytes: 1234,
      })
      expect(await store.getAsset(hash)).toMatchObject({ hash, content_type: "image/png" })

      // Re-uploading the exact same bytes (same hash) is a no-op, not a duplicate
      // or an error — it just returns the existing row unchanged.
      const again = await store.createAsset({
        hash,
        org_id: ORG,
        content_type: "image/png",
        size_bytes: 1234,
      })
      expect(again).toMatchObject({ hash, org_id: ORG, size_bytes: 1234 })
    })

    it("returns null for a hash that was never staged", async () => {
      expect(await store.getAsset(uuid().replace(/-/g, "").padEnd(64, "0"))).toBeNull()
    })

    it("sums an org's staged assets, scoped away from another org's", async () => {
      const otherOrg = `org_${uuid()}`
      const h1 = uuid().replace(/-/g, "").padEnd(64, "1")
      const h2 = uuid().replace(/-/g, "").padEnd(64, "2")
      const hOther = uuid().replace(/-/g, "").padEnd(64, "3")
      await store.createAsset({ hash: h1, org_id: ORG, content_type: "image/png", size_bytes: 100 })
      await store.createAsset({
        hash: h2,
        org_id: ORG,
        content_type: "image/jpeg",
        size_bytes: 250,
      })
      await store.createAsset({
        hash: hOther,
        org_id: otherOrg,
        content_type: "image/png",
        size_bytes: 999,
      })

      expect(await store.assetStorageBytes(ORG)).toBeGreaterThanOrEqual(350)
      const otherTotal = await store.assetStorageBytes(otherOrg)
      expect(otherTotal).toBe(999)
    })
  })

  describe(`${label}: signup attribution`, () => {
    it("records the signup source once per user (first write wins) and reads it back", async () => {
      const userId = `u_${uuid()}`
      await store.recordSignupAttribution({
        id: uuid(),
        user_id: userId,
        source_kind: "badge",
        source_artifact: "ab12cd34",
        landing_path: "/artifacts/doc-ab12cd34",
        referrer: "news.ycombinator.com",
      })
      // A duplicate hook fire (retry, double submit) must not add a second row or
      // overwrite the first — the attribution of record is the one at signup time.
      await store.recordSignupAttribution({
        id: uuid(),
        user_id: userId,
        source_kind: "comment_wall",
        source_artifact: null,
        landing_path: null,
        referrer: null,
      })

      const rec = await store.getSignupAttribution(userId)
      expect(rec).toMatchObject({
        user_id: userId,
        source_kind: "badge",
        source_artifact: "ab12cd34",
        landing_path: "/artifacts/doc-ab12cd34",
        referrer: "news.ycombinator.com",
      })
      expect(rec?.created_at).toBeTruthy()
    })

    it("returns null for a user with no recorded source (organic signup)", async () => {
      expect(await store.getSignupAttribution(`u_${uuid()}`)).toBeNull()
    })

    it("stores nullable fields as null (a campaign link with no artifact)", async () => {
      const userId = `u_${uuid()}`
      await store.recordSignupAttribution({
        id: uuid(),
        user_id: userId,
        source_kind: "hn-launch",
        source_artifact: null,
        landing_path: "/",
        referrer: null,
      })
      const rec = await store.getSignupAttribution(userId)
      expect(rec?.source_kind).toBe("hn-launch")
      expect(rec?.source_artifact).toBeNull()
      expect(rec?.referrer).toBeNull()
    })
  })

  // The hosted-execution surface: the `run` table used as a queue of record. Every method here
  // is one step of the same loop — a tick lists what is due, an executor claims exactly one item,
  // a dead executor's work returns to the queue — and each one's safety IS its WHERE clause. A
  // claim that forgot its status guard hands the same run to two substrates, which double-writes
  // an artifact; a lease check that read `>` instead of `<` wedges the queue forever. Guards are
  // exactly the thing that can drift between the SQLite and Postgres drivers while both still
  // typecheck, so they belong here, in the contract both dialects must satisfy.
  //
  // The queue scans (listDueQueuedRuns, listEnabledAutomations, listDueOpenSessions) are global
  // by design — a dispatch tick serves every workspace — so these assert on membership of a
  // known id, never on a total, and the reclaim sweep uses ancient timestamps to fence itself
  // off from rows the rest of this file leaves lying around.
  describe(`${label}: hosted dispatch (runs, automations, sessions)`, () => {
    // Agent names are unique per workspace, and this whole block shares one ORG.
    const newAgent = () =>
      store.createAgent({
        id: uuid(),
        org_id: ORG,
        name: `runner_${uuid().slice(0, 8)}`,
        token: `tok_${uuid()}`,
        role: "editor",
      })

    const newAutomation = (agentId: string, enabled: 0 | 1 = 1) =>
      store.createAutomation({
        id: uuid(),
        org_id: ORG,
        agent_id: agentId,
        trigger: JSON.stringify({ kind: "schedule", cron: "*/5 * * * *" }),
        instruction: "refresh the weekly numbers",
        enabled,
      })

    const newRun = (agentId: string, over: Partial<NewRun> = {}) =>
      store.createRun({ id: uuid(), org_id: ORG, agent_id: agentId, reason: "schedule", ...over })

    // A session hangs off a CONTEXT, and the context names the acting agent — so a session's
    // ownership is only resolvable through it. These bind a known agent id to make that explicit.
    const newBoundContext = async (agentId: string) => {
      const manifest = await store.createArtifact(newArtifact({ kind: "bundle" }))
      return store.createContext({
        id: uuid(),
        org_id: ORG,
        name: `qa_${uuid().slice(0, 8)}`,
        agent_id: agentId,
        manifest_artifact_id: manifest.id,
        created_by: "rob",
      })
    }

    const sessionOn = (contextId: string) =>
      store.createSession({
        id: uuid(),
        context_id: contextId,
        org_id: ORG,
        asker_id: "daniel",
        context_version: 1,
      })

    it("lists enabled automations only — a paused one stops costing money", async () => {
      const ag = await newAgent()
      const on = await newAutomation(ag.id, 1)
      const off = await newAutomation(ag.id, 0)
      const ids = (await store.listEnabledAutomations(500)).map((a) => a.id)
      expect(ids).toContain(on.id)
      expect(ids).not.toContain(off.id)
    })

    it("lists queued runs that are due now, excluding future and already-claimed work", async () => {
      const ag = await newAgent()
      const now = new Date().toISOString()
      const asap = await newRun(ag.id, { scheduled_for: null })
      const due = await newRun(ag.id, {
        scheduled_for: new Date(Date.now() - 60_000).toISOString(),
      })
      const later = await newRun(ag.id, {
        scheduled_for: new Date(Date.now() + 3_600_000).toISOString(),
      })
      const claimed = await newRun(ag.id, { status: "running", started_at: now })
      const ids = (await store.listDueQueuedRuns(now, 500)).map((r) => r.id)
      // A null schedule means "as soon as possible", not "never".
      expect(ids).toEqual(expect.arrayContaining([asap.id, due.id]))
      expect(ids).not.toContain(later.id)
      expect(ids).not.toContain(claimed.id)
    })

    it("claims a run exactly once, and only for the agent it belongs to", async () => {
      const ag = await newAgent()
      const stranger = await newAgent()
      const r = await newRun(ag.id)
      const now = new Date().toISOString()
      expect(await store.claimRunById(r.id, stranger.id, now)).toBeNull()
      expect(await store.claimRunById(r.id, ag.id, now)).toMatchObject({
        id: r.id,
        status: "running",
        started_at: now,
      })
      // The whole point of the status guard: a second substrate booted on the same run updates
      // zero rows and learns it lost, instead of writing the artifact a second time.
      expect(await store.claimRunById(r.id, ag.id, now)).toBeNull()
    })

    it("requeues a claimed run for a later attempt, and refuses one that is not running", async () => {
      const ag = await newAgent()
      const r = await newRun(ag.id)
      const now = new Date().toISOString()
      // Still queued: a late or duplicate retry request must not resurrect a settled run.
      expect(await store.requeueRun(r.id, ag.id, { scheduledFor: now })).toBeNull()
      await store.claimRunById(r.id, ag.id, now)
      const at = new Date(Date.now() + 60_000).toISOString()
      const back = await store.requeueRun(r.id, ag.id, {
        scheduledFor: at,
        meta: JSON.stringify({ attempts: 1 }),
      })
      expect(back).toMatchObject({ status: "queued", started_at: null, scheduled_for: at })
      expect(JSON.parse(back?.meta ?? "{}")).toMatchObject({ attempts: 1 })
    })

    it("reclaims a dead executor's runs, counting attempts and giving up past the cap", async () => {
      const ag = await newAgent()
      // Timestamps far in the past so this sweep's global scan sees only these two rows.
      const ancient = "2000-01-01T00:00:00.000Z"
      const cutoff = "2000-01-02T00:00:00.000Z"
      const retried = await newRun(ag.id, { status: "running", started_at: ancient })
      const doomed = await newRun(ag.id, {
        status: "running",
        started_at: ancient,
        meta: JSON.stringify({ attempts: 2, outcome: "published" }),
      })
      expect(await store.reclaimStaleRuns(cutoff, 3)).toEqual({ requeued: 1, failed: 1 })

      const back = await store.getRun(retried.id)
      expect(back).toMatchObject({ status: "queued", started_at: null })
      expect(JSON.parse(back?.meta ?? "{}")).toMatchObject({ attempts: 1 })
      // Past the cap it is given up as `lost` — and the merge keeps the prior attempt's record
      // rather than replacing the blob, so the history survives the retry.
      const dead = await store.getRun(doomed.id)
      expect(dead).toMatchObject({ status: "failed", finished_at: cutoff })
      expect(JSON.parse(dead?.meta ?? "{}")).toMatchObject({ attempts: 3, outcome: "lost" })
    })

    it("resolves an automation's most recent run by schedule time", async () => {
      const ag = await newAgent()
      const auto = await newAutomation(ag.id)
      await newRun(ag.id, {
        automation_id: auto.id,
        scheduled_for: "2026-01-01T00:00:00.000Z",
        status: "succeeded",
      })
      const newest = await newRun(ag.id, {
        automation_id: auto.id,
        scheduled_for: "2026-06-01T00:00:00.000Z",
        status: "succeeded",
      })
      expect(await store.latestRunForAutomation(auto.id)).toMatchObject({ id: newest.id })
      expect(await store.latestRunForAutomation(uuid())).toBeNull()

      // Narrowed by reason, which is what the schedule tick reads. Every kind of firing
      // stamps a scheduled_for — a manual run stamps now, a retry stamps now+backoff, which
      // is in the FUTURE — so an unscoped read lets one of them masquerade as "this cron
      // window is already materialized" and silently swallow the occurrence. This run is the
      // newest of all, and must NOT be what the tick sees.
      const manual = await newRun(ag.id, {
        automation_id: auto.id,
        reason: "manual:u_someone",
        scheduled_for: "2027-01-01T00:00:00.000Z",
      })
      expect(await store.latestRunForAutomation(auto.id)).toMatchObject({ id: manual.id })
      expect(await store.latestRunForAutomation(auto.id, "schedule")).toMatchObject({
        id: newest.id,
      })
    })

    it("coalesces an event onto a pending run only inside the debounce window", async () => {
      const ag = await newAgent()
      const auto = await newAutomation(ag.id)
      const soon = new Date(Date.now() + 30_000).toISOString()
      const pending = await newRun(ag.id, { automation_id: auto.id, scheduled_for: soon })
      expect(await store.findCoalescibleRun(auto.id, soon)).toMatchObject({ id: pending.id })
      // Scheduled beyond the window: there is nothing to join, so the caller enqueues afresh.
      const before = new Date(Date.now() - 60_000).toISOString()
      expect(await store.findCoalescibleRun(auto.id, before)).toBeNull()
    })

    it("appends event payloads to a queued run, and refuses once it is claimed", async () => {
      const ag = await newAgent()
      const r = await newRun(ag.id, { meta: JSON.stringify({ payloads: [] }) })
      const one = await store.appendRunPayload(r.id, { ping: 1 }, 10_000)
      expect(JSON.parse(one?.meta ?? "{}").payloads).toEqual([{ ping: 1 }])
      expect(
        JSON.parse((await store.appendRunPayload(r.id, { ping: 2 }, 10_000))?.meta ?? "{}"),
      ).toMatchObject({ payloads: [{ ping: 1 }, { ping: 2 }] })
      // Over budget the payload is dropped whole — a truncated JSON blob is worse than a
      // missing one, and the caller's fallback (enqueue a fresh run) loses nothing.
      expect(await store.appendRunPayload(r.id, { big: "x".repeat(500) }, 200)).toBeNull()
      // Claimed: it is already executing, so there is no pending run left to join.
      await store.claimRunById(r.id, ag.id, new Date().toISOString())
      expect(await store.appendRunPayload(r.id, { ping: 3 }, 10_000)).toBeNull()

      // No meta at all, and unparseable meta, are both "nothing to append to".
      const bare = await newRun(ag.id)
      expect(await store.appendRunPayload(bare.id, { ping: 1 }, 10_000)).toBeNull()
      const broken = await newRun(ag.id, { meta: "{not json" })
      expect(await store.appendRunPayload(broken.id, { ping: 1 }, 10_000)).toBeNull()
      expect(await store.appendRunPayload(uuid(), { ping: 1 }, 10_000)).toBeNull()
    })

    it("resolves an agent by id (the capability token's subject)", async () => {
      const ag = await newAgent()
      expect(await store.getAgent(ag.id)).toMatchObject({ id: ag.id, name: ag.name })
      expect(await store.getAgent(uuid())).toBeNull()
    })

    it("hands out a runnable session once, and withholds one under a live lease", async () => {
      const agentId = uuid()
      const ctx = await newBoundContext(agentId)
      const s = await sessionOn(ctx.id)
      expect(
        (await store.listDueOpenSessions(new Date().toISOString(), 500)).map((x) => x.id),
      ).toContain(s.id)

      const live = new Date(Date.now() + 600_000).toISOString()
      expect(await store.claimSessionById(s.id, agentId, live)).toMatchObject({ state: "working" })
      // A live lease means a healthy executor holds it: it leaves the runnable set entirely,
      // and a second claim gets nothing.
      expect(
        (await store.listDueOpenSessions(new Date().toISOString(), 500)).map((x) => x.id),
      ).not.toContain(s.id)
      expect(await store.claimSessionById(s.id, agentId, live)).toBeNull()
    })

    it("reclaims a session whose lease lapsed, and never hands one to a foreign agent", async () => {
      const agentId = uuid()
      const ctx = await newBoundContext(agentId)
      const s = await sessionOn(ctx.id)
      const lapsed = new Date(Date.now() - 60_000).toISOString()
      expect(await store.claimSessionById(s.id, agentId, lapsed)).toMatchObject({
        state: "working",
      })
      // The executor died holding it. A lapsed lease must return it to the runnable set, or the
      // ask queue wedges behind a process that no longer exists.
      const now = new Date().toISOString()
      expect((await store.listDueOpenSessions(now, 500)).map((x) => x.id)).toContain(s.id)
      // Ownership is checked through the context that names the agent, never on the session row.
      expect(await store.claimSessionById(s.id, uuid(), now)).toBeNull()
      expect(
        await store.claimSessionById(s.id, agentId, new Date(Date.now() + 600_000).toISOString()),
      ).toMatchObject({ state: "working" })
      expect(await store.claimSessionById(uuid(), agentId, now)).toBeNull()
    })

    it("resolves a plan personal-first, then the workspace pool", async () => {
      const pool = await store.createPlan({
        id: uuid(),
        org_id: ORG,
        user_id: null,
        kind: "model",
        provider: "anthropic",
        secret_enc: "enc_pool",
      })
      expect(await store.resolvePlan(ORG, "u_amy", "model")).toMatchObject({ id: pool.id })
      const mine = await store.createPlan({
        id: uuid(),
        org_id: ORG,
        user_id: "u_amy",
        kind: "model",
        provider: "anthropic",
        secret_enc: "enc_amy",
      })
      // Whoever initiated the run pays for it: their own plan outranks the shared pool.
      expect(await store.resolvePlan(ORG, "u_amy", "model")).toMatchObject({ id: mine.id })
      // A clock-fired run has no person behind it, so it can only reach the pool.
      expect(await store.resolvePlan(ORG, null, "model")).toMatchObject({ id: pool.id })
      // Hands and thinking are billed separately: a model plan never pays for a broker.
      expect(await store.resolvePlan(ORG, "u_amy", "broker")).toBeNull()

      expect(await store.getPlan(mine.id)).toMatchObject({ provider: "anthropic" })
      expect((await store.listPlans(ORG)).map((p) => p.id)).toEqual(
        expect.arrayContaining([pool.id, mine.id]),
      )
      await store.deletePlan(mine.id, ORG)
      expect(await store.getPlan(mine.id)).toBeNull()
      // Detached, the run falls back to the pool rather than failing to resolve.
      expect(await store.resolvePlan(ORG, "u_amy", "model")).toMatchObject({ id: pool.id })
    })

    it("keeps plans inside their workspace — resolve, list, and delete are all org-scoped", async () => {
      // Every assertion above lives in ONE workspace, so all three org filters could be
      // deleted from the driver and the suite would still pass. A plan is a payment
      // credential; "another tenant can spend it" has to be a test, not a code comment.
      const other = `org_plan_${uuid()}`
      const theirs = await store.createPlan({
        id: uuid(),
        org_id: other,
        user_id: "u_amy",
        kind: "model",
        provider: "anthropic",
        secret_enc: "enc_theirs",
      })

      // Same user, same kind, different workspace: must not resolve across the boundary.
      const hereForAmy = await store.resolvePlan(ORG, "u_amy", "model")
      expect(hereForAmy?.id).not.toBe(theirs.id)
      expect((await store.listPlans(ORG)).map((p) => p.id)).not.toContain(theirs.id)

      // A delete naming the wrong workspace must not take effect.
      await store.deletePlan(theirs.id, ORG)
      expect(await store.getPlan(theirs.id)).toMatchObject({ id: theirs.id })
      // …and the rightful workspace can still remove it.
      await store.deletePlan(theirs.id, other)
      expect(await store.getPlan(theirs.id)).toBeNull()
    })
  })
  // OPTIONAL FAST PATH. `workspaceWithMembers` collapses the workspace row, its roster and
  // the directory rows for that roster into one statement. Held to the three reads it
  // replaces, over the same fixtures.
  describe(`${label}: workspaceWithMembers agrees with the three reads it replaces`, () => {
    it("matches the workspace, the roster and the directory", async () => {
      if (!store.workspaceWithMembers) return

      const org = `org_wwm_${uuid()}`
      await store.setWorkspace(org, "Roster")
      const ids = [`u_a_${uuid()}`, `u_b_${uuid()}`, `u_c_${uuid()}`]
      const roles = ["owner", "editor", "viewer"] as const
      for (let i = 0; i < ids.length; i++)
        await store.setMembership({
          id: uuid(),
          org_id: org,
          user_id: ids[i] as string,
          role: roles[i] as (typeof roles)[number],
        })

      const fast = await store.workspaceWithMembers(org)
      const ws = await store.getWorkspace(org)
      const members = await store.listMemberships(org)
      const users = await store.getUsers(members.map((m) => m.user_id))

      expect(fast.workspace).toEqual(ws)
      const byId = (xs: { id: string }[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id))
      expect(byId(fast.members)).toEqual(byId(members))
      expect(byId(fast.users)).toEqual(byId(users))
      // Not vacuously empty: the roster has to have actually come back.
      expect(fast.members.length).toBe(3)
    })

    it("returns a null workspace and an empty roster for an unknown org", async () => {
      if (!store.workspaceWithMembers) return
      const r = await store.workspaceWithMembers(`org_missing_${uuid()}`)
      expect(r.workspace).toBeNull()
      expect(r.members).toEqual([])
      expect(r.users).toEqual([])
    })
  })

  // OPTIONAL FAST PATH. `listPage` collapses the library list AND its decoration into one
  // statement. Two things can go wrong that a "does it return rows" test would miss: the
  // decoration could disagree with `listEnrichment`, and the ORDER could be lost — a UNION
  // ALL does not preserve its arms' order, and the LAST row of the page is what the keyset
  // cursor is built from, so losing it is a pagination bug, not a cosmetic one.
  //
  // So this asserts against the pair it replaces, over the same fixtures, including order.
  describe(`${label}: listPage agrees with listArtifacts + listEnrichment`, () => {
    it("matches rows, order and every decoration arm", async () => {
      if (!store.listPage) return // dialect has no fast path — the pair is the only path

      const org = `org_page_${uuid()}`
      const me = `u_page_${uuid()}`
      await store.setWorkspace(org, "Page")
      await store.setMembership({ id: uuid(), org_id: org, user_id: me, role: "owner" })

      // Enough shape to light up every arm: several artifacts (so order is observable),
      // tags, a favorite, a share, an open proposal and an open comment.
      const made = []
      for (let i = 0; i < 5; i++) {
        const a = newArtifact({ org_id: org, title: `Page ${i}` })
        await store.createArtifact(a)
        made.push(a)
      }
      const [first, second] = made as [(typeof made)[0], (typeof made)[0]]
      await store.setArtifactTags(first.id, ["zeta", "alpha"])
      await store.setFavorite(second.id, me)
      await store.setArtifactMember({
        id: uuid(),
        artifact_id: first.id,
        user_id: me,
        role: "editor",
      })

      const list = { orgId: org, limit: 10, sort: "created" as const }
      const opts = { list, viewerId: me, memberId: me, views: true }

      const fast = await store.listPage(opts)
      const rows = await store.listArtifacts(list)
      const slow = await store.listEnrichment({
        ids: rows.map((r) => r.id),
        ghIds: [...new Set(rows.map((r) => r.author_gh_id).filter((x): x is string => !!x))],
        authorIds: [...new Set(rows.map((r) => r.author_id).filter((x): x is string => !!x))],
        viewerId: me,
        memberId: me,
        views: true,
      })

      // ORDER, not just membership — this is the one the cursor depends on.
      expect(fast.artifacts.map((a) => a.id)).toEqual(rows.map((r) => r.id))
      expect(fast.artifacts).toEqual(rows)
      expect(fast.enrichment.tags).toEqual(slow.tags)
      expect(fast.enrichment.previews).toEqual(slow.previews)
      expect(fast.enrichment.proposals).toEqual(slow.proposals)
      expect(fast.enrichment.views).toEqual(slow.views)
      expect(fast.enrichment.signals).toEqual(slow.signals)
      expect(fast.enrichment.shareRoles).toEqual(slow.shareRoles)
      expect([...fast.enrichment.favorites].sort()).toEqual([...slow.favorites].sort())
      // Not vacuously equal-empty: the fixtures above must actually have lit these up.
      expect(fast.artifacts.length).toBe(5)
      expect(fast.enrichment.tags[first.id]).toEqual(["alpha", "zeta"])
      expect(fast.enrichment.favorites).toEqual([second.id])
      expect(fast.enrichment.shareRoles[first.id]).toBe("editor")
    })

    it("returns an empty page for an empty id narrowing, like the pair does", async () => {
      if (!store.listPage) return
      const opts = { list: { ids: [], limit: 10 }, viewerId: null, memberId: null, views: false }
      const fast = await store.listPage(opts)
      expect(fast.artifacts).toEqual([])
      expect(fast.enrichment.tags).toEqual({})
    })

    it("honors the limit, and keeps the page the list query would have returned", async () => {
      if (!store.listPage) return
      const org = `org_lim_${uuid()}`
      await store.setWorkspace(org, "Lim")
      for (let i = 0; i < 4; i++) await store.createArtifact(newArtifact({ org_id: org }))
      const list = { orgId: org, limit: 2, sort: "created" as const }
      const fast = await store.listPage({ list, viewerId: null, memberId: null, views: false })
      expect(fast.artifacts.map((a) => a.id)).toEqual(
        (await store.listArtifacts(list)).map((r) => r.id),
      )
      expect(fast.artifacts.length).toBe(2)
    })
  })

  // OPTIONAL FAST PATH. `artifactGrants` collapses four reads — membership, artifact share, and
  // both halves of collectionRolesForArtifact — into one statement, and it is an authorization
  // INPUT: a disagreement is not a slow page, it is someone seeing a document they should not,
  // or losing one they own.
  //
  // So rather than assert hand-written expectations, run BOTH paths over the same fixtures and
  // require them to agree. The four-read path is the specification. A store that does not
  // implement the fast path skips this, which is what makes implementing it optional.
  describe(`${label}: artifactGrants agrees with the four reads it replaces`, () => {
    it("matches for a stranger, a member, a sharee, and both kinds of collection share", async () => {
      if (!store.artifactGrants) return // dialect has no fast path — the fallback is the only path

      const org = `org_grants_${uuid()}`
      const other = `org_other_${uuid()}`
      await store.setWorkspace(org, "Grants")
      await store.setWorkspace(other, "Other")
      const art = newArtifact({ org_id: org, workspace_access: "member", link_role: "none" })
      await store.createArtifact(art)

      const [owner, member, sharee, collab, stranger] = [
        `u_own_${uuid()}`,
        `u_mem_${uuid()}`,
        `u_shr_${uuid()}`,
        `u_col_${uuid()}`,
        `u_str_${uuid()}`,
      ]
      for (const [u, role] of [
        [owner, "owner"],
        [member, "editor"],
        [collab, "viewer"],
      ] as const)
        await store.setMembership({ id: uuid(), org_id: org, user_id: u, role })
      // An explicit share held by a NON-member: artifact role present, org role must stay null.
      await store.setArtifactMember({
        id: uuid(),
        artifact_id: art.id,
        user_id: sharee,
        role: "commenter",
      })
      // TWO collections holding the same artifact — one shared explicitly, one open to the
      // workspace so members inherit their SEAT role. Several collections is precisely where a
      // join would multiply the membership row.
      const explicitCol = uuid()
      const openCol = uuid()
      await store.createCollection({
        id: explicitCol,
        org_id: org,
        title: "Explicit",
        created_by: owner,
        workspace_access: "none",
      })
      await store.createCollection({
        id: openCol,
        org_id: org,
        title: "Open",
        created_by: owner,
        workspace_access: "member",
      })
      await store.addCollectionItem(explicitCol, art.id)
      await store.addCollectionItem(openCol, art.id)
      await store.setCollectionMember({
        id: uuid(),
        collection_id: explicitCol,
        user_id: collab,
        role: "editor",
      })

      const slow = async (orgId: string, userId: string) => {
        const orgRole = (await store.getMembership(orgId, userId))?.role ?? null
        const am = await store.getArtifactMember(art.id, userId)
        const cRoles = await store.collectionRolesForArtifact(art.id, userId)
        return { orgRole, artifactRole: maxRole(am?.role ?? null, ...cRoles) }
      }
      const fast = async (orgId: string, userId: string) => {
        const g = await store.artifactGrants?.(art.id, orgId, userId)
        if (!g) throw new Error("artifactGrants vanished mid-test")
        return { orgRole: g.orgRole, artifactRole: maxRole(null, ...g.artifactRoles) }
      }

      // The THIRD path: the same grants, resolved by SHORT ID alongside the artifact row,
      // so the document open pays one round trip instead of two. It answers the identical
      // question, so it is held to the identical answer.
      const combined = async (userId: string) => {
        const r = await store.artifactWithGrants?.(art.short_id, userId)
        if (!r) throw new Error("artifactWithGrants found no artifact")
        return { orgRole: r.orgRole, artifactRole: maxRole(null, ...r.artifactRoles) }
      }

      for (const u of [owner, member, sharee, collab, stranger]) {
        expect(await fast(org, u), `grants disagree for ${u}`).toEqual(await slow(org, u))
        if (store.artifactWithGrants)
          expect(await combined(u), `artifactWithGrants disagrees for ${u}`).toEqual(
            await slow(org, u),
          )
      }

      // The org arm must key on the org PASSED IN, not on the artifact's own workspace.
      for (const u of [owner, stranger]) expect(await fast(other, u)).toEqual(await slow(other, u))

      // An unknown short id is null, not a throw and not an empty-grants object — the
      // route distinguishes "no such document" (404) from "no standing on it".
      if (store.artifactWithGrants)
        expect(await store.artifactWithGrants(`sid_missing_${uuid()}`, owner)).toBeNull()
    })
  })
  // CHAOS: the same question, asked both ways, over randomly-shaped access graphs.
  //
  // The curated case above covers the shapes I thought of. This covers the ones I did not: a
  // seeded random walk over memberships, per-artifact shares, open and closed collections, and
  // artifacts that sit in several collections at once — the arrangement where a join would
  // multiply rows and the two paths would quietly disagree.
  //
  // Seeded so a failure reproduces: the seed is printed with the mismatch.
  describe(`${label}: artifactGrants survives randomised access graphs`, () => {
    it("agrees with the four reads across 40 random configurations", async () => {
      if (!store.artifactGrants) return

      // xorshift32 — small, deterministic, and dependency-free.
      let seed = 0x9e3779b9
      const rnd = () => {
        seed ^= seed << 13
        seed ^= seed >>> 17
        seed ^= seed << 5
        return Math.abs(seed) / 2 ** 31
      }
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
      const ROLES = ["owner", "admin", "editor", "commenter", "viewer"] as const

      for (let round = 0; round < 40; round++) {
        const startSeed = seed
        const org = `org_fz_${uuid()}`
        await store.setWorkspace(org, "Fuzz")
        const art = newArtifact({
          org_id: org,
          workspace_access: pick(["member", "none"]),
          link_role: pick(["none", "viewer"]),
        })
        await store.createArtifact(art)

        const users = Array.from({ length: 4 }, () => `u_fz_${uuid()}`)
        for (const u of users) {
          // Each user independently may hold: a seat, a direct share, and membership of
          // collections that may or may not contain the artifact.
          if (rnd() < 0.6)
            await store.setMembership({ id: uuid(), org_id: org, user_id: u, role: pick(ROLES) })
          if (rnd() < 0.4)
            await store.setArtifactMember({
              id: uuid(),
              artifact_id: art.id,
              user_id: u,
              role: pick(ROLES),
            })
        }
        // Between zero and three collections, each independently workspace-open or not, each
        // independently holding the artifact, each with a random subset of members.
        const collections = Math.floor(rnd() * 4)
        for (let ci = 0; ci < collections; ci++) {
          const col = uuid()
          await store.createCollection({
            id: col,
            org_id: org,
            title: `C${ci}`,
            created_by: users[0] as string,
            workspace_access: rnd() < 0.5 ? "member" : "none",
          })
          if (rnd() < 0.75) await store.addCollectionItem(col, art.id)
          for (const u of users)
            if (rnd() < 0.35)
              await store.setCollectionMember({
                id: uuid(),
                collection_id: col,
                user_id: u,
                role: pick(ROLES),
              })
        }

        for (const u of users) {
          const orgRole = (await store.getMembership(org, u))?.role ?? null
          const am = await store.getArtifactMember(art.id, u)
          const cRoles = await store.collectionRolesForArtifact(art.id, u)
          const slow = { orgRole, artifactRole: maxRole(am?.role ?? null, ...cRoles) }
          const g = await store.artifactGrants?.(art.id, org, u)
          const fast = {
            orgRole: g?.orgRole ?? null,
            artifactRole: maxRole(null, ...(g?.artifactRoles ?? [])),
          }
          expect(fast, `round ${round} (seed ${startSeed}) disagreed for ${u}`).toEqual(slow)
        }
      }
    })
  })
  describe(`${label}: connection credentials`, () => {
    // The one mutation the connection table never had. It exists for OAuth — the row is created
    // `pending` before the redirect and completed on callback — and for every refresh after that.
    const mkConn = async (over: Record<string, unknown> = {}) =>
      store.createConnection({
        id: `conn_${uuid().slice(0, 8)}`,
        org_id: ORG,
        user_id: "u1",
        scope: "personal",
        kind: "mcp",
        broker: "mcp",
        toolkit: "stripe",
        broker_ref: "mcp::https://mcp.stripe.com",
        secret_enc: "v1.old",
        status: "pending",
        ...over,
      } as never)

    it("writes the credential, the ref and the status together", async () => {
      const cn = await mkConn()
      const out = await store.updateConnectionCredential(cn.id, ORG, {
        secret_enc: "v1.new",
        broker_ref: "mcp:s256-abc:https://mcp.stripe.com",
        status: "active",
        scopes_label: "oauth",
      })
      expect(out?.secret_enc).toBe("v1.new")
      expect(out?.broker_ref).toBe("mcp:s256-abc:https://mcp.stripe.com")
      expect(out?.status).toBe("active")
      expect(out?.scopes_label).toBe("oauth")
    })

    it("is org-scoped — another workspace cannot rewrite the credential", async () => {
      const cn = await mkConn()
      expect(
        await store.updateConnectionCredential(cn.id, `org_${uuid()}`, { secret_enc: "v1.x" }),
      ).toBeNull()
      expect((await store.getConnection(cn.id))?.secret_enc).toBe("v1.old")
    })

    it("COMPARE-AND-SWAP: a stale refresh cannot overwrite a newer token", async () => {
      // Two runs hit an expired access token in the same second. Both refresh. The slower reply
      // must not put its older token back over the newer one and invalidate a working grant.
      const cn = await mkConn()
      const fast = await store.updateConnectionCredential(
        cn.id,
        ORG,
        { secret_enc: "v1.fresh" },
        "v1.old",
      )
      expect(fast?.secret_enc).toBe("v1.fresh")
      const slow = await store.updateConnectionCredential(
        cn.id,
        ORG,
        { secret_enc: "v1.stale" },
        "v1.old", // what the slow caller READ before it refreshed
      )
      expect(slow, "the stale write is refused, not applied").toBeNull()
      expect((await store.getConnection(cn.id))?.secret_enc).toBe("v1.fresh")
    })

    it("the swap guard matches a NULL credential too, so a first write is safe", async () => {
      const cn = await mkConn({ secret_enc: null })
      expect(
        (await store.updateConnectionCredential(cn.id, ORG, { secret_enc: "v1.first" }, null))
          ?.secret_enc,
      ).toBe("v1.first")
      // And a second caller expecting null now loses.
      expect(
        await store.updateConnectionCredential(cn.id, ORG, { secret_enc: "v1.second" }, null),
      ).toBeNull()
    })

    // A MISS SHARES THE LINK TABLE, and must never escape as a link.
    //
    // Eleven call sites treat a non-null result from getSlackUserLinkBySlackId as a real Derive
    // user — one of them DMs `user_id` directly, which on a miss is the empty string. The filter
    // therefore belongs in the STORE, and it belongs in this contract suite so all three dialects
    // prove it rather than one.
    describe("slack identity: links vs misses", () => {
      const linkRow = (over: Record<string, unknown> = {}) => ({
        id: `sul-${Math.abs(Date.now() % 100000)}-${String(over.slack_user_id ?? "U1")}`,
        org_id: ORG,
        user_id: "u-1",
        team_id: "T1",
        slack_user_id: "U1",
        origin: "oauth" as const,
        created_at: new Date().toISOString(),
        checked_at: new Date().toISOString(),
        ...over,
      })

      it("hands back a real link", async () => {
        await store.setSlackUserLink(linkRow({ slack_user_id: "U-real" }))
        expect((await store.getSlackUserLinkBySlackId("T1", "U-real"))?.user_id).toBe("u-1")
        expect((await store.getSlackUserLinkByUser("T1", "u-1"))?.slack_user_id).toBe("U-real")
      })

      it("HIDES a miss from both link accessors", async () => {
        await store.setSlackUserLink(
          linkRow({ slack_user_id: "U-miss", user_id: "", origin: "miss" as const }),
        )
        expect(await store.getSlackUserLinkBySlackId("T1", "U-miss")).toBeNull()
        expect(await store.getSlackUserLinkByUser("T1", "")).toBeNull()
      })

      it("shows the miss to the accessor that asks for it, with checked_at", async () => {
        const at = new Date(Date.now() - 60_000).toISOString()
        await store.setSlackUserLink(
          linkRow({
            slack_user_id: "U-seen",
            user_id: "",
            origin: "miss" as const,
            checked_at: at,
          }),
        )
        const state = await store.getSlackIdentityState("T1", "U-seen")
        expect(state?.origin).toBe("miss")
        expect(state?.checked_at).toBe(at)
      })

      it("a later success REPLACES the miss on the same row — self-healing", async () => {
        await store.setSlackUserLink(
          linkRow({ slack_user_id: "U-fix", user_id: "", origin: "miss" as const }),
        )
        expect(await store.getSlackUserLinkBySlackId("T1", "U-fix")).toBeNull()
        await store.setSlackUserLink(
          linkRow({ slack_user_id: "U-fix", user_id: "u-9", origin: "email" as const }),
        )
        // No cleanup job: the upsert on (team_id, slack_user_id) did it.
        expect((await store.getSlackUserLinkBySlackId("T1", "U-fix"))?.user_id).toBe("u-9")
        expect((await store.getSlackIdentityState("T1", "U-fix"))?.origin).toBe("email")
      })

      it("refreshes checked_at on re-miss while PRESERVING created_at", async () => {
        // created_at is first-seen and the upsert strips it; checked_at is what ages a miss out,
        // so it has to move or a miss could never be retried a second time.
        const old = new Date(Date.now() - 5 * 60_000).toISOString()
        await store.setSlackUserLink(
          linkRow({
            slack_user_id: "U-age",
            user_id: "",
            origin: "miss" as const,
            created_at: old,
            checked_at: old,
          }),
        )
        const now = new Date().toISOString()
        await store.setSlackUserLink(
          linkRow({
            slack_user_id: "U-age",
            user_id: "",
            origin: "miss" as const,
            created_at: now,
            checked_at: now,
          }),
        )
        const state = await store.getSlackIdentityState("T1", "U-age")
        expect(state?.created_at).toBe(old)
        expect(state?.checked_at).toBe(now)
      })
    })
  })
}
