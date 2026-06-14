import type {
  AgentMentionRecord,
  AgentRecord,
  ArtifactMemberRecord,
  ArtifactRecord,
  AuditLogRecord,
  CollectionMemberRecord,
  CollectionRecord,
  CommentRecord,
  CommentState,
  DeliveryRecord,
  DeliveryStatus,
  ListArtifactsOpts,
  MembershipRecord,
  NewAgent,
  NewAgentMention,
  NewArtifact,
  NewArtifactMember,
  NewAuditLog,
  NewCollection,
  NewCollectionMember,
  NewComment,
  NewDelivery,
  NewMembership,
  NewNotification,
  NewProposal,
  NewReport,
  NewRepoSource,
  NewVersion,
  NewWebhook,
  NotificationRecord,
  ProposalRecord,
  ProposalState,
  ReportRecord,
  ReportState,
  RepoSourceRecord,
  Role,
  VersionRecord,
  Visibility,
  WebhookRecord,
  WorkspaceRecord,
} from "@dock/core"
import { and, asc, count, desc, eq, inArray, isNull, like, lt, lte, or, sql } from "drizzle-orm"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import type { Exhaustive, Shapes } from "./parity"
import {
  agent,
  agentMention,
  artifact,
  artifactFavorite,
  artifactMember,
  artifactTag,
  auditLog,
  collection,
  collectionItem,
  collectionMember,
  comment,
  membership,
  notification,
  proposal,
  report,
  repoSource,
  version,
  webhook,
  webhookDelivery,
  workspace,
} from "./schema"

/** The drizzle schema object — shared by the better-sqlite3 and D1 drivers. */
export const schema = {
  artifact,
  version,
  comment,
  webhook,
  webhookDelivery,
  membership,
  workspace,
  artifactMember,
  notification,
  artifactFavorite,
  artifactTag,
  proposal,
  agent,
  agentMention,
  collection,
  collectionItem,
  collectionMember,
  repoSource,
  report,
  auditLog,
}

// Compile-time schema parity (see ./parity): every table must be classified, and
// every typed table's row shape must match its @dock/core Record exactly. A new
// table that isn't classified, or a column that drifts, fails to compile here.
const _schemaExhaustive: Exhaustive<typeof schema> = true
const _schemaShapes: Shapes<typeof schema> = {
  artifact: true,
  version: true,
  comment: true,
  webhook: true,
  webhookDelivery: true,
  membership: true,
  workspace: true,
  artifactMember: true,
  notification: true,
  proposal: true,
  agent: true,
  agentMention: true,
  collection: true,
  collectionMember: true,
  repoSource: true,
  report: true,
  auditLog: true,
}
void _schemaExhaustive
void _schemaShapes

/**
 * A drizzle SQLite database of either result kind. better-sqlite3 is synchronous
 * (`.get()` returns a value), D1 is async (`.get()` returns a Promise) — but the
 * query *builders* are identical, and `await` passes a sync value straight through.
 * So every method here is written once with `await` and works on both drivers.
 */
export type SqliteDb = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>

/** The shape of a `.run()` result across drivers: better-sqlite3 exposes
 *  `changes` directly; D1 nests it under `meta`. */
type RunResult = { changes?: number; meta?: { changes?: number } }

/** Pull the artifact ids out of repo_source `files` JSON rows. A file map is
 *  `{ [repoPath]: { artifact_id, sha } }`; a managed artifact is any id therein.
 *  Shared by both drivers so "is this artifact synced?" reads identically. */
export const collectManagedIds = (rows: { files: string }[]): string[] => {
  const ids = new Set<string>()
  for (const r of rows) {
    try {
      const map = JSON.parse(r.files) as Record<string, { artifact_id?: string }>
      for (const k in map) {
        const id = map[k]?.artifact_id
        if (id) ids.add(id)
      }
    } catch {
      // A malformed map shouldn't break the gate; treat it as managing nothing.
    }
  }
  return [...ids]
}

