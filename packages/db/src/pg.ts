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
  WebhookRecord,
  WorkspaceRecord,
} from "@dock/core"
import { and, asc, count, desc, eq, inArray, isNull, like, lt, lte, or, sql } from "drizzle-orm"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
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
  PG_SCHEMA_STATEMENTS,
  proposal,
  report,
  version,
  webhook,
  webhookDelivery,
  workspace,
} from "./pg-schema"

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
  report,
  auditLog,
}
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

  /** Connect and apply the schema (idempotent) before first use. */
  static async create(connectionString: string): Promise<PgMetaStore> {
    const pool = new Pool({ connectionString })
    for (const stmt of PG_SCHEMA_STATEMENTS) await pool.query(stmt)
    return new PgMetaStore(pool, drizzle(pool, { schema }))
  }

  async createArtifact(a: NewArtifact): Promise<ArtifactRecord> {
    await this.db.insert(artifact).values(a)
    return (await this.getByShortId(a.short_id)) as ArtifactRecord
  }

  async getByShortId(shortId: string): Promise<ArtifactRecord | null> {
    const rows = await this.db.select().from(artifact).where(eq(artifact.short_id, shortId))
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
      return rows[0]
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
    return rows[0]
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
  async countArtifacts(): Promise<number> {
    const rows = await this.db.select({ c: count() }).from(artifact)
    return Number(rows[0]?.c ?? 0)
  }
  async tagCounts(): Promise<{ tag: string; count: number }[]> {
    const rows = await this.db
      .select({ tag: artifactTag.tag, count: count() })
      .from(artifactTag)
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

  async viewStats(artifactId: string): Promise<ViewStats> {
    const cutoff = new Date(Date.now() - VIEW_WINDOW_MS).toISOString()
    const [tot, uni, perV, daily, recent] = await Promise.all([
      this.pool.query(`SELECT count(*)::int n FROM view WHERE artifact_id=$1`, [artifactId]),
      this.pool.query(`SELECT count(DISTINCT viewer)::int n FROM view WHERE artifact_id=$1`, [
        artifactId,
      ]),
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
    return rows[0]
  }
  listWebhooks(): Promise<WebhookRecord[]> {
    return this.db.select().from(webhook).orderBy(desc(webhook.created_at))
  }
  async getWebhook(id: string): Promise<WebhookRecord | null> {
    const rows = await this.db.select().from(webhook).where(eq(webhook.id, id))
    return rows[0] ?? null
  }
  async deleteWebhook(id: string): Promise<void> {
    await this.db.delete(webhook).where(eq(webhook.id, id))
  }
  activeWebhooks(artifactId: string): Promise<WebhookRecord[]> {
    return this.db
      .select()
      .from(webhook)
      .where(
        and(
          eq(webhook.active, 1),
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
    return rows[0]
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
    return rows[0]
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
    return rows[0]
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
      if (!out[r.artifact_id]) out[r.artifact_id] = []
      out[r.artifact_id].push(r.tag)
    }
    for (const k in out) out[k].sort()
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
    return rows[0]
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
  async listCollections(): Promise<(CollectionRecord & { count: number })[]> {
    const rows = await this.db.select().from(collection).orderBy(desc(collection.created_at))
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
    return rows[0]
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

  // ---- Reviews: proposed versions ----------------------------------------
  async createProposal(p: NewProposal): Promise<ProposalRecord> {
    const rows = await this.db.insert(proposal).values(p).returning()
    return rows[0]
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
        `SELECT id, email, name FROM "user" WHERE email = $1`,
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
        `SELECT id, email, name FROM "user" WHERE id IN (${ph})`,
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
    return rows[0]
  }
  listAgents(orgId: string): Promise<AgentRecord[]> {
    return this.db.select().from(agent).where(eq(agent.org_id, orgId))
  }
  async getAgentByToken(token: string): Promise<AgentRecord | null> {
    const rows = await this.db.select().from(agent).where(eq(agent.token, token))
    return rows[0] ?? null
  }
  async deleteAgent(id: string): Promise<void> {
    await this.db.delete(agent).where(eq(agent.id, id))
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
    return rows[0]
  }
  listReports(opts?: { state?: ReportState; limit?: number }): Promise<ReportRecord[]> {
    const q = this.db
      .select()
      .from(report)
      .where(opts?.state ? eq(report.state, opts.state) : undefined)
      .orderBy(desc(report.created_at))
    return opts?.limit ? q.limit(opts.limit) : q
  }
  async countOpenReports(): Promise<number> {
    const rows = await this.db.select({ n: count() }).from(report).where(eq(report.state, "open"))
    return Number(rows[0]?.n ?? 0)
  }
  async setReportState(id: string, state: ReportState): Promise<void> {
    await this.db.update(report).set({ state }).where(eq(report.id, id))
  }
  async setArtifactRemoved(id: string, removedAt: string | null): Promise<void> {
    await this.db.update(artifact).set({ removed_at: removedAt }).where(eq(artifact.id, id))
  }
  async createAuditLog(a: NewAuditLog): Promise<void> {
    await this.db.insert(auditLog).values(a)
  }
  listAuditLog(opts?: { artifactId?: string; limit?: number }): Promise<AuditLogRecord[]> {
    const q = this.db
      .select()
      .from(auditLog)
      .where(opts?.artifactId ? eq(auditLog.artifact_id, opts.artifactId) : undefined)
      .orderBy(desc(auditLog.created_at))
    return opts?.limit ? q.limit(opts.limit) : q
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
