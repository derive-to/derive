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
  DomainRecord,
  ListArtifactsOpts,
  MembershipRecord,
  MetaStore,
  NewAgent,
  NewAgentMention,
  NewArtifact,
  NewArtifactMember,
  NewAuditLog,
  NewCollection,
  NewCollectionMember,
  NewComment,
  NewDelivery,
  NewDomain,
  NewMembership,
  NewNotification,
  NewProposal,
  NewReport,
  NewVersion,
  NewView,
  NewWebhook,
  NotificationRecord,
  ProposalRecord,
  ProposalState,
  ReportRecord,
  ReportState,
  Role,
  UserDir,
  VersionRecord,
  ViewStats,
  Visibility,
  WebhookRecord,
  WorkspaceRecord,
} from "@dock/core"
import { and, asc, count, desc, eq, inArray, isNull, like, lt, lte, or, sql } from "drizzle-orm"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
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
  domain,
  membership,
  notification,
  PG_SCHEMA_STATEMENTS,
  proposal,
  report,
  version,
  webhook,
  webhookDelivery,
  workspace,
} from "./pg-schema"

const one = <T>(rows: T[]): T => {
  const r = rows[0]
  if (r === undefined) throw new Error("expected a returning row")
  return r
}

const schema = {
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
  domain,
  report,
  auditLog,
}

// Compile-time schema parity (see ./parity), same classification as the sqlite
// dialect but checking the pg `$inferSelect` shapes. New table not classified, or
// a pg column that drifts from its core Record → compile error here.
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
  domain: true,
  report: true,
  auditLog: true,
}
void _schemaExhaustive
void _schemaShapes

const VIEW_WINDOW_MS = 30 * 86400_000

/**
 * Postgres metadata store (Neon, RDS, self-hosted) for horizontal scale — the
 * container is stateless and many instances share one database. CRUD goes
 * through the drizzle query builder against the pg-dialect schema (one table
 * definition, dialect-correct SQL generated for us); the analytics aggregations
 * stay raw `pool.query` where GROUP BY / DISTINCT read clearer.
 */
export class PgMetaStore implements MetaStore {
  private constructor(
    private pool: Pool,
    private db: NodePgDatabase<typeof schema>,
  ) {}

  /** Connect and apply the schema (idempotent) before first use. `onError` is
   *  invoked for idle-pool errors: a DB restart / network blip emits an `'error'`
   *  on the pool, and without a listener node-postgres turns it into an unhandled
   *  exception that crashes the whole process. */
  static async create(
    connectionString: string,
    onError?: (err: Error) => void,
  ): Promise<PgMetaStore> {
    const pool = new Pool({
      connectionString,
      // Bound how long a query / connection acquisition can hang, so a stuck query
      // can't pin a connection indefinitely and exhaust the pool.
      statement_timeout: 30_000,
      connectionTimeoutMillis: 10_000,
    })
    pool.on("error", (err) => onError?.(err))
    for (const stmt of PG_SCHEMA_STATEMENTS) await pool.query(stmt)
    return new PgMetaStore(pool, drizzle(pool, { schema }))
  }

  async createArtifact(a: NewArtifact): Promise<ArtifactRecord> {
    await this.db.insert(artifact).values(a)
    return (await this.getByShortId(a.short_id)) as ArtifactRecord
  }

  async setVisibility(
    artifactId: string,
    visibility: Visibility,
    passwordHash: string | null,
  ): Promise<void> {
    await this.db
      .update(artifact)
      .set({ visibility, password_hash: passwordHash })
      .where(eq(artifact.id, artifactId))
  }

  async getByShortId(shortId: string): Promise<ArtifactRecord | null> {
    const rows = await this.db.select().from(artifact).where(eq(artifact.short_id, shortId))
    return rows[0] ?? null
  }
  async getArtifactById(id: string): Promise<ArtifactRecord | null> {
    const rows = await this.db.select().from(artifact).where(eq(artifact.id, id))
    return rows[0] ?? null
  }