/**
 * The dialect-agnostic SQLite repository: the bulk of the MetaStore implemented
 * once over drizzle's SQLite query builder. The better-sqlite3 and D1 drivers
 * compose this and add only what genuinely differs — raw analytics SQL, the
 * Better-Auth user directory, and the transaction-bearing writes (where
 * better-sqlite3 wraps them in a sync transaction and D1 runs them sequentially,
 * the sequential versions living here).
 */
export function makeRepos(db: SqliteDb) {
  // ---- Artifacts + versions ----------------------------------------------
  const getByShortId = async (shortId: string): Promise<ArtifactRecord | null> =>
    (await db.select().from(artifact).where(eq(artifact.short_id, shortId)).get()) ?? null

  const createArtifact = async (a: NewArtifact): Promise<ArtifactRecord> => {
    await db.insert(artifact).values(a).run()
    return (await getByShortId(a.short_id)) as ArtifactRecord
  }

  const setVisibility = async (
    artifactId: string,
    visibility: Visibility,
    passwordHash: string | null,
  ): Promise<void> => {
    await db
      .update(artifact)
      .set({ visibility, password_hash: passwordHash })
      .where(eq(artifact.id, artifactId))
      .run()
  }

  const getVersion = async (artifactId: string, n: number): Promise<VersionRecord | null> =>
    (await db
      .select()
      .from(version)
      .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
      .get()) ?? null

  // Sequential add (used by D1, which has no interactive transactions; the
  // UNIQUE(artifact_id, n) constraint turns a race into a clean error). The
  // better-sqlite3 driver overrides this with a synchronous transaction.
  const addVersion = async (artifactId: string, v: NewVersion): Promise<VersionRecord> => {
    const row = await db
      .select({ cv: artifact.current_version })
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .get()
    if (!row) throw new Error(`artifact not found: ${artifactId}`)
    const n = row.cv + 1
    await db
      .insert(version)
      .values({ ...v, artifact_id: artifactId, n })
      .run()
    await db.update(artifact).set({ current_version: n }).where(eq(artifact.id, artifactId)).run()
    return (await getVersion(artifactId, n)) as VersionRecord
  }

  const listVersions = async (artifactId: string): Promise<VersionRecord[]> =>
    db
      .select()
      .from(version)
      .where(eq(version.artifact_id, artifactId))
      .orderBy(asc(version.n))
      .all()

  const listArtifacts = async (opts?: ListArtifactsOpts): Promise<ArtifactRecord[]> => {
    if (opts?.ids && opts.ids.length === 0) return []
    const conds = []
    if (opts?.q) conds.push(like(sql`lower(${artifact.title})`, `%${opts.q.toLowerCase()}%`))
    if (opts?.cursor)
      conds.push(
        or(
          lt(artifact.created_at, opts.cursor.created_at),
          and(eq(artifact.created_at, opts.cursor.created_at), lt(artifact.id, opts.cursor.id)),
        ),
      )
    if (opts?.ids) conds.push(inArray(artifact.id, opts.ids))
    if (opts?.orgId) conds.push(eq(artifact.org_id, opts.orgId))
    const rows = db
      .select()
      .from(artifact)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(artifact.created_at), desc(artifact.id))
    return opts?.limit ? rows.limit(opts.limit).all() : rows.all()
  }

  const artifactIdsByTag = async (tag: string): Promise<string[]> =>
    (
      await db
        .select({ id: artifactTag.artifact_id })
        .from(artifactTag)
        .where(eq(artifactTag.tag, tag))
        .all()
    ).map((r) => r.id)

  const countArtifacts = async (orgId?: string): Promise<number> => {
    const q = db.select({ c: count() }).from(artifact)
    return (await (orgId ? q.where(eq(artifact.org_id, orgId)) : q).get())?.c ?? 0
  }

  const storageBytes = async (orgId: string): Promise<number> => {
    // One row per distinct blob in the org (max size_bytes guards a stale 0 on a
    // restored row), then summed — so dedup'd content is counted once.
    const perBlob = db
      .select({ mx: sql<number>`max(${version.size_bytes})`.as("mx") })
      .from(version)
      .innerJoin(artifact, eq(artifact.id, version.artifact_id))
      .where(eq(artifact.org_id, orgId))
      .groupBy(version.blob_key)
      .as("per_blob")
    const row = await db
      .select({ s: sql<number>`coalesce(sum(${perBlob.mx}), 0)` })
      .from(perBlob)
      .get()
    return Number(row?.s ?? 0)
  }

  const tagCounts = async (orgId?: string): Promise<{ tag: string; count: number }[]> => {
    const base = db
      .select({ tag: artifactTag.tag, count: count() })
      .from(artifactTag)
      .innerJoin(artifact, eq(artifact.id, artifactTag.artifact_id))
    return (orgId ? base.where(eq(artifact.org_id, orgId)) : base)
      .groupBy(artifactTag.tag)
      .orderBy(asc(artifactTag.tag))
      .all()
  }

  const setArtifactRemoved = async (id: string, removedAt: string | null): Promise<void> => {
    await db.update(artifact).set({ removed_at: removedAt }).where(eq(artifact.id, id)).run()
  }

  // ---- Comments + threads ------------------------------------------------
  const getComment = async (id: string): Promise<CommentRecord | null> =>
    (await db.select().from(comment).where(eq(comment.id, id)).get()) ?? null

  const createComment = async (c: NewComment): Promise<CommentRecord> => {
    await db.insert(comment).values(c).run()
    return (await getComment(c.id)) as CommentRecord
  }

  const updateComment = async (
    id: string,
    fields: { body_md?: string; meta?: string | null },
  ): Promise<CommentRecord | null> => {
    await db.update(comment).set(fields).where(eq(comment.id, id)).run()
    return getComment(id)
  }

  const listComments = async (
    artifactId: string,
    opts?: { state?: CommentState },
  ): Promise<CommentRecord[]> => {
    const where = opts?.state
      ? and(eq(comment.artifact_id, artifactId), eq(comment.state, opts.state))
      : eq(comment.artifact_id, artifactId)
    return db.select().from(comment).where(where).orderBy(asc(comment.created_at)).all()
  }

  const setThreadState = async (
    artifactId: string,
    threadId: string,
    state: CommentState,
  ): Promise<number> => {
    const res = (await db
      .update(comment)
      .set({ state })
      .where(and(eq(comment.artifact_id, artifactId), eq(comment.thread_id, threadId)))
      .run()) as RunResult
    return res.changes ?? res.meta?.changes ?? 0
  }

  // ---- Webhooks + outbox -------------------------------------------------
  const createWebhook = async (w: NewWebhook): Promise<WebhookRecord> =>
    (await db.insert(webhook).values(w).returning().get()) as WebhookRecord
  const listWebhooks = async (orgId: string): Promise<WebhookRecord[]> =>
    db
      .select()
      .from(webhook)
      .where(eq(webhook.org_id, orgId))
      .orderBy(desc(webhook.created_at))
      .all()
  const getWebhook = async (id: string, orgId: string): Promise<WebhookRecord | null> =>
    (await db
      .select()
      .from(webhook)
      .where(and(eq(webhook.id, id), eq(webhook.org_id, orgId)))
      .get()) ?? null
  const deleteWebhook = async (id: string, orgId: string): Promise<void> => {
    await db
      .delete(webhook)
      .where(and(eq(webhook.id, id), eq(webhook.org_id, orgId)))
      .run()
  }
  const activeWebhooks = async (artifactId: string, orgId: string): Promise<WebhookRecord[]> =>
    db
      .select()
      .from(webhook)
      .where(
        and(
          eq(webhook.active, 1),
          eq(webhook.org_id, orgId),
          or(isNull(webhook.artifact_id), eq(webhook.artifact_id, artifactId)),
        ),
      )
      .all()
  const enqueueDelivery = async (d: NewDelivery): Promise<void> => {
    await db.insert(webhookDelivery).values(d).run()
  }
  const claimDueDeliveries = async (now: string, limit: number): Promise<DeliveryRecord[]> =>
    db
      .select()
      .from(webhookDelivery)
      .where(and(eq(webhookDelivery.status, "pending"), lte(webhookDelivery.next_attempt_at, now)))
      .orderBy(asc(webhookDelivery.next_attempt_at))
      .limit(limit)
      .all()
  const updateDelivery = async (
    id: string,
    f: {
      status: DeliveryStatus
      attempts: number
      last_error: string | null
      next_attempt_at: string
    },
  ): Promise<void> => {
    await db.update(webhookDelivery).set(f).where(eq(webhookDelivery.id, id)).run()
  }
  const recentDeliveries = async (webhookId: string, limit: number): Promise<DeliveryRecord[]> =>
    db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.webhook_id, webhookId))
      .orderBy(desc(webhookDelivery.created_at))
      .limit(limit)
      .all()

  // ---- Workspace membership ----------------------------------------------
  const getMembership = async (orgId: string, userId: string): Promise<MembershipRecord | null> =>
    (await db
      .select()
      .from(membership)
      .where(and(eq(membership.org_id, orgId), eq(membership.user_id, userId)))
      .get()) ?? null
  const listMemberships = async (orgId: string): Promise<MembershipRecord[]> =>
    db.select().from(membership).where(eq(membership.org_id, orgId)).all()
  const countMemberships = async (orgId: string): Promise<number> =>
    (await db.select({ n: count() }).from(membership).where(eq(membership.org_id, orgId)).get())
      ?.n ?? 0
  const setMembership = async (m: NewMembership): Promise<MembershipRecord> =>
    (await db
      .insert(membership)
      .values(m)
      .onConflictDoUpdate({
        target: [membership.org_id, membership.user_id],
        set: { role: m.role },
      })
      .returning()
      .get()) as MembershipRecord
  const removeMembership = async (orgId: string, userId: string): Promise<void> => {
    await db
      .delete(membership)
      .where(and(eq(membership.org_id, orgId), eq(membership.user_id, userId)))
      .run()
  }
  const getWorkspace = async (orgId: string): Promise<WorkspaceRecord | null> =>
    (await db.select().from(workspace).where(eq(workspace.id, orgId)).get()) ?? null
  const setWorkspace = async (orgId: string, name: string): Promise<WorkspaceRecord> =>
    (await db
      .insert(workspace)
      .values({ id: orgId, name })
      .onConflictDoUpdate({ target: workspace.id, set: { name } })
      .returning()
      .get()) as WorkspaceRecord
  const deleteWorkspace = async (orgId: string): Promise<void> => {
    await db.delete(membership).where(eq(membership.org_id, orgId)).run()
    await db.delete(workspace).where(eq(workspace.id, orgId)).run()
  }
  const listWorkspaces = async (userId: string): Promise<(WorkspaceRecord & { role: Role })[]> =>
    db
      .select({
        id: workspace.id,
        name: workspace.name,
        created_at: workspace.created_at,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(workspace, eq(workspace.id, membership.org_id))
      .where(eq(membership.user_id, userId))
      .orderBy(asc(workspace.created_at))
      .all()

  // ---- Per-artifact shares -----------------------------------------------
  const getArtifactMember = async (
    artifactId: string,
    userId: string,
  ): Promise<ArtifactMemberRecord | null> =>
    (await db
      .select()
      .from(artifactMember)
      .where(and(eq(artifactMember.artifact_id, artifactId), eq(artifactMember.user_id, userId)))
      .get()) ?? null
  const listArtifactMembers = async (artifactId: string): Promise<ArtifactMemberRecord[]> =>
    db.select().from(artifactMember).where(eq(artifactMember.artifact_id, artifactId)).all()
  const setArtifactMember = async (m: NewArtifactMember): Promise<ArtifactMemberRecord> =>
    (await db
      .insert(artifactMember)
      .values(m)
      .onConflictDoUpdate({
        target: [artifactMember.artifact_id, artifactMember.user_id],
        set: { role: m.role },
      })
      .returning()
      .get()) as ArtifactMemberRecord
  const removeArtifactMember = async (artifactId: string, userId: string): Promise<void> => {
    await db
      .delete(artifactMember)
      .where(and(eq(artifactMember.artifact_id, artifactId), eq(artifactMember.user_id, userId)))
      .run()
  }

  // ---- Favorites + tags --------------------------------------------------
  const listUserFavoriteIds = async (userId: string): Promise<string[]> =>
    (
      await db
        .select({ id: artifactFavorite.artifact_id })
        .from(artifactFavorite)
        .where(eq(artifactFavorite.user_id, userId))
        .all()
    ).map((r) => r.id)
  const setFavorite = async (artifactId: string, userId: string): Promise<void> => {
    await db
      .insert(artifactFavorite)
      .values({ id: crypto.randomUUID(), artifact_id: artifactId, user_id: userId })
      .onConflictDoNothing({ target: [artifactFavorite.artifact_id, artifactFavorite.user_id] })
      .run()
  }
  const removeFavorite = async (artifactId: string, userId: string): Promise<void> => {
    await db
      .delete(artifactFavorite)
      .where(
        and(eq(artifactFavorite.artifact_id, artifactId), eq(artifactFavorite.user_id, userId)),
      )
      .run()
  }
  const tagsForArtifacts = async (artifactIds: string[]): Promise<Record<string, string[]>> => {
    if (artifactIds.length === 0) return {}
    const rows = await db
      .select({ artifact_id: artifactTag.artifact_id, tag: artifactTag.tag })
      .from(artifactTag)
      .where(inArray(artifactTag.artifact_id, artifactIds))
      .all()
    const out: Record<string, string[]> = {}
    for (const r of rows) {
      out[r.artifact_id] ??= []
      out[r.artifact_id]?.push(r.tag)
    }
    for (const k in out) out[k]?.sort()
    return out
  }
  // Sequential replace (used by D1). better-sqlite3 overrides with a transaction.
  const setArtifactTags = async (artifactId: string, tags: string[]): Promise<void> => {
    await db.delete(artifactTag).where(eq(artifactTag.artifact_id, artifactId)).run()
    for (const tag of tags)
      await db
        .insert(artifactTag)
        .values({ id: crypto.randomUUID(), artifact_id: artifactId, tag })
        .run()
  }

  // ---- Collections -------------------------------------------------------
  const createCollection = async (c: NewCollection): Promise<CollectionRecord> =>
    (await db.insert(collection).values(c).returning().get()) as CollectionRecord
  const getCollection = async (id: string): Promise<CollectionRecord | null> =>
    (await db.select().from(collection).where(eq(collection.id, id)).get()) ?? null
  const updateCollection = async (
    id: string,
    fields: { title?: string },
  ): Promise<CollectionRecord | null> => {
    if (fields.title === undefined) return getCollection(id)
    return (
      (await db
        .update(collection)
        .set({ title: fields.title })
        .where(eq(collection.id, id))
        .returning()
        .get()) ?? null
    )
  }
  // Sequential cascade (used by D1). better-sqlite3 overrides with a transaction.
  const deleteCollection = async (id: string): Promise<void> => {
    await db.delete(collectionItem).where(eq(collectionItem.collection_id, id)).run()
    await db.delete(collectionMember).where(eq(collectionMember.collection_id, id)).run()
    await db.delete(collection).where(eq(collection.id, id)).run()
  }
  const listCollections = async (
    orgId?: string,
  ): Promise<(CollectionRecord & { count: number })[]> => {
    const base = db.select().from(collection)
    const rows = await (orgId ? base.where(eq(collection.org_id, orgId)) : base)
      .orderBy(desc(collection.created_at))
      .all()
    const counts = await db
      .select({ id: collectionItem.collection_id, c: count() })
      .from(collectionItem)
      .groupBy(collectionItem.collection_id)
      .all()
    const cmap = new Map(counts.map((r) => [r.id, Number(r.c)]))
    return rows.map((r) => ({ ...r, count: cmap.get(r.id) ?? 0 }))
  }
  const collectionArtifactIds = async (collectionId: string): Promise<string[]> =>
    (
      await db
        .select({ id: collectionItem.artifact_id })
        .from(collectionItem)
        .where(eq(collectionItem.collection_id, collectionId))
        .all()
    ).map((r) => r.id)
  const collectionIdsForArtifact = async (artifactId: string): Promise<string[]> =>
    (
      await db
        .select({ id: collectionItem.collection_id })
        .from(collectionItem)
        .where(eq(collectionItem.artifact_id, artifactId))
        .all()
    ).map((r) => r.id)
  const addCollectionItem = async (collectionId: string, artifactId: string): Promise<void> => {
    await db
      .insert(collectionItem)
      .values({ id: crypto.randomUUID(), collection_id: collectionId, artifact_id: artifactId })
      .onConflictDoNothing({ target: [collectionItem.collection_id, collectionItem.artifact_id] })
      .run()
  }
  const removeCollectionItem = async (collectionId: string, artifactId: string): Promise<void> => {
    await db
      .delete(collectionItem)
      .where(
        and(
          eq(collectionItem.collection_id, collectionId),
          eq(collectionItem.artifact_id, artifactId),
        ),
      )
      .run()
  }
  const getCollectionMember = async (
    collectionId: string,
    userId: string,
  ): Promise<CollectionMemberRecord | null> =>
    (await db
      .select()
      .from(collectionMember)
      .where(
        and(eq(collectionMember.collection_id, collectionId), eq(collectionMember.user_id, userId)),
      )
      .get()) ?? null
  const listCollectionMembers = async (collectionId: string): Promise<CollectionMemberRecord[]> =>
    db.select().from(collectionMember).where(eq(collectionMember.collection_id, collectionId)).all()
  const setCollectionMember = async (m: NewCollectionMember): Promise<CollectionMemberRecord> =>
    (await db
      .insert(collectionMember)
      .values(m)
      .onConflictDoUpdate({
        target: [collectionMember.collection_id, collectionMember.user_id],
        set: { role: m.role },
      })
      .returning()
      .get()) as CollectionMemberRecord
  const removeCollectionMember = async (collectionId: string, userId: string): Promise<void> => {
    await db
      .delete(collectionMember)
      .where(
        and(eq(collectionMember.collection_id, collectionId), eq(collectionMember.user_id, userId)),
      )
      .run()
  }
  const collectionRolesForArtifact = async (artifactId: string, userId: string): Promise<Role[]> =>
    (
      await db
        .select({ role: collectionMember.role })
        .from(collectionMember)
        .innerJoin(collectionItem, eq(collectionItem.collection_id, collectionMember.collection_id))
        .where(
          and(eq(collectionItem.artifact_id, artifactId), eq(collectionMember.user_id, userId)),
        )
        .all()
    ).map((r) => r.role)

  // ---- GitHub sync sources -----------------------------------------------
  const createRepoSource = async (s: NewRepoSource): Promise<RepoSourceRecord> =>
    (await db.insert(repoSource).values(s).returning().get()) as RepoSourceRecord
  const getRepoSource = async (id: string, orgId?: string): Promise<RepoSourceRecord | null> =>
    (await db
      .select()
      .from(repoSource)
      .where(and(eq(repoSource.id, id), orgId ? eq(repoSource.org_id, orgId) : undefined))
      .get()) ?? null
  const listRepoSources = async (orgId: string): Promise<RepoSourceRecord[]> =>
    db
      .select()
      .from(repoSource)
      .where(eq(repoSource.org_id, orgId))
      .orderBy(desc(repoSource.created_at))
      .all()
  const updateRepoSourceSync = async (
    id: string,
    fields: { files: string; last_synced_at: string; last_status: string },
  ): Promise<void> => {
    await db.update(repoSource).set(fields).where(eq(repoSource.id, id)).run()
  }
  const deleteRepoSource = async (id: string, orgId: string): Promise<void> => {
    await db
      .delete(repoSource)
      .where(and(eq(repoSource.id, id), eq(repoSource.org_id, orgId)))
      .run()
  }
  const managedArtifactIds = async (orgId: string): Promise<string[]> => {
    const rows = await db
      .select({ files: repoSource.files })
      .from(repoSource)
      .where(eq(repoSource.org_id, orgId))
      .all()
    return collectManagedIds(rows)
  }

  // ---- Reviews: proposals ------------------------------------------------
  const createProposal = async (p: NewProposal): Promise<ProposalRecord> =>
    (await db.insert(proposal).values(p).returning().get()) as ProposalRecord
  const getProposal = async (id: string): Promise<ProposalRecord | null> =>
    (await db.select().from(proposal).where(eq(proposal.id, id)).get()) ?? null
  const listProposals = async (
    artifactId: string,
    opts?: { state?: ProposalState },
  ): Promise<ProposalRecord[]> => {
    const where = opts?.state
      ? and(eq(proposal.artifact_id, artifactId), eq(proposal.state, opts.state))
      : eq(proposal.artifact_id, artifactId)
    return db.select().from(proposal).where(where).orderBy(desc(proposal.created_at)).all()
  }
  const decideProposal = async (
    id: string,
    fields: {
      state: ProposalState
      decided_by: string | null
      decided_version: number | null
      decision_note?: string | null
    },
  ): Promise<ProposalRecord | null> =>
    (await db
      .update(proposal)
      .set({ ...fields, decided_at: new Date().toISOString() })
      .where(eq(proposal.id, id))
      .returning()
      .get()) ?? null

  // ---- Notifications -----------------------------------------------------
  const createNotification = async (n: NewNotification): Promise<void> => {
    await db.insert(notification).values(n).run()
  }
  const listNotifications = async (userId: string, limit: number): Promise<NotificationRecord[]> =>
    db
      .select()
      .from(notification)
      .where(eq(notification.user_id, userId))
      .orderBy(desc(notification.created_at))
      .limit(limit)
      .all()
  const unreadNotificationCount = async (userId: string): Promise<number> =>
    (
      await db
        .select({ n: count() })
        .from(notification)
        .where(and(eq(notification.user_id, userId), eq(notification.read, 0)))
        .get()
    )?.n ?? 0
  const markNotificationsRead = async (userId: string, ids: string[] | "all"): Promise<void> => {
    const where =
      ids === "all"
        ? eq(notification.user_id, userId)
        : ids.length > 0
          ? and(eq(notification.user_id, userId), inArray(notification.id, ids))
          : null
    if (!where) return
    await db.update(notification).set({ read: 1 }).where(where).run()
  }

  // ---- Agents + pull inbox -----------------------------------------------
  const createAgent = async (a: NewAgent): Promise<AgentRecord> =>
    (await db.insert(agent).values(a).returning().get()) as AgentRecord
  const listAgents = async (orgId: string): Promise<AgentRecord[]> =>
    db.select().from(agent).where(eq(agent.org_id, orgId)).all()
  const getAgentByToken = async (token: string): Promise<AgentRecord | null> =>
    (await db.select().from(agent).where(eq(agent.token, token)).get()) ?? null
  const deleteAgent = async (id: string, orgId: string): Promise<void> => {
    await db
      .delete(agent)
      .where(and(eq(agent.id, id), eq(agent.org_id, orgId)))
      .run()
  }
  const createAgentMention = async (m: NewAgentMention): Promise<void> => {
    await db.insert(agentMention).values(m).run()
  }
  const listPendingAgentMentions = async (
    agentId: string,
    limit: number,
  ): Promise<AgentMentionRecord[]> =>
    db
      .select()
      .from(agentMention)
      .where(and(eq(agentMention.agent_id, agentId), eq(agentMention.state, "pending")))
      .orderBy(asc(agentMention.created_at))
      .limit(limit)
      .all()
  const ackAgentMention = async (agentId: string, id: string): Promise<boolean> => {
    const res = (await db
      .update(agentMention)
      .set({ state: "done" })
      .where(and(eq(agentMention.id, id), eq(agentMention.agent_id, agentId)))
      .run()) as RunResult
    return (res.changes ?? res.meta?.changes ?? 0) > 0
  }

  // ---- Moderation: reports + audit log -----------------------------------
  const createReport = async (r: NewReport): Promise<ReportRecord> =>
    (await db.insert(report).values(r).returning().get()) as ReportRecord
  const getReport = async (id: string, orgId?: string): Promise<ReportRecord | null> =>
    (await db
      .select()
      .from(report)
      .where(and(eq(report.id, id), orgId ? eq(report.org_id, orgId) : undefined))
      .get()) ?? null
  const listReports = async (
    orgId: string | undefined,
    opts?: { state?: ReportState; limit?: number },
  ): Promise<ReportRecord[]> => {
    const q = db
      .select()
      .from(report)
      .where(
        and(
          orgId ? eq(report.org_id, orgId) : undefined,
          opts?.state ? eq(report.state, opts.state) : undefined,
        ),
      )
      .orderBy(desc(report.created_at))
    return (opts?.limit ? q.limit(opts.limit) : q).all()
  }
  const countOpenReports = async (orgId: string | undefined): Promise<number> =>
    (
      await db
        .select({ n: count() })
        .from(report)
        .where(and(eq(report.state, "open"), orgId ? eq(report.org_id, orgId) : undefined))
        .get()
    )?.n ?? 0
  const setReportState = async (id: string, state: ReportState, orgId?: string): Promise<void> => {
    await db
      .update(report)
      .set({ state })
      .where(and(eq(report.id, id), orgId ? eq(report.org_id, orgId) : undefined))
      .run()
  }
  const createAuditLog = async (a: NewAuditLog): Promise<void> => {
    await db.insert(auditLog).values(a).run()
  }
  const listAuditLog = async (
    orgId: string | undefined,
    opts?: { artifactId?: string; limit?: number },
  ): Promise<AuditLogRecord[]> => {
    const q = db
      .select()
      .from(auditLog)
      .where(
        and(
          orgId ? eq(auditLog.org_id, orgId) : undefined,
          opts?.artifactId ? eq(auditLog.artifact_id, opts.artifactId) : undefined,
        ),
      )
      .orderBy(desc(auditLog.created_at))
    return (opts?.limit ? q.limit(opts.limit) : q).all()
  }

  return {
    createArtifact,
    setVisibility,
    getByShortId,
    addVersion,
    listVersions,
    getVersion,
    listArtifacts,
    artifactIdsByTag,
    countArtifacts,
    storageBytes,
    tagCounts,
    setArtifactRemoved,
    createComment,
    getComment,
    updateComment,
    listComments,
    setThreadState,
    createWebhook,
    listWebhooks,
    getWebhook,
    deleteWebhook,
    activeWebhooks,
    enqueueDelivery,
    claimDueDeliveries,
    updateDelivery,
    recentDeliveries,
    getMembership,
    listMemberships,
    countMemberships,
    setMembership,
    removeMembership,
    getWorkspace,
    setWorkspace,
    deleteWorkspace,
    listWorkspaces,
    getArtifactMember,
    listArtifactMembers,
    setArtifactMember,
    removeArtifactMember,
    listUserFavoriteIds,
    setFavorite,
    removeFavorite,
    tagsForArtifacts,
    setArtifactTags,
    createCollection,
    getCollection,
    updateCollection,
    deleteCollection,
    listCollections,
    collectionArtifactIds,
    collectionIdsForArtifact,
    addCollectionItem,
    removeCollectionItem,
    getCollectionMember,
    listCollectionMembers,
    setCollectionMember,
    removeCollectionMember,
    collectionRolesForArtifact,
    createRepoSource,
    getRepoSource,
    listRepoSources,
    updateRepoSourceSync,
    deleteRepoSource,
    managedArtifactIds,
    createProposal,
    getProposal,
    listProposals,
    decideProposal,
    createNotification,
    listNotifications,
    unreadNotificationCount,
    markNotificationsRead,
    createAgent,
    listAgents,
    getAgentByToken,
    deleteAgent,
    createAgentMention,
    listPendingAgentMentions,
    ackAgentMention,
    createReport,
    getReport,
    listReports,
    countOpenReports,
    setReportState,
    createAuditLog,
    listAuditLog,
  }
}

export type SqliteRepos = ReturnType<typeof makeRepos>
