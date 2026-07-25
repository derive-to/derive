import { randomUUID as uuid } from "node:crypto"
import type { MetaStore, NewArtifact, NewVersion, SortMode } from "@derive/core"
import { DEFAULT_ORG_SETTINGS } from "@derive/core"
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
    const tick = () => new Promise((r) => setTimeout(r, 2))

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
      await store.addVersion(a.id, newVersion())
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
      expect(await store.listComments(a.id)).toHaveLength(0)
      expect(await store.getArtifactMember(a.id, "bob")).toBeNull()
      expect(await store.listUserFavoriteIds("amy")).not.toContain(a.id)
      expect(await store.artifactIdsByTag("del-tag")).not.toContain(a.id)
      // The Slack thread link is thread-keyed, not artifact_id-obvious — regression guard
      // that it's cleaned too (it was orphaned before).
      expect(await store.getSlackThreadLinkByThread(thread)).toBeNull()
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
      expect(await store.getSlackThreadLinkByThread(dead)).toBeNull()
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
        slackPost: false,
      })
      expect(await store.getOrgSettings(settingsOrg)).toMatchObject({
        emailNotifications: true,
        githubPostComments: false,
        githubMirrorComments: true,
        slackPost: false,
      })
      // Second write for the same org exercises the onConflict update path.
      await store.setOrgSettings(settingsOrg, {
        ...DEFAULT_ORG_SETTINGS,
        emailNotifications: false,
      })
      expect(await store.getOrgSettings(settingsOrg)).toMatchObject({
        emailNotifications: false,
        githubPostComments: true,
        slackPost: true,
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
        default_channel: "C1",
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
        default_channel: "C2",
        created_at: "2026-06-21T00:00:00.000Z",
      })
      expect(await store.getSlackInstall(ORG)).toMatchObject({
        team_name: "Acme Inc",
        bot_token: "xoxb-2",
        default_channel: "C2",
      })
      await store.deleteSlackInstall(ORG)
      expect(await store.getSlackInstall(ORG)).toBeNull()
    })

    it("links a Slack thread to an artifact, found by thread id or by channel+ts", async () => {
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
      expect(await store.getSlackThreadLinkByThread(link.thread_id)).toMatchObject({
        artifact_id: a.id,
        channel: "C9",
        message_ts: "1700000000.000100",
      })
      expect(await store.getSlackThreadLinkByTs("C9", "1700000000.000100")).toMatchObject({
        thread_id: link.thread_id,
      })
      // Misses return null on both lookups.
      expect(await store.getSlackThreadLinkByThread(`missing_${uuid()}`)).toBeNull()
      expect(await store.getSlackThreadLinkByTs("C9", "nope")).toBeNull()
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
  })

  describe(`${label}: automations + runs (WP5/WP6)`, () => {
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
}