  async addVersion(artifactId: string, v: NewVersion): Promise<VersionRecord> {
    return this.db.transaction(async (tx) => {
      const cur = await tx
        .select({ cv: artifact.current_version })
        .from(artifact)
        .where(eq(artifact.id, artifactId))
        .for("update")
      if (!cur[0]) throw new Error(`artifact not found: ${artifactId}`)
      const n = cur[0].cv + 1
      await tx.insert(version).values({ ...v, artifact_id: artifactId, n })
      await tx.update(artifact).set({ current_version: n }).where(eq(artifact.id, artifactId))
      const rows = await tx
        .select()
        .from(version)
        .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
      return one(rows)
    })
  }

  listVersions(artifactId: string): Promise<VersionRecord[]> {
    return this.db
      .select()
      .from(version)
      .where(eq(version.artifact_id, artifactId))
      .orderBy(asc(version.n))
  }

  async getVersion(artifactId: string, n: number): Promise<VersionRecord | null> {
    const rows = await this.db
      .select()
      .from(version)
      .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
    return rows[0] ?? null
  }

  async createComment(c: NewComment): Promise<CommentRecord> {
    const rows = await this.db.insert(comment).values(c).returning()
    return one(rows)
  }

  async getComment(id: string): Promise<CommentRecord | null> {
    const rows = await this.db.select().from(comment).where(eq(comment.id, id))
    return rows[0] ?? null
  }

  async updateComment(
    id: string,
    fields: { body_md?: string; meta?: string | null },
  ): Promise<CommentRecord | null> {
    const rows = await this.db.update(comment).set(fields).where(eq(comment.id, id)).returning()
    return rows[0] ?? null
  }

  listComments(artifactId: string, opts?: { state?: CommentState }): Promise<CommentRecord[]> {
    const where = opts?.state
      ? and(eq(comment.artifact_id, artifactId), eq(comment.state, opts.state))
      : eq(comment.artifact_id, artifactId)
    return this.db.select().from(comment).where(where).orderBy(asc(comment.created_at))
  }

  async setThreadState(artifactId: string, threadId: string, state: CommentState): Promise<number> {
    const rows = await this.db
      .update(comment)
      .set({ state })
      .where(and(eq(comment.artifact_id, artifactId), eq(comment.thread_id, threadId)))
      .returning({ id: comment.id })
    return rows.length
  }

