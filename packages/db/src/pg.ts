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
  DomainStatus,
  GeneralRole,
  GitHubAppRecord,
  GitHubInstallationRecord,
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
  NewRepoSource,
  NewVersion,
  NewView,
  NewWebhook,
  NotificationRecord,
  OAuthGrant,
  ProposalRecord,
  ProposalState,
  ReportRecord,
  ReportState,
  RepoSourceRecord,
  Role,
  TakedownInput,
  UserDir,
  UserProfile,
  VersionRecord,
  ViewStats,
  Visibility,
  WebhookRecord,
  WorkspaceRecord,
} from "@dock/core"
import { and, asc, count, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm"
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
  githubApp,
  githubInstallation,
  membership,
  notification,
  PG_SCHEMA_STATEMENTS,
  proposal,
  report,
  repoSource,
  version,
  webhook,
  webhookDelivery,
  workspace,
} from "./pg-schema"
import { artifactListConditions, collectManagedIds, parseOAuthScopes } from "./repos"

const one = <T>(rows: T[]): T => {
  const r = rows[0]
  if (r === undefined) throw new Error("expected a returning row")
  return r
}

// Exported so the pg schema-conformance test can diff these defs against the
// columns PG_SCHEMA_STATEMENTS actually creates in a real Postgres.
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
  githubApp,
  githubInstallation,
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
  repoSource: true,
  githubApp: true,
  githubInstallation: true,
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
    generalRole: GeneralRole,
  ): Promise<void> {
    await this.db
      .update(artifact)
      .set({ visibility, password_hash: passwordHash, general_role: generalRole })
      .where(eq(artifact.id, artifactId))
  }

  async setLocked(artifactId: string, locked: 0 | 1): Promise<void> {
    await this.db.update(artifact).set({ locked }).where(eq(artifact.id, artifactId))
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
      await tx
        .update(artifact)
        .set({ current_version: n, current_content_type: v.content_type })
        .where(eq(artifact.id, artifactId))
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
    const conds = artifactListConditions(artifact, opts)
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
  claimDueDeliveries(now: string, limit: number, leaseUntil: string): Promise<DeliveryRecord[]> {
    // FOR UPDATE SKIP LOCKED so concurrent instances each grab a disjoint set;
    // the UPDATE then leases the rows (next_attempt_at -> future) + counts an
    // attempt, so no other tick re-selects them until the lease lapses.
    const due = this.db
      .select({ id: webhookDelivery.id })
      .from(webhookDelivery)
      .where(and(eq(webhookDelivery.status, "pending"), lte(webhookDelivery.next_attempt_at, now)))
      .orderBy(asc(webhookDelivery.next_attempt_at))
      .limit(limit)
      .for("update", { skipLocked: true })
    return this.db
      .update(webhookDelivery)
      .set({ attempts: sql`${webhookDelivery.attempts} + 1`, next_attempt_at: leaseUntil })
      .where(inArray(webhookDelivery.id, due))
      .returning()
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
  // Artifacts explicitly shared with a user (per-artifact membership) — can span
  // workspaces; drives the home's "Shared with you" section.
  async artifactIdsSharedWith(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: artifactMember.artifact_id })
      .from(artifactMember)
      .where(eq(artifactMember.user_id, userId))
    return rows.map((r) => r.id)
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

  // ---- GitHub sync sources -----------------------------------------------
  async createRepoSource(s: NewRepoSource): Promise<RepoSourceRecord> {
    const rows = await this.db.insert(repoSource).values(s).returning()
    return one(rows)
  }
  async getRepoSource(id: string, orgId?: string): Promise<RepoSourceRecord | null> {
    const rows = await this.db
      .select()
      .from(repoSource)
      .where(and(eq(repoSource.id, id), orgId ? eq(repoSource.org_id, orgId) : undefined))
    return rows[0] ?? null
  }
  async listRepoSources(orgId: string): Promise<RepoSourceRecord[]> {
    return this.db
      .select()
      .from(repoSource)
      .where(eq(repoSource.org_id, orgId))
      .orderBy(desc(repoSource.created_at))
  }
  async updateRepoSourceSync(
    id: string,
    fields: { files: string; last_synced_at: string; last_status: string },
  ): Promise<void> {
    await this.db.update(repoSource).set(fields).where(eq(repoSource.id, id))
  }
  async deleteRepoSource(id: string, orgId: string): Promise<void> {
    await this.db.delete(repoSource).where(and(eq(repoSource.id, id), eq(repoSource.org_id, orgId)))
  }
  async managedArtifactIds(orgId: string): Promise<string[]> {
    const rows = await this.db
      .select({ files: repoSource.files })
      .from(repoSource)
      .where(eq(repoSource.org_id, orgId))
    return collectManagedIds(rows)
  }
  async listRepoSourcesByInstallation(installationId: string): Promise<RepoSourceRecord[]> {
    return this.db
      .select()
      .from(repoSource)
      .where(eq(repoSource.installation_id, installationId))
      .orderBy(desc(repoSource.created_at))
  }

  // ---- GitHub App (instance credentials + per-workspace installations) -----
  async getGithubApp(): Promise<GitHubAppRecord | null> {
    const rows = await this.db.select().from(githubApp).where(eq(githubApp.id, "default"))
    return rows[0] ?? null
  }
  async setGithubApp(a: GitHubAppRecord): Promise<void> {
    const { id: _id, created_at: _created, ...set } = a
    await this.db.insert(githubApp).values(a).onConflictDoUpdate({ target: githubApp.id, set })
  }
  async upsertGithubInstallation(i: GitHubInstallationRecord): Promise<GitHubInstallationRecord> {
    const rows = await this.db
      .insert(githubInstallation)
      .values(i)
      .onConflictDoUpdate({
        target: githubInstallation.installation_id,
        set: { org_id: i.org_id, account_login: i.account_login, created_by: i.created_by },
      })
      .returning()
    return one(rows)
  }
  async getGithubInstallation(installationId: string): Promise<GitHubInstallationRecord | null> {
    const rows = await this.db
      .select()
      .from(githubInstallation)
      .where(eq(githubInstallation.installation_id, installationId))
    return rows[0] ?? null
  }
  async listGithubInstallations(orgId: string): Promise<GitHubInstallationRecord[]> {
    return this.db
      .select()
      .from(githubInstallation)
      .where(eq(githubInstallation.org_id, orgId))
      .orderBy(desc(githubInstallation.created_at))
  }
  async deleteGithubInstallation(installationId: string): Promise<void> {
    await this.db
      .delete(githubInstallation)
      .where(eq(githubInstallation.installation_id, installationId))
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
  async getWorkspaceDomains(orgId: string): Promise<DomainRecord[]> {
    return this.db
      .select()
      .from(domain)
      .where(and(eq(domain.org_id, orgId), isNull(domain.artifact_id)))
  }
  async updateDomain(
    host: string,
    fields: { status?: DomainStatus; verification?: string | null },
  ): Promise<DomainRecord | null> {
    const rows = await this.db.update(domain).set(fields).where(eq(domain.host, host)).returning()
    return rows[0] ?? null
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
        `SELECT id, email, name, image, username, profession, about FROM "user" WHERE id IN (${ph})`,
        ids,
      )
      return rows as UserDir[]
    } catch {
      return []
    }
  }
  async getUserByUsername(username: string): Promise<UserProfile | null> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, name, image, username, profession, about FROM "user" WHERE username = $1`,
        [username],
      )
      return (rows[0] as UserProfile) ?? null
    } catch {
      return null
    }
  }
  async setUsername(userId: string, username: string): Promise<"ok" | "taken"> {
    // Handles are stored lowercased, so a plain equality check finds the holder.
    const { rows } = await this.pool.query(`SELECT id FROM "user" WHERE username = $1`, [username])
    const holder = rows[0] as { id: string } | undefined
    if (holder && holder.id !== userId) return "taken"
    try {
      await this.pool.query(`UPDATE "user" SET username = $1 WHERE id = $2`, [username, userId])
      return "ok"
    } catch {
      // Unique-index race: claimed between the check and the write.
      return "taken"
    }
  }
  async setUserImage(userId: string, image: string): Promise<void> {
    await this.pool.query(`UPDATE "user" SET image = $1 WHERE id = $2`, [image, userId])
  }
  async setUserDiscoverable(userId: string, discoverable: boolean): Promise<void> {
    await this.pool.query(`UPDATE "user" SET discoverable = $1 WHERE id = $2`, [
      discoverable,
      userId,
    ])
  }
  async setUserProfile(
    userId: string,
    fields: { profession?: string | null; about?: string | null },
  ): Promise<void> {
    // Patch only the fields provided (undefined = leave as-is; null = clear).
    const sets: string[] = []
    const args: (string | null)[] = []
    if (fields.profession !== undefined) {
      args.push(fields.profession)
      sets.push(`profession = $${args.length}`)
    }
    if (fields.about !== undefined) {
      args.push(fields.about)
      sets.push(`about = $${args.length}`)
    }
    if (sets.length === 0) return
    args.push(userId)
    await this.pool.query(`UPDATE "user" SET ${sets.join(", ")} WHERE id = $${args.length}`, args)
  }
  async searchDiscoverableUsers(q: string, limit: number): Promise<UserProfile[]> {
    const s = q.trim()
    if (!s) return []
    try {
      const like = `%${s}%`
      const { rows } = await this.pool.query(
        // discoverable IS NOT FALSE → true OR unset(null) both match (on by
        // default); only an explicit false (opted out) is excluded.
        `SELECT id, name, image, username, profession, about FROM "user"
         WHERE discoverable IS NOT FALSE AND username IS NOT NULL
           AND (username ILIKE $1 OR name ILIKE $1)
         ORDER BY username LIMIT $2`,
        [like, limit],
      )
      return rows as UserProfile[]
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
  async getOAuthGrant(tokenHash: string): Promise<OAuthGrant | null> {
    // Better Auth oauth-provider tables live in the same pg database; quoted
    // identifiers preserve their camelCase. The hash is bound ($1), not inlined.
    type GrantRow = {
      user_id: string
      user_email: string
      user_name: string | null
      client_id: string
      scopes: string | null
      expires_at: Date | string | number
      client_name: string
    }
    let row: GrantRow | undefined
    try {
      const { rows } = await this.pool.query(
        `SELECT t."userId" AS user_id, t."clientId" AS client_id, t."scopes" AS scopes,
                t."expiresAt" AS expires_at, c."name" AS client_name,
                u."email" AS user_email, u."name" AS user_name
           FROM "oauthAccessToken" t
           JOIN "oauthClient" c ON c."clientId" = t."clientId"
           JOIN "user" u ON u."id" = t."userId"
          WHERE t."token" = $1 LIMIT 1`,
        [tokenHash],
      )
      row = rows[0] as GrantRow | undefined
    } catch {
      // OAuth tables absent (oidc-provider not migrated) or query error: no grant.
      return null
    }
    if (!row) return null
    return {
      userId: row.user_id,
      userEmail: row.user_email,
      userName: row.user_name,
      clientId: row.client_id,
      clientName: row.client_name,
      scopes: parseOAuthScopes(row.scopes),
      expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
    }
  }
  async getOAuthClientName(clientId: string): Promise<string | null> {
    try {
      const { rows } = await this.pool.query(
        `SELECT "name" AS name FROM "oauthClient" WHERE "clientId" = $1 LIMIT 1`,
        [clientId],
      )
      return (rows[0] as { name?: string | null } | undefined)?.name ?? null
    } catch {
      return null
    }
  }
  async pruneStaleOAuthClients(cutoffIso: string): Promise<number> {
    try {
      const res = await this.pool.query(
        `DELETE FROM "oauthClient" WHERE "userId" IS NULL AND "createdAt" < $1
           AND "clientId" NOT IN (SELECT "clientId" FROM "oauthConsent")
           AND "clientId" NOT IN (SELECT "clientId" FROM "oauthAccessToken")`,
        [cutoffIso],
      )
      return res.rowCount ?? 0
    } catch {
      return 0
    }
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
  async setArtifactTitle(id: string, title: string): Promise<void> {
    await this.db.update(artifact).set({ title }).where(eq(artifact.id, id))
  }
  async setArtifactSourcePath(id: string, sourcePath: string | null): Promise<void> {
    await this.db.update(artifact).set({ source_path: sourcePath }).where(eq(artifact.id, id))
  }
  async createAuditLog(a: NewAuditLog): Promise<void> {
    await this.db.insert(auditLog).values(a)
  }
  // Atomic delete: all FK-dependent rows and the artifact row commit together.
  async deleteArtifact(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(version).where(eq(version.artifact_id, id))
      await tx.delete(comment).where(eq(comment.artifact_id, id))
      await tx.delete(artifactMember).where(eq(artifactMember.artifact_id, id))
      await tx.delete(artifactFavorite).where(eq(artifactFavorite.artifact_id, id))
      await tx.delete(artifactTag).where(eq(artifactTag.artifact_id, id))
      await tx.delete(collectionItem).where(eq(collectionItem.artifact_id, id))
      await tx.delete(domain).where(eq(domain.artifact_id, id))
      await tx.delete(proposal).where(eq(proposal.artifact_id, id))
      await tx.delete(report).where(eq(report.artifact_id, id))
      await tx.delete(notification).where(eq(notification.artifact_id, id))
      await tx.delete(agentMention).where(eq(agentMention.artifact_id, id))
      await tx.delete(artifact).where(eq(artifact.id, id))
    })
  }

  // Atomic takedown: tombstone + bulk open-report resolution + audit entry in one
  // transaction, so a failure mid-way rolls back instead of leaving a half-applied
  // takedown. The single bulk UPDATE replaces the route's per-report loop (N+1).
  async takedownArtifact(input: TakedownInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(artifact)
        .set({ removed_at: input.removedAt })
        .where(eq(artifact.id, input.artifactId))
      await tx
        .update(report)
        .set({ state: "actioned" })
        .where(
          and(
            eq(report.artifact_id, input.artifactId),
            eq(report.org_id, input.orgId),
            eq(report.state, "open"),
          ),
        )
      await tx.insert(auditLog).values(input.audit)
    })
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
