import {
  type Action,
  type CollectionInviteRecord,
  type CollectionRecord,
  isRole,
  newId,
  ROLES,
  type Role,
  roleAllows,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import { setCookie } from "hono/cookie"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import {
  activeSince,
  Collection,
  collectionsJson,
  enrich,
  PREVIEW_PER_COLLECTION,
  sourceMaps,
} from "../lib/boot-shapes"
import { BULK_MAX, BulkSummarySchema, bulkArtifactOp } from "../lib/bulk"
import { voteCollections } from "../lib/collection-suggest"
import {
  hashPassword,
  mintToken,
  sha256,
  subjectUnlockCookie,
  unlockToken,
  verifyPassword,
} from "../lib/crypto"
import { buildShareInviteEmail } from "../lib/email"
import { bail, fail, readJson } from "../lib/http"
import {
  emailMismatch409,
  INVITE_TTL_MS,
  inviteJson,
  isLiveInvite,
  looksLikeEmail,
} from "../lib/invite"
import { resolveUserRef } from "../lib/resolve-user"
import { armInviteAdmission } from "../lib/signup-policy"
import { log } from "../log"
import { ArtifactMember, roleEnum } from "../schemas"
import { enqueueChannelDelivery } from "../webhooks"

/** Collections: shareable groups of artifacts. A member's role on a collection
 *  propagates to every artifact inside it (see collectionRolesForArtifact). The
 *  Collection response schema is the single source for the web client's type
 *  (generated from the OpenAPI spec). Member endpoints return the shared ArtifactMember
 *  shape (see ../schemas). */

// The suggestions read's shape: a dozen neighbors is plenty of voting signal at
// interactive latency; six candidates absorb role-gate drops while still resolving in a
// handful of reads; three suggestions is all the picker shows.
const SUGGEST_NEIGHBORS = 12
const SUGGEST_CANDIDATES = 6
const SUGGEST_CAP = 3

const CollectionSuggestion = z
  .object({
    id: z.string().describe("The suggested collection's id."),
    score: z
      .number()
      .describe("Summed neighbor-similarity votes — an ordering signal, not a probability."),
  })
  .openapi("CollectionSuggestion")

export const collectionRoutes = (ctx: AppContext) => {
  const {
    meta,
    isMember,
    isToken,
    currentUser,
    requireUser,
    activeWorkspace,
    workspaceCan,
    authorize,
    collectionRole,
    collectionStandingRole,
    limited,
    unlockLimiter,
    actingUser,
    inviteLimiter,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const canManageCollection = async (c: Context, col: CollectionRecord, action: Action) =>
    roleAllows((await collectionStandingRole(c, col)) ?? "viewer", action)
  const rank = (role: Role | null): number => (role ? ROLES.indexOf(role) : -1)
  const CollectionInvite = z.object({
    id: z.string(),
    email: z.string(),
    role: roleEnum,
    created_at: z.string(),
    expires_at: z.string(),
  })
  const CollectionShareResult = z.union([
    z.object({ kind: z.literal("member"), member: ArtifactMember }),
    z.object({
      kind: z.literal("invite"),
      invite: CollectionInvite,
      accept_url: z.string(),
    }),
  ])
  const liveCollectionInvite = async (
    c: Context,
  ): Promise<{ inv: CollectionInviteRecord; collection: CollectionRecord } | null> => {
    const token = c.req.param("token")
    if (!token) return null
    const inv = await meta.getCollectionInviteByToken(sha256(token))
    if (!inv || !isLiveInvite(inv)) return null
    const collection = await meta.getCollection(inv.collection_id)
    return collection ? { inv, collection } : null
  }

  // Resolve the :id collection and gate it — 404 missing, 403 present-but-
  // unauthorized (unlike an artifact's read gate, a collection you can't manage is
  // still worth knowing exists, so this doesn't hide it behind a 404). The
  // getCollection + canManageCollection pair every mutating route below opens with.
  const requireCollection = async (
    c: Context,
    action: Action,
  ): Promise<CollectionRecord | Response> => {
    const id = c.req.param("id")
    const col = id ? await meta.getCollection(id) : null
    if (!col) return fail(c, 404, "not found")
    if (!(await canManageCollection(c, col, action))) return fail(c, 403, "forbidden")
    return col
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/collections/{id}",
      tags: ["Collections"],
      summary: "Get one collection through standing or its world link.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The collection.",
          content: { "application/json": { schema: Collection } },
        },
      },
    }),
    async (c) => {
      const col = await meta.getCollection(c.req.param("id"))
      if (!col) return bail(fail(c, 404, "not found"))
      const role = await collectionRole(c, col)
      if (!role)
        return bail(
          col.password_hash ? fail(c, 401, "password required") : fail(c, 404, "not found"),
        )
      const standing = await collectionStandingRole(c, col)
      const [ids, sources] = await Promise.all([
        meta.collectionArtifactIds(col.id),
        meta.listRepoSources(col.org_id),
      ])
      const { srcByCollection, branchByRepo } = sourceMaps(sources)
      return c.json({
        ...enrich({ ...col, count: ids.length, my_role: role }, srcByCollection, branchByRepo),
        can_share: roleAllows(standing ?? "viewer", "share"),
        url: `${ctx.deps.baseUrl.replace(/\/$/, "")}/collections/${col.id}`,
      })
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/collections",
      tags: ["Collections"],
      summary: "List the active workspace's collections (members only).",
      responses: {
        200: {
          description: "The workspace's collections, each with its item count and origin.",
          content: {
            "application/json": { schema: z.object({ collections: z.array(Collection) }) },
          },
        },
      },
    }),
    async (c) => {
      const me = await currentUser(c)
      if (!me && !isToken(c)) return bail(fail(c, 401, "unauthenticated"))
      const org = await activeWorkspace(c)
      // Collections are a workspace-internal organizer — only members (or the operator
      // token) see them. A non-member (incl. anon in open mode) gets an empty list, so
      // a workspace's collections can't be enumerated via a public artifact's workspace.
      if (!(await isMember(c, org))) return c.json({ collections: [] })
      // ONE store call answers the whole view: the org's collections + repo sources, and
      // (for a signed-in reader) their stars, worked-in set, and per-shelf preview strip.
      // Those last three were separate reads for one release — ~240ms of round trips on
      // the edge tier, which round-trip-budget.test.ts now fails on.
      const {
        collections: cols,
        sources,
        starred,
        workedIn,
        previews: rawPreviews,
        previewBylines,
      } = await meta.collectionsOverview(
        org,
        me
          ? { userId: me.id, activeSince: activeSince(), previewPer: PREVIEW_PER_COLLECTION }
          : undefined,
      )
      // Same share experience as an artifact: an invite-only collection
      // (workspace_access=none) only lists for its creator or an explicit
      // collectionMember — collectionRole (the single source of truth, shared with the
      // members endpoint's own visibility gate) applies that per-collection, but calling
      // it once per row cost up to two round trips PER collection. Same rule, computed
      // from ONE batched `collectionRolesForUser` call: the operator token is owner on
      // everything; otherwise the creator is owner, else the batched map (explicit
      // membership or a seat on a workspace-open collection, higher wins) decides.
      const roleMap =
        me && !isToken(c)
          ? await meta.collectionRolesForUser(
              cols.map((col) => col.id),
              me.id,
            )
          : {}
      const collections = collectionsJson(
        cols,
        sources,
        roleMap,
        me?.id ?? null,
        isToken(c),
        new Set(starred),
        new Map(workedIn.map((w) => [w.id, w.at])),
        rawPreviews,
        previewBylines,
      )
      return c.json({ collections })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/collections",
      tags: ["Collections"],
      summary: "Create a collection.",
      responses: {
        201: {
          description: "The created collection (empty, manual).",
          content: { "application/json": { schema: Collection } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "comment"))) return bail(fail(c, 403, "forbidden"))
      const me = await currentUser(c)
      const body = await readJson(
        c,
        z.object({ title: z.string().refine((s) => s.trim() !== "", "title required") }),
      )
      if (body instanceof Response) return bail(body)
      const title = body.title.trim().slice(0, 120)
      const createdBy = me?.id ?? "anon"
      const col = await meta.createCollection({
        id: newId("col"),
        org_id: await activeWorkspace(c),
        title,
        created_by: createdBy,
        // Same factory default as an artifact: workspace-open. (Unlike an
        // artifact, there's no per-org default to consult yet — collections are
        // simpler, always workspace_access=member on create.)
        workspace_access: "member",
      })
      // The creator joins as owner: they manage it, and (like any member) their
      // role propagates to the collection's artifacts.
      await meta.setCollectionMember({
        id: newId("cm"),
        collection_id: col.id,
        user_id: createdBy,
        role: "owner",
      })
      // A brand-new collection is empty (count 0) and user-created (manual) — return the
      // full shape so the client can drop it straight into its list without a refetch.
      return c.json({ ...col, count: 0, my_role: "owner" as const, kind: "manual" as const }, 201)
    },
  )

  // Star a collection: it pins to the caller's sidebar. Deliberately gated on `read`,
  // not `share` — starring changes nothing about the collection or who reaches it, it is
  // a note-to-self about where you work. Anyone who can open it can star it.
  for (const [method, on] of [
    ["put", true],
    ["delete", false],
  ] as const) {
    app.openapi(
      createRoute({
        method,
        path: "/v1/collections/{id}/favorite",
        tags: ["Collections"],
        summary: on ? "Star a collection." : "Unstar a collection.",
        request: { params: z.object({ id: z.string() }) },
        responses: {
          200: {
            description: "The new starred state.",
            content: { "application/json": { schema: z.object({ starred: z.boolean() }) } },
          },
        },
      }),
      async (c) => {
        // The same guard the artifact star uses — a star belongs to a real account, and
        // the shared helper is what makes an anonymous caller a 403 rather than a crash.
        const me = await requireUser(c)
        if (me instanceof Response) return bail(me)
        const col = await requireCollection(c, "read")
        if (col instanceof Response) return bail(col)
        if (on) await meta.setCollectionFavorite(col.id, me.id)
        else await meta.removeCollectionFavorite(col.id, me.id)
        return c.json({ starred: on })
      },
    )
  }

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/collections/{id}",
      tags: ["Collections"],
      summary: "Rename a collection.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The updated collection.",
          content: { "application/json": { schema: Collection } },
        },
      },
    }),
    async (c) => {
      const col = await requireCollection(c, "publish")
      if (col instanceof Response) return bail(col)
      const body = await readJson(c, z.object({ title: z.string().optional() }))
      if (body instanceof Response) return bail(body)
      const updated = await meta.updateCollection(col.id, {
        title: body.title?.trim().slice(0, 120),
      })
      if (!updated) return bail(fail(c, 404, "not found"))
      // Return the SAME enriched shape as the list, so every collection response is one
      // type. Count + origin are unchanged by a rename; re-derive them (rare op).
      const [ids, sources, role] = await Promise.all([
        meta.collectionArtifactIds(updated.id),
        meta.listRepoSources(updated.org_id),
        collectionRole(c, updated),
      ])
      const { srcByCollection, branchByRepo } = sourceMaps(sources)
      return c.json(
        enrich({ ...updated, count: ids.length, my_role: role }, srcByCollection, branchByRepo),
      )
    },
  )

  // Same access transition as an artifact, minus listing: workspace seats, the
  // canonical world link, and its optional password are one atomic write.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/collections/{id}/access",
      tags: ["Collections"],
      summary: "Change a collection's workspace and link access.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The new access.",
          content: {
            "application/json": {
              schema: z.object({
                workspace_access: z
                  .enum(["none", "member"])
                  .describe("The collection's new workspace share scope."),
                link_role: z.enum(["none", "viewer", "commenter", "editor"]),
                locked: z.boolean(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const col = await requireCollection(c, "share")
      if (col instanceof Response) return bail(col)
      const b = await readJson(
        c,
        z.object({
          workspaceAccess: z.enum(["none", "member"]).optional(),
          linkRole: z.enum(["none", "viewer", "commenter", "editor"]).optional(),
          password: z.string().optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      const workspaceAccess = b.workspaceAccess ?? col.workspace_access
      const linkRole = b.linkRole ?? col.link_role
      let passwordHash: string | null = null
      if (linkRole !== "none") {
        if (b.password) passwordHash = hashPassword(b.password)
        else if (b.password === undefined) passwordHash = col.password_hash
      }
      await meta.setCollectionAccess(col.id, workspaceAccess, linkRole, passwordHash)
      return c.json({
        workspace_access: workspaceAccess,
        link_role: linkRole,
        locked: !!passwordHash,
      })
    },
  )

  // authz-exempt: possession of the collection password is the authorization gate.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/collections/{id}/unlock",
      tags: ["Collections"],
      summary: "Unlock a password-protected collection link.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Unlocked.",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const over = await limited(c, unlockLimiter)
      if (over) return bail(over)
      const col = await meta.getCollection(c.req.param("id"))
      if (!col?.password_hash) return bail(fail(c, 404, "not found"))
      const b = await readJson(c, z.object({ password: z.string().min(1) }))
      if (b instanceof Response) return bail(b)
      if (!verifyPassword(b.password, col.password_hash))
        return bail(fail(c, 401, "wrong password"))
      setCookie(
        c,
        subjectUnlockCookie("collection", col.id),
        unlockToken(col.id, col.password_hash),
        {
          path: "/",
          maxAge: 60 * 60 * 24 * 30,
          httpOnly: true,
          sameSite: ctx.deps.crossSite ? "None" : "Lax",
          secure: ctx.deps.crossSite || new URL(ctx.deps.baseUrl).protocol === "https:",
        },
      )
      return c.json({ ok: true })
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/collections/{id}",
      tags: ["Collections"],
      summary: "Delete a collection.",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "The collection was deleted." } },
    }),
    async (c) => {
      const col = await requireCollection(c, "share")
      if (col instanceof Response) return bail(col)
      await meta.deleteCollection(col.id)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/collections/{id}/items/{shortId}",
      tags: ["Collections"],
      summary: "Add an artifact to a collection.",
      request: { params: z.object({ id: z.string(), shortId: z.string() }) },
      responses: {
        200: {
          description: "The artifact was added.",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const col = await requireCollection(c, "publish")
      if (col instanceof Response) return bail(col)
      const art = await meta.getByShortId(c.req.param("shortId"))
      // Adding to a collection re-shares the artifact (the collection's members inherit
      // a role on it), so the caller must be able to SHARE the artifact — not merely
      // read it (a viewer can't reshape access) but not necessarily own it either.
      // Collections are org-wide organizing tools, so a workspace editor can fold in any
      // workspace-accessible artifact (share via their seat); an invite-only doc still
      // needs explicit share standing. The same-workspace guard keeps it from folding a
      // foreign-workspace artifact in by short_id.
      if (!art || art.org_id !== col.org_id) return bail(fail(c, 404, "artifact not found"))
      if (!(await authorize(c, "share", art))) return bail(fail(c, 403, "forbidden"))
      await meta.addCollectionItem(col.id, art.id)
      return c.json({ ok: true })
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/collections/{id}/items/{shortId}",
      tags: ["Collections"],
      summary: "Remove an artifact from a collection.",
      request: { params: z.object({ id: z.string(), shortId: z.string() }) },
      responses: { 204: { description: "The artifact was removed." } },
    }),
    async (c) => {
      const col = await requireCollection(c, "publish")
      if (col instanceof Response) return bail(col)
      const art = await meta.getByShortId(c.req.param("shortId"))
      // Curation of your own collection; same-workspace guard mirrors the add path.
      if (!art || art.org_id !== col.org_id) return bail(fail(c, 404, "artifact not found"))
      await meta.removeCollectionItem(col.id, art.id)
      return c.body(null, 204)
    },
  )

  // Where does work like this get filed? The picker's semantic "Suggested" tier: the
  // artifact's nearest neighbors (by the dense index's stored vectors — no embed call
  // at request time) each vote for the collections they already live in. Best-effort by
  // design: no dense arm, no vector yet, or a dense hiccup all answer [] and the picker
  // falls back to its client-side heuristics.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{shortId}/collection-suggestions",
      tags: ["Collections"],
      summary: "Collections where work similar to this artifact already lives (members only).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "Suggested collections, best first. Empty whenever there's no signal.",
          content: {
            "application/json": {
              schema: z.object({ suggestions: z.array(CollectionSuggestion) }),
            },
          },
        },
      },
    }),
    async (c) => {
      const art = await meta.getByShortId(c.req.param("shortId"))
      if (!art || art.current_version === 0 || !(await authorize(c, "read", art)))
        return bail(fail(c, 404, "not found"))
      const empty = { suggestions: [] as { id: string; score: number }[] }
      // Members only — the same rule as GET /v1/collections, so this can't become a side
      // channel that enumerates a workspace's collections off a public artifact.
      if (!(await isMember(c, art.org_id))) return c.json(empty)
      const search = ctx.search
      if (!search?.similar) return c.json(empty)
      const neighbors = await search
        .similar(art.org_id, art.id, SUGGEST_NEIGHBORS)
        .catch((err): { id: string; score: number }[] => {
          // Best-effort on read, like every dense-arm consumer: a store hiccup degrades
          // to "no suggestions", never a 500 on a picker open.
          log.error("collection-suggestions dense lookup failed", {
            artifact: art.id,
            err: String(err),
          })
          return []
        })
      if (neighbors.length === 0) return c.json(empty)
      // The access gate here is PER COLLECTION, not per neighbor — deliberately unlike
      // workspace search's visibleArtifacts. The response reveals nothing about a
      // neighbor except its presence in a collection, and collection visibility already
      // implies enumerating its contents (collectionRole propagates to every item — the
      // "no phantom-empty collections" rule), so a collection the caller may see leaks
      // nothing when it votes. The LISTING gate would be wrong as well as redundant: it
      // hides unlisted team drafts from everyone but their author, and team drafts are
      // exactly what people file — the tier would almost never fire. The trusted read
      // below only drops tombstones and cross-org strays a stale index could nominate;
      // no field of it reaches the response.
      const live = await meta.listArtifacts({
        orgId: art.org_id,
        ids: neighbors.map((n) => n.id),
        excludeRemoved: true,
      })
      const liveIds = new Set(live.map((a) => a.id))
      const byArtifact = await meta.collectionsForArtifacts([...liveIds])
      const ranked = voteCollections(
        neighbors.filter((n) => liveIds.has(n.id)),
        byArtifact,
        SUGGEST_CANDIDATES,
      )
      // The gate: collectionRole is the single source of truth (an invite-only
      // collection a neighbor lives in must not surface for a non-member). Candidates
      // are ≤ SUGGEST_CANDIDATES, so per-row resolution stays a handful of indexed
      // reads.
      const suggestions: { id: string; score: number }[] = []
      for (const cand of ranked) {
        if (suggestions.length >= SUGGEST_CAP) break
        const col = await meta.getCollection(cand.id)
        if (!col || !(await collectionRole(c, col))) continue
        suggestions.push(cand)
      }
      return c.json({ suggestions })
    },
  )

  // Bulk add — the library multi-select bar drops many artifacts into one or more
  // collections in a single call. The collections are authorized once each (you must be
  // able to publish to a collection to fold artifacts into it); every artifact is then
  // authorized on its own for "share" exactly like the single add-item route, since adding
  // to a shared collection re-shares the artifact. Per-artifact refusals come back as
  // `skipped`, so a mixed selection lands what it can without failing the batch.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/bulk/collections",
      tags: ["Collections"],
      summary: "Add many artifacts to one or more collections (per-artifact share-gated).",
      responses: {
        200: {
          description: "How many artifacts were added / skipped / failed.",
          content: { "application/json": { schema: BulkSummarySchema } },
        },
      },
    }),
    async (c) => {
      const body = await readJson(
        c,
        z.object({
          shortIds: z.array(z.string()).min(1).max(BULK_MAX),
          collectionIds: z.array(z.string()).min(1),
        }),
      )
      if (body instanceof Response) return bail(body)
      // Resolve the target collections and keep only those the caller can publish to. If
      // they can manage NONE, that's a flat 403 — nothing to add into.
      const resolved = await Promise.all(body.collectionIds.map((id) => meta.getCollection(id)))
      const allowedCols: CollectionRecord[] = []
      for (const col of resolved) {
        if (col && (await canManageCollection(c, col, "publish"))) allowedCols.push(col)
      }
      if (allowedCols.length === 0) return bail(fail(c, 403, "forbidden"))
      const summary = await bulkArtifactOp(
        body.shortIds,
        (ids) => meta.getByShortIds(ids),
        (a) => authorize(c, "share", a),
        async (a) => {
          // Same-workspace guard mirrors the single add-item route: a foreign-workspace
          // artifact (by short_id) is not folded into this workspace's collection.
          for (const col of allowedCols) {
            if (col.org_id === a.org_id) await meta.addCollectionItem(col.id, a.id)
          }
        },
      )
      return c.json(summary)
    },
  )

  // Member endpoints — the collaborators whose role propagates to the collection's
  // artifacts. They return the shared ArtifactMember shape (see ../schemas).
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/collections/{id}/members",
      tags: ["Collections"],
      summary: "List a collection's members.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The collection's creator and its members.",
          content: {
            "application/json": {
              schema: z.object({
                created_by: z.string().describe("User id of the collection's creator."),
                members: z.array(ArtifactMember),
                invites: z.array(CollectionInvite),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const col = await meta.getCollection(c.req.param("id"))
      // A public link grants the collection's contents, not its private roster.
      // Keep collaborator identity behind standing (seat/direct-share) access just
      // like the artifact sharing endpoints do.
      if (!col || (await collectionStandingRole(c, col)) === null)
        return bail(fail(c, 404, "not found"))
      const rows = await meta.listCollectionMembers(col.id)
      const users = await meta.getUsers(rows.map((r) => r.user_id))
      const byId = new Map(users.map((u) => [u.id, u]))
      const standing = await collectionStandingRole(c, col)
      const invites = roleAllows(standing ?? "viewer", "share")
        ? (await meta.listPendingCollectionInvites(col.id)).map(inviteJson)
        : []
      return c.json({
        created_by: col.created_by,
        members: rows.map((r) => ({
          user_id: r.user_id,
          handle: byId.get(r.user_id)?.username ?? null,
          name: byId.get(r.user_id)?.name ?? null,
          role: r.role,
        })),
        invites,
      })
    },
  )

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/collections/{id}/members",
      tags: ["Collections"],
      summary: "Add or update a collection member.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        201: {
          description: "The member added directly, or a pending emailed invite.",
          content: { "application/json": { schema: CollectionShareResult } },
        },
      },
    }),
    async (c) => {
      const col = await requireCollection(c, "share")
      if (col instanceof Response) return bail(col)
      const b = await readJson(
        c,
        z
          .object({
            user: z.string().min(1).optional(),
            email: z.string().min(1).optional(),
            role: z.custom<Role>(isRole, "a valid role is required"),
          })
          .refine((v) => v.user || v.email, "a username or email is required"),
      )
      if (b instanceof Response) return bail(b)
      if (rank(b.role) > rank(await collectionStandingRole(c, col)))
        return bail(fail(c, 403, "you can't grant a role above your own"))
      const id = await resolveUserRef(meta, (b.user ?? b.email) as string)
      const [user] = id ? await meta.getUsers([id]) : []
      if (!user) {
        const email = ((b.user ?? b.email) as string).trim().toLowerCase()
        if (!looksLikeEmail(email))
          return bail(fail(c, 404, "no Derive user with that username or email"))
        const over = await limited(c, inviteLimiter)
        if (over) return bail(over)
        await meta.deletePendingCollectionInvitesFor(col.id, email)
        const token = mintToken("dkc")
        const sharer = await actingUser(c)
        const invite = await meta.createCollectionInvite({
          id: newId("cinv"),
          collection_id: col.id,
          email,
          role: b.role,
          token: sha256(token),
          invited_by: sharer?.id ?? null,
          expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        })
        const acceptUrl = `${ctx.deps.baseUrl.replace(/\/$/, "")}/invite/c/${token}`
        await enqueueChannelDelivery(
          meta,
          "email",
          "collection.invite",
          buildShareInviteEmail({
            to: email,
            title: col.title,
            subject: "collection",
            inviter: sharer?.name ?? null,
            role: b.role,
            url: acceptUrl,
          }),
        )
        return c.json(
          { kind: "invite" as const, invite: inviteJson(invite), accept_url: acceptUrl },
          201,
        )
      }
      if (user.email) await meta.deletePendingCollectionInvitesFor(col.id, user.email.toLowerCase())
      // The creator is permanently owner (collectionRole checks created_by first), so
      // their role isn't a member row anyone can rewrite — reject demoting them.
      if (user.id === col.created_by)
        return bail(fail(c, 409, "the collection owner's role can't be changed"))
      // Like artifact ownership, collection ownership is authority inside this
      // workspace. Portable cross-workspace shares stop at editor.
      if (b.role === "owner" && !(await meta.getMembership(col.org_id, user.id)))
        return bail(fail(c, 400, "a collection owner must belong to its workspace"))
      await meta.setCollectionMember({
        id: newId("cm"),
        collection_id: col.id,
        user_id: user.id,
        role: b.role,
      })
      return c.json(
        {
          kind: "member" as const,
          member: { user_id: user.id, handle: user.username, name: user.name, role: b.role },
        },
        201,
      )
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/collections/{id}/members/{userId}",
      tags: ["Collections"],
      summary: "Remove a collection member.",
      request: { params: z.object({ id: z.string(), userId: z.string() }) },
      responses: { 204: { description: "The member was removed." } },
    }),
    async (c) => {
      const col = await requireCollection(c, "share")
      if (col instanceof Response) return bail(col)
      // The creator stays owner via created_by regardless of member rows; removing the
      // row wouldn't revoke their access, it would just orphan the roster — refuse it.
      if (c.req.param("userId") === col.created_by)
        return bail(fail(c, 409, "can't remove the collection owner"))
      const target = await meta.getCollectionMember(col.id, c.req.param("userId"))
      if (target && rank(target.role) > rank(await collectionStandingRole(c, col)))
        return bail(fail(c, 403, "you can't remove a collaborator who outranks you"))
      await meta.removeCollectionMember(col.id, c.req.param("userId"))
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/collections/{id}/invites/{inviteId}",
      tags: ["Collections"],
      summary: "Revoke a pending collection invitation.",
      request: { params: z.object({ id: z.string(), inviteId: z.string() }) },
      responses: { 204: { description: "The invitation was revoked." } },
    }),
    async (c) => {
      const col = await requireCollection(c, "share")
      if (col instanceof Response) return bail(col)
      const target = (await meta.listPendingCollectionInvites(col.id)).find(
        (i) => i.id === c.req.param("inviteId"),
      )
      if (target && rank(target.role) > rank(await collectionStandingRole(c, col)))
        return bail(fail(c, 403, "you can't revoke an invite that outranks you"))
      await meta.deleteCollectionInvite(c.req.param("inviteId"), col.id)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/collection-invites/{token}",
      tags: ["Collections"],
      summary: "Preview a collection invitation.",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: {
          description: "The collection and role the token grants.",
          content: {
            "application/json": {
              schema: z.object({
                title: z.string(),
                role: roleEnum,
                email: z.string(),
                inviter: z.string().nullable(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const live = await liveCollectionInvite(c)
      if (!live) return bail(fail(c, 404, "this invitation is invalid or has expired"))
      const { inv, collection } = live
      await armInviteAdmission(
        c,
        "collection",
        sha256(c.req.param("token")),
        inv.expires_at,
        ctx.deps.encryptionKey,
        { baseUrl: ctx.deps.baseUrl, crossSite: ctx.deps.crossSite },
      )
      const inviter = inv.invited_by ? (await meta.getUsers([inv.invited_by]))[0] : undefined
      return c.json({
        title: collection.title,
        role: inv.role,
        email: inv.email,
        inviter: inviter?.name ?? null,
      })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/collection-invites/{token}/accept",
      tags: ["Collections"],
      summary: "Accept a collection invitation.",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: {
          description: "The collection joined and granted role.",
          content: {
            "application/json": {
              schema: z.object({ collection_id: z.string(), role: roleEnum }),
            },
          },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const live = await liveCollectionInvite(c)
      if (!live) return bail(fail(c, 404, "this invitation is invalid or has expired"))
      const { inv, collection } = live
      const mismatch = await emailMismatch409(c, inv.email, me.email)
      if (mismatch) return bail(mismatch)
      const now = new Date().toISOString()
      if (!(await meta.consumeCollectionInvite(inv.id, now)))
        return bail(fail(c, 409, "this invitation has already been accepted"))
      const existing = await meta.getCollectionMember(collection.id, me.id)
      const granted = existing && rank(existing.role) >= rank(inv.role) ? existing.role : inv.role
      if (granted !== existing?.role)
        await meta.setCollectionMember({
          id: existing?.id ?? newId("cm"),
          collection_id: collection.id,
          user_id: me.id,
          role: granted,
        })
      await meta.deletePendingCollectionInvitesFor(collection.id, inv.email)
      return c.json({ collection_id: collection.id, role: granted })
    },
  )

  return app
}