  listArtifacts(opts?: ListArtifactsOpts): Promise<ArtifactRecord[]> {
    if (opts?.ids && opts.ids.length === 0) return Promise.resolve([])
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
    const q = this.db
      .select()
      .from(artifact)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(artifact.created_at), desc(artifact.id))
    return opts?.limit ? q.limit(opts.limit) : q
  }
  async artifactIdsByTag(tag: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: artifactTag.artifact_id })
      .from(artifactTag)
      .where(eq(artifactTag.tag, tag))
    return rows.map((r) => r.id)
  }
  async countArtifacts(orgId?: string): Promise<number> {
    const q = this.db.select({ c: count() }).from(artifact)
    const rows = await (orgId ? q.where(eq(artifact.org_id, orgId)) : q)
    return Number(rows[0]?.c ?? 0)
  }
  async storageBytes(orgId: string): Promise<number> {
    // One row per distinct blob in the org (max size_bytes guards a stale 0 on a
    // restored row), then summed — so dedup'd content is counted once.
    const perBlob = this.db
      .select({ mx: sql<number>`max(${version.size_bytes})`.as("mx") })
      .from(version)
      .innerJoin(artifact, eq(artifact.id, version.artifact_id))
      .where(eq(artifact.org_id, orgId))
      .groupBy(version.blob_key)
      .as("per_blob")
    const rows = await this.db
      .select({ s: sql<number>`coalesce(sum(${perBlob.mx}), 0)` })
      .from(perBlob)
    return Number(rows[0]?.s ?? 0)
  }
  async tagCounts(orgId?: string): Promise<{ tag: string; count: number }[]> {
    const base = this.db
      .select({ tag: artifactTag.tag, count: count() })
      .from(artifactTag)
      .innerJoin(artifact, eq(artifact.id, artifactTag.artifact_id))
    const rows = await (orgId ? base.where(eq(artifact.org_id, orgId)) : base)
      .groupBy(artifactTag.tag)
      .orderBy(asc(artifactTag.tag))
    return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }))
  }

  // ---- View analytics (raw: aggregation-heavy) ---------------------------
  async recordView(v: NewView): Promise<void> {
    await this.pool.query(
      `INSERT INTO view (id, artifact_id, version, viewer, viewer_kind) VALUES ($1,$2,$3,$4,$5)`,
      [v.id, v.artifact_id, v.version, v.viewer, v.viewer_kind],
    )
  }

  async viewedSince(
    artifactId: string,
    viewer: string,
    version: number,
    sinceIso: string,
  ): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM view WHERE artifact_id=$1 AND viewer=$2 AND version=$3 AND created_at>=$4 LIMIT 1`,
      [artifactId, viewer, version, sinceIso],
    )
    return rows.length > 0
  }

  async pruneViews(cutoffIso: string): Promise<number> {
    const res = await this.pool.query(`DELETE FROM view WHERE created_at < $1`, [cutoffIso])
    return res.rowCount ?? 0
  }

  async pruneViewsByViewers(viewers: string[]): Promise<number> {
    if (viewers.length === 0) return 0
    const ph = viewers.map((_, i) => `$${i + 1}`).join(",")
    const res = await this.pool.query(
      `DELETE FROM view WHERE viewer_kind='user' AND viewer IN (${ph})`,
      viewers,
    )
    return res.rowCount ?? 0
  }

  async viewStats(artifactId: string): Promise<ViewStats> {
    const cutoff = new Date(Date.now() - VIEW_WINDOW_MS).toISOString()
    const [tot, uni, anon, perV, daily, recent] = await Promise.all([
      this.pool.query(`SELECT count(*)::int n FROM view WHERE artifact_id=$1`, [artifactId]),
      this.pool.query(`SELECT count(DISTINCT viewer)::int n FROM view WHERE artifact_id=$1`, [
        artifactId,
      ]),
      this.pool.query(
        `SELECT count(DISTINCT viewer)::int n FROM view WHERE artifact_id=$1 AND viewer_kind='anon'`,
        [artifactId],
      ),
      this.pool.query(
        `SELECT version, count(*)::int c FROM view WHERE artifact_id=$1 GROUP BY version ORDER BY version`,
        [artifactId],
      ),
      this.pool.query(
        `SELECT substr(created_at,1,10) AS "day", count(*)::int c FROM view WHERE artifact_id=$1 AND created_at>=$2 GROUP BY 1 ORDER BY 1`,
        [artifactId, cutoff],
      ),
      this.pool.query(
        `SELECT viewer, viewer_kind, max(created_at) "at" FROM view WHERE artifact_id=$1 GROUP BY viewer, viewer_kind ORDER BY 3 DESC LIMIT 8`,
        [artifactId],
      ),
    ])
    return {
      total: tot.rows[0].n,
      unique: uni.rows[0].n,
      anonViewers: anon.rows[0].n,
      perVersion: perV.rows.map((r) => ({ version: r.version, count: r.c })),
      daily: daily.rows.map((r) => ({ day: r.day, count: r.c })),
      recent: recent.rows.map((r) => ({ viewer: r.viewer, kind: r.viewer_kind, at: r.at })),
    }
  }

  async viewCounts(artifactIds: string[]): Promise<Record<string, number>> {
    if (artifactIds.length === 0) return {}
    const ph = artifactIds.map((_, i) => `$${i + 1}`).join(",")
    const { rows } = await this.pool.query(
      `SELECT artifact_id, count(*)::int c FROM view WHERE artifact_id IN (${ph}) GROUP BY artifact_id`,
      artifactIds,
    )
    const out: Record<string, number> = {}
    for (const r of rows) out[r.artifact_id] = r.c
    return out
  }

  // ---- Webhooks + outbox -------------------------------------------------
  async createWebhook(w: NewWebhook): Promise<WebhookRecord> {
    const rows = await this.db.insert(webhook).values(w).returning()
    return one(rows)
  }
  listWebhooks(orgId: string): Promise<WebhookRecord[]> {
    return this.db
      .select()
      .from(webhook)
      .where(eq(webhook.org_id, orgId))
      .orderBy(desc(webhook.created_at))
  }
  async getWebhook(id: string, orgId: string): Promise<WebhookRecord | null> {
    const rows = await this.db
      .select()
      .from(webhook)
      .where(and(eq(webhook.id, id), eq(webhook.org_id, orgId)))
    return rows[0] ?? null
  }
  async deleteWebhook(id: string, orgId: string): Promise<void> {
    await this.db.delete(webhook).where(and(eq(webhook.id, id), eq(webhook.org_id, orgId)))
  }
  activeWebhooks(artifactId: string, orgId: string): Promise<WebhookRecord[]> {
    return this.db
      .select()
      .from(webhook)
      .where(
        and(
          eq(webhook.active, 1),
          eq(webhook.org_id, orgId),
          or(isNull(webhook.artifact_id), eq(webhook.artifact_id, artifactId)),
        ),
      )
  }
  async enqueueDelivery(d: NewDelivery): Promise<void> {
    await this.db.insert(webhookDelivery).values(d)
  }
  claimDueDeliveries(now: string, limit: number): Promise<DeliveryRecord[]> {
    return this.db
      .select()
      .from(webhookDelivery)
      .where(and(eq(webhookDelivery.status, "pending"), lte(webhookDelivery.next_attempt_at, now)))
      .orderBy(asc(webhookDelivery.next_attempt_at))
      .limit(limit)
  }
  async updateDelivery(
    id: string,
    f: {
      status: DeliveryStatus
      attempts: number
      last_error: string | null
      next_attempt_at: string
    },
  ): Promise<void> {
    await this.db.update(webhookDelivery).set(f).where(eq(webhookDelivery.id, id))
  }
  recentDeliveries(webhookId: string, limit: number): Promise<DeliveryRecord[]> {
    return this.db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.webhook_id, webhookId))
      .orderBy(desc(webhookDelivery.created_at))
      .limit(limit)
  }

  // ---- Permissions: membership + per-artifact shares ---------------------
  async getMembership(orgId: string, userId: string): Promise<MembershipRecord | null> {
    const rows = await this.db
      .select()
      .from(membership)
      .where(and(eq(membership.org_id, orgId), eq(membership.user_id, userId)))
    return rows[0] ?? null
  }
  listMemberships(orgId: string): Promise<MembershipRecord[]> {
    return this.db.select().from(membership).where(eq(membership.org_id, orgId))
  }
  async countMemberships(orgId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(membership)
      .where(eq(membership.org_id, orgId))
    return rows[0]?.n ?? 0
  }
  async setMembership(m: NewMembership): Promise<MembershipRecord> {
    const rows = await this.db
      .insert(membership)
      .values(m)
      .onConflictDoUpdate({
        target: [membership.org_id, membership.user_id],
        set: { role: m.role },
      })
      .returning()
    return one(rows)
  }
  async removeMembership(orgId: string, userId: string): Promise<void> {
    await this.db
      .delete(membership)
      .where(and(eq(membership.org_id, orgId), eq(membership.user_id, userId)))
  }
  async getWorkspace(orgId: string): Promise<WorkspaceRecord | null> {
    const rows = await this.db.select().from(workspace).where(eq(workspace.id, orgId))
    return rows[0] ?? null
  }
  async setWorkspace(orgId: string, name: string): Promise<WorkspaceRecord> {
    const rows = await this.db
      .insert(workspace)
      .values({ id: orgId, name })
      .onConflictDoUpdate({ target: workspace.id, set: { name } })
      .returning()
    return one(rows)
  }
  async deleteWorkspace(orgId: string): Promise<void> {
    await this.db.delete(membership).where(eq(membership.org_id, orgId))
    await this.db.delete(workspace).where(eq(workspace.id, orgId))
  }
  listWorkspaces(userId: string): Promise<(WorkspaceRecord & { role: Role })[]> {
    return this.db
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
  }

  async getArtifactMember(
    artifactId: string,
    userId: string,
  ): Promise<ArtifactMemberRecord | null> {
    const rows = await this.db
      .select()
      .from(artifactMember)
      .where(and(eq(artifactMember.artifact_id, artifactId), eq(artifactMember.user_id, userId)))
    return rows[0] ?? null
  }
  listArtifactMembers(artifactId: string): Promise<ArtifactMemberRecord[]> {
    return this.db.select().from(artifactMember).where(eq(artifactMember.artifact_id, artifactId))
  }
  async setArtifactMember(m: NewArtifactMember): Promise<ArtifactMemberRecord> {
    const rows = await this.db
      .insert(artifactMember)
      .values(m)
      .onConflictDoUpdate({
        target: [artifactMember.artifact_id, artifactMember.user_id],
        set: { role: m.role },
      })
      .returning()
    return one(rows)
  }
  async removeArtifactMember(artifactId: string, userId: string): Promise<void> {
    await this.db
      .delete(artifactMember)
      .where(and(eq(artifactMember.artifact_id, artifactId), eq(artifactMember.user_id, userId)))
  }

  // ---- Favorites + tags --------------------------------------------------
  async listUserFavoriteIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: artifactFavorite.artifact_id })
      .from(artifactFavorite)
      .where(eq(artifactFavorite.user_id, userId))
    return rows.map((r) => r.id)
  }
  async setFavorite(artifactId: string, userId: string): Promise<void> {
    await this.db
      .insert(artifactFavorite)
      .values({ id: crypto.randomUUID(), artifact_id: artifactId, user_id: userId })
      .onConflictDoNothing({ target: [artifactFavorite.artifact_id, artifactFavorite.user_id] })
  }
  async removeFavorite(artifactId: string, userId: string): Promise<void> {
    await this.db
      .delete(artifactFavorite)
      .where(
        and(eq(artifactFavorite.artifact_id, artifactId), eq(artifactFavorite.user_id, userId)),
      )
  }
  async tagsForArtifacts(artifactIds: string[]): Promise<Record<string, string[]>> {
    if (artifactIds.length === 0) return {}
    const rows = await this.db
      .select({ artifact_id: artifactTag.artifact_id, tag: artifactTag.tag })
      .from(artifactTag)
      .where(inArray(artifactTag.artifact_id, artifactIds))
    const out: Record<string, string[]> = {}
    for (const r of rows) {
      out[r.artifact_id] ??= []
      out[r.artifact_id]?.push(r.tag)
    }
    for (const k in out) out[k]?.sort()
    return out
  }
  async setArtifactTags(artifactId: string, tags: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(artifactTag).where(eq(artifactTag.artifact_id, artifactId))
      if (tags.length)
        await tx
          .insert(artifactTag)
          .values(tags.map((tag) => ({ id: crypto.randomUUID(), artifact_id: artifactId, tag })))
    })
  }

  // ---- Collections -------------------------------------------------------
  async createCollection(c: NewCollection): Promise<CollectionRecord> {
    const rows = await this.db.insert(collection).values(c).returning()
    return one(rows)
  }
  async getCollection(id: string): Promise<CollectionRecord | null> {
    const rows = await this.db.select().from(collection).where(eq(collection.id, id))
    return rows[0] ?? null
  }
  async updateCollection(id: string, fields: { title?: string }): Promise<CollectionRecord | null> {
    if (fields.title === undefined) return this.getCollection(id)
    const rows = await this.db
      .update(collection)
      .set({ title: fields.title })
      .where(eq(collection.id, id))
      .returning()
    return rows[0] ?? null
  }
  async deleteCollection(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(collectionItem).where(eq(collectionItem.collection_id, id))
      await tx.delete(collectionMember).where(eq(collectionMember.collection_id, id))
      await tx.delete(collection).where(eq(collection.id, id))
    })
  }
  async listCollections(orgId?: string): Promise<(CollectionRecord & { count: number })[]> {
    const base = this.db.select().from(collection)
    const rows = await (orgId ? base.where(eq(collection.org_id, orgId)) : base).orderBy(
      desc(collection.created_at),
    )
    const counts = await this.db
      .select({ id: collectionItem.collection_id, c: count() })
      .from(collectionItem)
      .groupBy(collectionItem.collection_id)
    const cmap = new Map(counts.map((r) => [r.id, Number(r.c)]))
    return rows.map((r) => ({ ...r, count: cmap.get(r.id) ?? 0 }))
  }
  async collectionArtifactIds(collectionId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: collectionItem.artifact_id })
      .from(collectionItem)
      .where(eq(collectionItem.collection_id, collectionId))
    return rows.map((r) => r.id)
  }
  async collectionIdsForArtifact(artifactId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: collectionItem.collection_id })
      .from(collectionItem)
      .where(eq(collectionItem.artifact_id, artifactId))
    return rows.map((r) => r.id)
  }
  async addCollectionItem(collectionId: string, artifactId: string): Promise<void> {
    await this.db
      .insert(collectionItem)
      .values({ id: crypto.randomUUID(), collection_id: collectionId, artifact_id: artifactId })
      .onConflictDoNothing({ target: [collectionItem.collection_id, collectionItem.artifact_id] })
  }
  async removeCollectionItem(collectionId: string, artifactId: string): Promise<void> {
    await this.db
      .delete(collectionItem)
      .where(
        and(
          eq(collectionItem.collection_id, collectionId),
          eq(collectionItem.artifact_id, artifactId),
        ),
      )
  }
  async getCollectionMember(
    collectionId: string,
    userId: string,
  ): Promise<CollectionMemberRecord | null> {
    const rows = await this.db
      .select()
      .from(collectionMember)
      .where(
        and(eq(collectionMember.collection_id, collectionId), eq(collectionMember.user_id, userId)),
      )
    return rows[0] ?? null
  }
  listCollectionMembers(collectionId: string): Promise<CollectionMemberRecord[]> {
    return this.db
      .select()
      .from(collectionMember)
      .where(eq(collectionMember.collection_id, collectionId))
  }
  async setCollectionMember(m: NewCollectionMember): Promise<CollectionMemberRecord> {
    const rows = await this.db
      .insert(collectionMember)
      .values(m)
      .onConflictDoUpdate({
        target: [collectionMember.collection_id, collectionMember.user_id],
        set: { role: m.role },
      })
      .returning()
    return one(rows)
  }
  async removeCollectionMember(collectionId: string, userId: string): Promise<void> {
    await this.db
      .delete(collectionMember)
      .where(
        and(eq(collectionMember.collection_id, collectionId), eq(collectionMember.user_id, userId)),
      )
  }
  async collectionRolesForArtifact(artifactId: string, userId: string): Promise<Role[]> {
    const rows = await this.db
      .select({ role: collectionMember.role })
      .from(collectionMember)
      .innerJoin(collectionItem, eq(collectionItem.collection_id, collectionMember.collection_id))
      .where(and(eq(collectionItem.artifact_id, artifactId), eq(collectionMember.user_id, userId)))
    return rows.map((r) => r.role)
  }

  // ---- Domains (hostname → artifact) -------------------------------------
  async getDomain(host: string): Promise<DomainRecord | null> {
    const rows = await this.db.select().from(domain).where(eq(domain.host, host))
    return rows[0] ?? null
  }
  // Insert-only: a taken host yields no row (→ 409 in the route), so a workspace
  // can never claim a host already owned by another.
  async setDomain(d: NewDomain): Promise<DomainRecord | null> {
    const rows = await this.db.insert(domain).values(d).onConflictDoNothing().returning()
    return rows[0] ?? null
  }
  async getArtifactDomains(artifactId: string): Promise<DomainRecord[]> {
    return this.db.select().from(domain).where(eq(domain.artifact_id, artifactId))
  }
  async deleteDomain(host: string, orgId: string): Promise<void> {
    await this.db.delete(domain).where(and(eq(domain.host, host), eq(domain.org_id, orgId)))
  }

  // ---- Reviews: proposed versions ----------------------------------------
  async createProposal(p: NewProposal): Promise<ProposalRecord> {
    const rows = await this.db.insert(proposal).values(p).returning()
    return one(rows)
  }
  async getProposal(id: string): Promise<ProposalRecord | null> {
    const rows = await this.db.select().from(proposal).where(eq(proposal.id, id))
    return rows[0] ?? null
  }
  listProposals(artifactId: string, opts?: { state?: ProposalState }): Promise<ProposalRecord[]> {
    const where = opts?.state
      ? and(eq(proposal.artifact_id, artifactId), eq(proposal.state, opts.state))
      : eq(proposal.artifact_id, artifactId)
    return this.db.select().from(proposal).where(where).orderBy(desc(proposal.created_at))
  }
  async openProposalCounts(artifactIds: string[]): Promise<Record<string, number>> {
    if (artifactIds.length === 0) return {}
    const ph = artifactIds.map((_, i) => `$${i + 1}`).join(",")
    const { rows } = await this.pool.query(
      `SELECT artifact_id, count(*)::int c FROM proposal WHERE state='open' AND artifact_id IN (${ph}) GROUP BY artifact_id`,
      artifactIds,
    )
    const out: Record<string, number> = {}
    for (const r of rows) out[r.artifact_id] = r.c
    return out
  }
  async decideProposal(
    id: string,
    fields: {
      state: ProposalState
      decided_by: string | null
      decided_version: number | null
      decision_note?: string | null
    },
  ): Promise<ProposalRecord | null> {
    const rows = await this.db
      .update(proposal)
      .set({ ...fields, decided_at: new Date().toISOString() })
      .where(eq(proposal.id, id))
      .returning()
    return rows[0] ?? null
  }

  // ---- User directory (Better Auth's "user" table; raw, may be absent) ---
  async findUserByEmail(email: string): Promise<UserDir | null> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, email, name, image FROM "user" WHERE email = $1`,
        [email],
      )
      return (rows[0] as UserDir) ?? null
    } catch {
      return null
    }
  }
  async getUsers(ids: string[]): Promise<UserDir[]> {
    if (ids.length === 0) return []
    try {
      const ph = ids.map((_, i) => `$${i + 1}`).join(",")
      const { rows } = await this.pool.query(
        `SELECT id, email, name, image FROM "user" WHERE id IN (${ph})`,
        ids,
      )
      return rows as UserDir[]
    } catch {
      return []
    }
  }

  // ---- Notifications (in-app, one row per recipient) ---------------------
  async createNotification(n: NewNotification): Promise<void> {
    await this.db.insert(notification).values(n)
  }
  listNotifications(userId: string, limit: number): Promise<NotificationRecord[]> {
    return this.db
      .select()
      .from(notification)
      .where(eq(notification.user_id, userId))
      .orderBy(desc(notification.created_at))
      .limit(limit)
  }
  async unreadNotificationCount(userId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(notification)
      .where(and(eq(notification.user_id, userId), eq(notification.read, 0)))
    return rows[0]?.n ?? 0
  }
  async markNotificationsRead(userId: string, ids: string[] | "all"): Promise<void> {
    const where =
      ids === "all"
        ? eq(notification.user_id, userId)
        : ids.length > 0
          ? and(eq(notification.user_id, userId), inArray(notification.id, ids))
          : null
    if (!where) return
    await this.db.update(notification).set({ read: 1 }).where(where)
  }

  // ---- Agents + their pull inbox -----------------------------------------
  async createAgent(a: NewAgent): Promise<AgentRecord> {
    const rows = await this.db.insert(agent).values(a).returning()
    return one(rows)
  }
  listAgents(orgId: string): Promise<AgentRecord[]> {
    return this.db.select().from(agent).where(eq(agent.org_id, orgId))
  }
  async getAgentByToken(token: string): Promise<AgentRecord | null> {
    const rows = await this.db.select().from(agent).where(eq(agent.token, token))
    return rows[0] ?? null
  }
  async deleteAgent(id: string, orgId: string): Promise<void> {
    await this.db.delete(agent).where(and(eq(agent.id, id), eq(agent.org_id, orgId)))
  }
  async createAgentMention(m: NewAgentMention): Promise<void> {
    await this.db.insert(agentMention).values(m)
  }
  listPendingAgentMentions(agentId: string, limit: number): Promise<AgentMentionRecord[]> {
    return this.db
      .select()
      .from(agentMention)
      .where(and(eq(agentMention.agent_id, agentId), eq(agentMention.state, "pending")))
      .orderBy(asc(agentMention.created_at))
      .limit(limit)
  }
  async ackAgentMention(agentId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(agentMention)
      .set({ state: "done" })
      .where(and(eq(agentMention.id, id), eq(agentMention.agent_id, agentId)))
      .returning({ id: agentMention.id })
    return rows.length > 0
  }

  // ---- Moderation: reports, takedown, audit log --------------------------
  async createReport(r: NewReport): Promise<ReportRecord> {
    const rows = await this.db.insert(report).values(r).returning()
    return one(rows)
  }
  async getReport(id: string, orgId?: string): Promise<ReportRecord | null> {
    const rows = await this.db
      .select()
      .from(report)
      .where(and(eq(report.id, id), orgId ? eq(report.org_id, orgId) : undefined))
    return rows[0] ?? null
  }
  listReports(
    orgId: string | undefined,
    opts?: { state?: ReportState; limit?: number },
  ): Promise<ReportRecord[]> {
    const q = this.db
      .select()
      .from(report)
      .where(
        and(
          orgId ? eq(report.org_id, orgId) : undefined,
          opts?.state ? eq(report.state, opts.state) : undefined,
        ),
      )
      .orderBy(desc(report.created_at))
    return opts?.limit ? q.limit(opts.limit) : q
  }
  async countOpenReports(orgId: string | undefined): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(report)
      .where(and(eq(report.state, "open"), orgId ? eq(report.org_id, orgId) : undefined))
    return Number(rows[0]?.n ?? 0)
  }
  async setReportState(id: string, state: ReportState, orgId?: string): Promise<void> {
    await this.db
      .update(report)
      .set({ state })
      .where(and(eq(report.id, id), orgId ? eq(report.org_id, orgId) : undefined))
  }
  async setArtifactRemoved(id: string, removedAt: string | null): Promise<void> {
    await this.db.update(artifact).set({ removed_at: removedAt }).where(eq(artifact.id, id))
  }
  async createAuditLog(a: NewAuditLog): Promise<void> {
    await this.db.insert(auditLog).values(a)
  }
  listAuditLog(
    orgId: string | undefined,
    opts?: { artifactId?: string; limit?: number },
  ): Promise<AuditLogRecord[]> {
    const q = this.db
      .select()
      .from(auditLog)
      .where(
        and(
          orgId ? eq(auditLog.org_id, orgId) : undefined,
          opts?.artifactId ? eq(auditLog.artifact_id, opts.artifactId) : undefined,
        ),
      )
      .orderBy(desc(auditLog.created_at))
    return opts?.limit ? q.limit(opts.limit) : q
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
