import type {
  AgentMentionRecord,
  AgentRecord,
  ArtifactMemberRecord,
  ArtifactRecord,
  AuditLogRecord,
  CollectionMemberRecord,
  CollectionRecord,
  CommentListOpts,
  CommentRecord,
  CommentSignals,
  CommentState,
  ContextRecord,
  DeliveryRecord,
  DeliveryStatus,
  DomainRecord,
  DomainStatus,
  FollowKind,
  FollowRecord,
  GeneralRole,
  GitHubAppRecord,
  GitHubInstallationRecord,
  GithubAuthor,
  GithubUserMapping,
  InvitationRecord,
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
  NewContext,
  NewDelivery,
  NewDomain,
  NewFollow,
  NewInvitation,
  NewMembership,
  NewNotification,
  NewProposal,
  NewReport,
  NewRepoSource,
  NewReviewRound,
  NewSession,
  NewSessionMessage,
  NewVersion,
  NewView,
  NewWebhook,
  NotificationRecord,
  OAuthGrant,
  OAuthGrantSummary,
  OrgSettings,
  ProposalRecord,
  ProposalState,
  ReportRecord,
  ReportState,
  RepoSourceRecord,
  ReviewRoundRecord,
  ReviewRoundState,
  Role,
  SessionMessageRecord,
  SessionRecord,
  SessionState,
  SlackInstallRecord,
  SlackThreadLinkRecord,
  TakedownInput,
  UserDir,
  UserProfile,
  VersionRecord,
  ViewStats,
  Visibility,
  WebhookRecord,
  WorkspaceRecord,
} from "@derive/core"
import { DEFAULT_ORG_SETTINGS, GLOBAL_FOLLOW_ORG } from "@derive/core"
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm"
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
  context,
  contextSession,
  domain,
  follow,
  githubApp,
  githubInstallation,
  invitation,
  membership,
  notification,
  oauthClientWorkspace,
  orgSettings,
  PG_SCHEMA_STATEMENTS,
  proposal,
  report,
  repoSource,
  reviewRound,
  sessionMessage,
  slackInstall,
  slackThreadLink,
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
  follow,
  artifactTag,
  proposal,
  reviewRound,
  agent,
  agentMention,
  invitation,
  oauthClientWorkspace,
  context,
  contextSession,
  sessionMessage,
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
  follow: true,
  proposal: true,
  reviewRound: true,
  agent: true,
  agentMention: true,
  invitation: true,
  context: true,
  contextSession: true,
  sessionMessage: true,
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
    return PgMetaStore.fromPool(pool)
  }

  /** Wrap an existing pool without applying schema — the Workers path, where pools
   *  are invocation-scoped (see apps/api edge-pg.ts) and DDL runs at deploy
   *  time (apply-pg-schema.ts). */
  static fromPool(pool: Pool): PgMetaStore {
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

  async siblingsBySourcePaths(
    orgId: string,
    paths: string[],
  ): Promise<{ short_id: string; slug: string | null; source_path: string }[]> {
    if (paths.length === 0) return []
    const rows = await this.db
      .select({
        short_id: artifact.short_id,
        slug: artifact.slug,
        source_path: artifact.source_path,
      })
      .from(artifact)
      .where(
        and(
          eq(artifact.org_id, orgId),
          inArray(artifact.source_path, paths),
          isNull(artifact.removed_at),
        ),
      )
    return rows.filter((r): r is typeof r & { source_path: string } => r.source_path != null)
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
        .set({
          current_version: n,
          current_content_type: v.content_type,
          updated_at: new Date().toISOString(),
          // Denormalize the new version's author onto the artifact (its CURRENT author).
          author_name: v.author,
          author_login: v.author_login ?? null,
          author_avatar: v.author_avatar ?? null,
          author_gh_id: v.author_gh_id ?? null,
          author_id: v.author_id ?? null,
        })
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
  async reclassifyVersion(artifactId: string, n: number, contentType: string): Promise<void> {
    await this.db
      .update(version)
      .set({ content_type: contentType })
      .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
    // Keep the artifact's denormalized current_content_type in sync when the fixed
    // version is the current one (the field the viewer reads to pick render mode).
    await this.db
      .update(artifact)
      .set({ current_content_type: contentType })
      .where(and(eq(artifact.id, artifactId), eq(artifact.current_version, n)))
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
    fields: { body_md?: string; meta?: string | null; anchor?: string | null },
  ): Promise<CommentRecord | null> {
    const rows = await this.db.update(comment).set(fields).where(eq(comment.id, id)).returning()
    return rows[0] ?? null
  }

  listComments(artifactId: string, opts?: CommentListOpts): Promise<CommentRecord[]> {
    const where = and(
      eq(comment.artifact_id, artifactId),
      opts?.state ? eq(comment.state, opts.state) : undefined,
    )
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

  // Mirrors the sqlite path: mentions live in meta.mentions (JSON), matched in code.
  private commentMentionsUser(metaJson: string | null, userId: string): boolean {
    if (!metaJson) return false
    try {
      const m = JSON.parse(metaJson) as { mentions?: { id?: string }[] }
      return Array.isArray(m.mentions) && m.mentions.some((x) => x?.id === userId)
    } catch {
      return false
    }
  }

  async commentSignals(
    artifactIds: string[],
    userId: string | null,
  ): Promise<Record<string, CommentSignals>> {
    const out: Record<string, CommentSignals> = {}
    if (artifactIds.length === 0) return out
    const rows = await this.db
      .select({
        artifact_id: comment.artifact_id,
        thread_id: comment.thread_id,
        state: comment.state,
        author_id: comment.author_id,
        meta: comment.meta,
      })
      .from(comment)
      .where(inArray(comment.artifact_id, artifactIds))
    const threads: Record<string, Set<string>> = {}
    for (const r of rows) {
      if (r.state !== "open") continue
      let sig = out[r.artifact_id]
      if (!sig) {
        sig = { open_threads: 0, mentions_me: false, i_participated: false }
        out[r.artifact_id] = sig
      }
      let set = threads[r.artifact_id]
      if (!set) {
        set = new Set()
        threads[r.artifact_id] = set
      }
      set.add(r.thread_id)
      if (userId) {
        if (r.author_id === userId) sig.i_participated = true
        if (!sig.mentions_me && this.commentMentionsUser(r.meta, userId)) sig.mentions_me = true
      }
    }
    for (const [id, set] of Object.entries(threads)) {
      const sig = out[id]
      if (sig) sig.open_threads = set.size
    }
    return out
  }

  async artifactIdsNeedingFeedback(userId: string, orgId: string): Promise<string[]> {
    const rows = await this.db
      .select({
        artifact_id: comment.artifact_id,
        author_id: comment.author_id,
        meta: comment.meta,
      })
      .from(comment)
      .innerJoin(artifact, eq(artifact.id, comment.artifact_id))
      .where(and(eq(comment.state, "open"), eq(artifact.org_id, orgId)))
    const ids = new Set<string>()
    for (const r of rows) {
      if (r.author_id === userId || this.commentMentionsUser(r.meta, userId)) ids.add(r.artifact_id)
    }
    return [...ids]
  }

  listArtifacts(opts?: ListArtifactsOpts): Promise<ArtifactRecord[]> {
    if (opts?.ids && opts.ids.length === 0) return Promise.resolve([])
    const conds = artifactListConditions(artifact, opts)
    // Collection scope is a JOIN, not an `id IN (…members)` — mirrors the SQLite/D1
    // path in repos.ts so behavior matches across dialects (and never trips a param cap).
    if (opts?.collectionId) {
      conds.push(eq(collectionItem.collection_id, opts.collectionId))
      const q = this.db
        .select(getTableColumns(artifact))
        .from(artifact)
        .innerJoin(collectionItem, eq(collectionItem.artifact_id, artifact.id))
        .where(and(...conds))
        .orderBy(desc(artifact.created_at), desc(artifact.id))
      return opts.limit ? q.limit(opts.limit) : q
    }
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
  // Author filter (mirrors artifactIdsByTag + the SQLite path). Case-insensitive match
  // on the denormalized current author_login, scoped to the workspace.
  async artifactIdsByAuthor(orgId: string, login: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: artifact.id })
      .from(artifact)
      .where(
        and(
          eq(artifact.org_id, orgId),
          eq(sql`lower(${artifact.author_login})`, login.toLowerCase()),
        ),
      )
    return rows.map((r) => r.id)
  }
  // "Created by me" filter — every artifact this Derive user published by hand in
  // the workspace, regardless of visibility (mirrors the SQLite path).
  async artifactIdsByAuthorId(orgId: string, userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: artifact.id })
      .from(artifact)
      .where(and(eq(artifact.org_id, orgId), eq(artifact.author_id, userId)))
    return rows.map((r) => r.id)
  }
  async countArtifacts(orgId?: string): Promise<number> {
    const q = this.db.select({ c: count() }).from(artifact)
    const rows = await (orgId ? q.where(eq(artifact.org_id, orgId)) : q)
    return Number(rows[0]?.c ?? 0)
  }
  async countAuthoredBy(orgId: string, userId: string): Promise<number> {
    const rows = await this.db
      .select({ c: count() })
      .from(artifact)
      .where(and(eq(artifact.org_id, orgId), eq(artifact.author_id, userId)))
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
  async artifactRolesFor(userId: string, artifactIds: string[]): Promise<Record<string, Role>> {
    if (artifactIds.length === 0) return {}
    const rows = await this.db
      .select({ artifact_id: artifactMember.artifact_id, role: artifactMember.role })
      .from(artifactMember)
      .where(
        and(eq(artifactMember.user_id, userId), inArray(artifactMember.artifact_id, artifactIds)),
      )
    return Object.fromEntries(rows.map((r) => [r.artifact_id, r.role]))
  }
  // Artifacts explicitly shared with a user (per-artifact membership) — can span
  // workspaces; drives the home's "Shared with you" section. Excludes what they
  // authored: the creator's own owner-member row (written at publish) is
  // ownership, not a share (see repos.ts).
  async artifactIdsSharedWith(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: artifactMember.artifact_id })
      .from(artifactMember)
      .innerJoin(artifact, eq(artifact.id, artifactMember.artifact_id))
      .where(
        and(
          eq(artifactMember.user_id, userId),
          or(isNull(artifact.author_id), ne(artifact.author_id, userId)),
        ),
      )
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
  async listUserFavoriteIds(userId: string, orgId?: string): Promise<string[]> {
    // With orgId, join to the artifact so the count reflects only live artifacts in
    // that workspace (a favorite of a removed or other-workspace artifact is dropped).
    if (orgId !== undefined) {
      const rows = await this.db
        .select({ id: artifactFavorite.artifact_id })
        .from(artifactFavorite)
        .innerJoin(artifact, eq(artifact.id, artifactFavorite.artifact_id))
        .where(
          and(
            eq(artifactFavorite.user_id, userId),
            eq(artifact.org_id, orgId),
            isNull(artifact.removed_at),
          ),
        )
      return rows.map((r) => r.id)
    }
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

  // ---- Follows (track GitHub authors + repo path prefixes) ---------------
  // Mirrors the sqlite path: insert-or-ignore on the unique key, then read back.
  async addFollow(f: NewFollow): Promise<FollowRecord> {
    await this.db
      .insert(follow)
      .values(f)
      .onConflictDoNothing({
        target: [follow.user_id, follow.org_id, follow.kind, follow.target],
      })
    const rows = await this.db
      .select()
      .from(follow)
      .where(
        and(
          eq(follow.user_id, f.user_id),
          eq(follow.org_id, f.org_id),
          eq(follow.kind, f.kind),
          eq(follow.target, f.target),
        ),
      )
    return one(rows)
  }
  async removeFollow(
    userId: string,
    orgId: string,
    kind: FollowKind,
    target: string,
  ): Promise<void> {
    await this.db
      .delete(follow)
      .where(
        and(
          eq(follow.user_id, userId),
          eq(follow.org_id, orgId),
          eq(follow.kind, kind),
          eq(follow.target, target),
        ),
      )
  }
  // Author/path follows in this workspace PLUS the user's global people-follows (org "*").
  listFollows(userId: string, orgId: string): Promise<FollowRecord[]> {
    return this.db
      .select()
      .from(follow)
      .where(and(eq(follow.user_id, userId), inArray(follow.org_id, [orgId, GLOBAL_FOLLOW_ORG])))
      .orderBy(desc(follow.created_at), desc(follow.id))
  }
  // GitHub numeric ids a set of Derive users linked (raw account read; [] if absent).
  private async githubIdsForUsers(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return []
    try {
      const ph = userIds.map((_, i) => `$${i + 1}`).join(",")
      const { rows } = await this.pool.query(
        `SELECT a."accountId" gh_id FROM "account" a
         WHERE a."providerId" = 'github' AND a."userId" IN (${ph})`,
        userIds,
      )
      return (rows as { gh_id: string }[]).map((r) => r.gh_id).filter(Boolean)
    } catch {
      return []
    }
  }
  // The "following" feed id set: live artifacts whose current author is a followed login
  // (case-insensitive), whose source_path starts with a followed path prefix, OR whose
  // author/path follows match within the active workspace; people follows match a
  // followed person's PUBLIC work across ANY workspace. Mirrors the sqlite path.
  async followedArtifactIds(userId: string, orgId: string): Promise<string[]> {
    const follows = await this.listFollows(userId, orgId)
    const logins = follows.filter((f) => f.kind === "author").map((f) => f.target.toLowerCase())
    const prefixes = follows.filter((f) => f.kind === "path").map((f) => f.target)
    const people = follows.filter((f) => f.kind === "user").map((f) => f.target)
    if (logins.length === 0 && prefixes.length === 0 && people.length === 0) return []
    const branches = []
    const wsConds = []
    if (logins.length > 0) wsConds.push(inArray(sql`lower(${artifact.author_login})`, logins))
    for (const p of prefixes) {
      const escaped = p.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
      wsConds.push(sql`${artifact.source_path} like ${`${escaped}%`} escape '\\'`)
    }
    if (wsConds.length > 0) {
      const wsMatch = wsConds.length === 1 ? wsConds[0] : or(...wsConds)
      if (wsMatch) branches.push(and(eq(artifact.org_id, orgId), wsMatch))
    }
    if (people.length > 0) {
      const authorConds = [inArray(artifact.author_id, people)]
      const ghIds = (await this.githubIdsForUsers(people)).map((g) => g.toLowerCase())
      if (ghIds.length > 0) authorConds.push(inArray(sql`lower(${artifact.author_gh_id})`, ghIds))
      const authored = authorConds.length === 1 ? authorConds[0] : or(...authorConds)
      if (authored) branches.push(and(eq(artifact.visibility, "public"), authored))
    }
    if (branches.length === 0) return []
    const match = branches.length === 1 ? branches[0] : or(...branches)
    const rows = await this.db
      .select({ id: artifact.id })
      .from(artifact)
      .where(and(isNull(artifact.removed_at), match))
    return rows.map((r) => r.id)
  }
  // ---- People profiles: works, shared workspaces, follower/following -----
  githubIdsForUser(userId: string): Promise<string[]> {
    return this.githubIdsForUsers([userId])
  }
  async githubLoginForUser(_userId: string, ghIds: string[]): Promise<string | null> {
    if (ghIds.length === 0) return null
    const rows = await this.db
      .select({ login: artifact.author_login })
      .from(artifact)
      .where(and(inArray(artifact.author_gh_id, ghIds), isNotNull(artifact.author_login)))
      .limit(1)
    return rows[0]?.login ?? null
  }
  async sharedOrgIds(viewerId: string, targetUserId: string): Promise<string[]> {
    const rows = await this.db
      .select({ org: membership.org_id })
      .from(membership)
      .where(
        and(
          eq(membership.user_id, viewerId),
          inArray(
            membership.org_id,
            this.db
              .select({ o: membership.org_id })
              .from(membership)
              .where(eq(membership.user_id, targetUserId)),
          ),
        ),
      )
    return rows.map((r) => r.org)
  }
  private userWorksConds(userId: string, ghIds: string[], opts: ListArtifactsOpts) {
    const conds = [...artifactListConditions(artifact, opts), isNull(artifact.removed_at)]
    if (ghIds.length > 0) {
      const m = or(
        eq(artifact.author_id, userId),
        inArray(
          sql`lower(${artifact.author_gh_id})`,
          ghIds.map((g) => g.toLowerCase()),
        ),
      )
      if (m) conds.push(m)
    } else {
      conds.push(eq(artifact.author_id, userId))
    }
    // Private and unlisted drafts never ride a profile, shared workspace or not
    // (see repos.ts).
    const orgs = opts.visibleOrgIds ?? []
    if (orgs.length > 0) {
      const v = or(
        eq(artifact.visibility, "public"),
        and(
          inArray(artifact.org_id, orgs),
          ne(artifact.visibility, "private"),
          ne(artifact.visibility, "unlisted"),
        ),
      )
      if (v) conds.push(v)
    } else {
      conds.push(eq(artifact.visibility, "public"))
    }
    return conds
  }
  async listUserWorks(
    userId: string,
    ghIds: string[],
    opts: ListArtifactsOpts,
  ): Promise<ArtifactRecord[]> {
    const q = this.db
      .select()
      .from(artifact)
      .where(and(...this.userWorksConds(userId, ghIds, opts)))
      .orderBy(desc(artifact.created_at), desc(artifact.id))
    return opts.limit ? q.limit(opts.limit) : q
  }
  async countUserWorks(userId: string, ghIds: string[], opts: ListArtifactsOpts): Promise<number> {
    const rows = await this.db
      .select({ c: count() })
      .from(artifact)
      .where(
        and(
          ...this.userWorksConds(userId, ghIds, { ...opts, cursor: undefined, limit: undefined }),
        ),
      )
    return rows[0]?.c ?? 0
  }
  async countFollowers(userId: string): Promise<number> {
    const rows = await this.db
      .select({ c: count() })
      .from(follow)
      .where(and(eq(follow.kind, "user"), eq(follow.target, userId)))
    return rows[0]?.c ?? 0
  }
  async countFollowing(userId: string): Promise<number> {
    const rows = await this.db
      .select({ c: count() })
      .from(follow)
      .where(and(eq(follow.kind, "user"), eq(follow.user_id, userId)))
    return rows[0]?.c ?? 0
  }
  private async profilesForFollow(
    column: "user_id" | "target",
    userId: string,
    limit: number,
  ): Promise<UserProfile[]> {
    try {
      const join = column === "target" ? `u.id = f.target` : `u.id = f.user_id`
      const pick = column === "target" ? `f.user_id = $1` : `f.target = $1`
      const { rows } = await this.pool.query(
        `SELECT u.id, u.name, u.image, u.username, u.profession, u.about
         FROM follow f JOIN "user" u ON ${join}
         WHERE f.kind = 'user' AND ${pick} AND u.username IS NOT NULL
         ORDER BY f.created_at DESC, f.id DESC LIMIT $2`,
        [userId, limit],
      )
      return rows as UserProfile[]
    } catch {
      return []
    }
  }
  listFollowing(userId: string, limit: number): Promise<UserProfile[]> {
    return this.profilesForFollow("target", userId, limit)
  }
  listFollowers(userId: string, limit: number): Promise<UserProfile[]> {
    return this.profilesForFollow("user_id", userId, limit)
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
  async setRepoSourceProgress(id: string, progress: string | null): Promise<void> {
    await this.db.update(repoSource).set({ progress }).where(eq(repoSource.id, id))
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
  async listSyncingRepoSources(): Promise<RepoSourceRecord[]> {
    return this.db.select().from(repoSource).where(isNotNull(repoSource.progress))
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
  async getOrgSettings(orgId: string): Promise<OrgSettings> {
    const rows = await this.db.select().from(orgSettings).where(eq(orgSettings.org_id, orgId))
    let parsed: Partial<OrgSettings> = {}
    try {
      if (rows[0]?.settings) parsed = JSON.parse(rows[0].settings) as Partial<OrgSettings>
    } catch {}
    return { ...DEFAULT_ORG_SETTINGS, ...parsed }
  }
  async setOrgSettings(orgId: string, settings: OrgSettings): Promise<void> {
    await this.db
      .insert(orgSettings)
      .values({ org_id: orgId, settings: JSON.stringify(settings) })
      .onConflictDoUpdate({
        target: orgSettings.org_id,
        set: { settings: JSON.stringify(settings) },
      })
  }

  // ---- Slack App ----------------------------------------------------------
  async getSlackInstall(orgId: string): Promise<SlackInstallRecord | null> {
    const rows = await this.db.select().from(slackInstall).where(eq(slackInstall.org_id, orgId))
    return rows[0] ?? null
  }
  async setSlackInstall(s: SlackInstallRecord): Promise<void> {
    const { org_id: _o, created_at: _c, ...set } = s
    await this.db
      .insert(slackInstall)
      .values(s)
      .onConflictDoUpdate({ target: slackInstall.org_id, set })
  }
  async deleteSlackInstall(orgId: string): Promise<void> {
    await this.db.delete(slackInstall).where(eq(slackInstall.org_id, orgId))
  }
  async getSlackThreadLinkByThread(threadId: string): Promise<SlackThreadLinkRecord | null> {
    const rows = await this.db
      .select()
      .from(slackThreadLink)
      .where(eq(slackThreadLink.thread_id, threadId))
    return rows[0] ?? null
  }
  async getSlackThreadLinkByTs(channel: string, ts: string): Promise<SlackThreadLinkRecord | null> {
    const rows = await this.db
      .select()
      .from(slackThreadLink)
      .where(and(eq(slackThreadLink.channel, channel), eq(slackThreadLink.message_ts, ts)))
    return rows[0] ?? null
  }
  async setSlackThreadLink(l: SlackThreadLinkRecord): Promise<void> {
    const { thread_id: _t, created_at: _c, ...set } = l
    await this.db
      .insert(slackThreadLink)
      .values(l)
      .onConflictDoUpdate({ target: slackThreadLink.thread_id, set })
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

  // ---- Review rounds -----------------------------------------------------
  async createReviewRound(r: NewReviewRound): Promise<ReviewRoundRecord> {
    // Replace this person's prior pending round so the re-request wins and the
    // partial unique index holds.
    await this.db
      .delete(reviewRound)
      .where(
        and(
          eq(reviewRound.artifact_id, r.artifact_id),
          eq(reviewRound.requested_for, r.requested_for),
          eq(reviewRound.state, "pending"),
        ),
      )
    const rows = await this.db.insert(reviewRound).values(r).returning()
    return one(rows)
  }
  async getPendingRound(
    artifactId: string,
    requestedFor?: string,
  ): Promise<ReviewRoundRecord | null> {
    const where = requestedFor
      ? and(
          eq(reviewRound.artifact_id, artifactId),
          eq(reviewRound.requested_for, requestedFor),
          eq(reviewRound.state, "pending"),
        )
      : and(eq(reviewRound.artifact_id, artifactId), eq(reviewRound.state, "pending"))
    const rows = await this.db
      .select()
      .from(reviewRound)
      .where(where)
      .orderBy(asc(reviewRound.created_at))
      .limit(1)
    return rows[0] ?? null
  }
  listReviewRounds(artifactId: string): Promise<ReviewRoundRecord[]> {
    return this.db
      .select()
      .from(reviewRound)
      .where(eq(reviewRound.artifact_id, artifactId))
      .orderBy(desc(reviewRound.created_at))
  }
  async resolveReviewRound(
    id: string,
    fields: { state: Extract<ReviewRoundState, "sent_back" | "approved">; note?: string | null },
  ): Promise<ReviewRoundRecord | null> {
    const rows = await this.db
      .update(reviewRound)
      .set({ ...fields, resolved_at: new Date().toISOString() })
      .where(eq(reviewRound.id, id))
      .returning()
    return rows[0] ?? null
  }

  // ---- Contexts + sessions -------------------------------------------------
  async createContext(x: NewContext): Promise<ContextRecord> {
    const rows = await this.db.insert(context).values(x).returning()
    return one(rows)
  }
  async getContext(id: string): Promise<ContextRecord | null> {
    const rows = await this.db.select().from(context).where(eq(context.id, id)).limit(1)
    return rows[0] ?? null
  }
  listContexts(orgId: string): Promise<ContextRecord[]> {
    return this.db
      .select()
      .from(context)
      .where(eq(context.org_id, orgId))
      .orderBy(desc(context.created_at))
  }
  // Sequential cascade (messages → sessions → context), like deleteCollection.
  // The org scope gates the WHOLE cascade, not just the context row — otherwise a
  // wrong-workspace call would wipe another tenant's sessions and leave the context.
  async deleteContext(id: string, orgId: string): Promise<void> {
    const owned = await this.db
      .select({ id: context.id })
      .from(context)
      .where(and(eq(context.id, id), eq(context.org_id, orgId)))
      .limit(1)
    if (owned.length === 0) return
    // Subquery, not a materialized id list — kept identical to the sqlite/d1
    // layer, where an expanded IN (...) would blow D1's bound-parameter cap.
    await this.db
      .delete(sessionMessage)
      .where(
        inArray(
          sessionMessage.session_id,
          this.db
            .select({ id: contextSession.id })
            .from(contextSession)
            .where(eq(contextSession.context_id, id)),
        ),
      )
    await this.db.delete(contextSession).where(eq(contextSession.context_id, id))
    await this.db.delete(context).where(eq(context.id, id))
  }
  async createSession(s: NewSession): Promise<SessionRecord> {
    const rows = await this.db.insert(contextSession).values(s).returning()
    return one(rows)
  }
  async getSession(id: string): Promise<SessionRecord | null> {
    const rows = await this.db
      .select()
      .from(contextSession)
      .where(eq(contextSession.id, id))
      .limit(1)
    return rows[0] ?? null
  }
  listSessions(
    contextId: string,
    opts?: { askerId?: string; limit?: number },
  ): Promise<SessionRecord[]> {
    const where = opts?.askerId
      ? and(eq(contextSession.context_id, contextId), eq(contextSession.asker_id, opts.askerId))
      : eq(contextSession.context_id, contextId)
    return this.db
      .select()
      .from(contextSession)
      .where(where)
      .orderBy(desc(contextSession.created_at))
      .limit(opts?.limit ?? 50)
  }
  pendingSessions(contextId: string, limit: number): Promise<SessionRecord[]> {
    return this.db
      .select()
      .from(contextSession)
      .where(and(eq(contextSession.context_id, contextId), eq(contextSession.state, "open")))
      .orderBy(asc(contextSession.created_at))
      .limit(limit)
  }
  async setSessionState(id: string, state: SessionState): Promise<SessionRecord | null> {
    const rows = await this.db
      .update(contextSession)
      .set({ state, updated_at: new Date().toISOString() })
      .where(eq(contextSession.id, id))
      .returning()
    return rows[0] ?? null
  }
  // Two writes, no transaction (the createReviewRound pattern, kept identical to
  // the sqlite/d1 layer). A crash between them leaves state stale: an unsettled
  // agent turn is caught by the runner's last-turn guard; a lost asker `open`
  // waits for the asker's next message. Both windows are milliseconds.
  async addSessionMessage(
    m: NewSessionMessage,
    state: SessionState,
  ): Promise<SessionMessageRecord> {
    const rows = await this.db.insert(sessionMessage).values(m).returning()
    await this.db
      .update(contextSession)
      .set({ state, updated_at: new Date().toISOString() })
      .where(eq(contextSession.id, m.session_id))
    return one(rows)
  }
  listSessionMessages(sessionId: string): Promise<SessionMessageRecord[]> {
    return this.db
      .select()
      .from(sessionMessage)
      .where(eq(sessionMessage.session_id, sessionId))
      .orderBy(asc(sessionMessage.created_at))
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
  // Map GitHub numeric user ids to Derive accounts ("account".accountId → "user"), scoped
  // to the github social provider. Best-effort — [] when the Better Auth tables are absent.
  async usersByGithubIds(ghIds: string[]): Promise<GithubUserMapping[]> {
    if (ghIds.length === 0) return []
    try {
      const ph = ghIds.map((_, i) => `$${i + 1}`).join(",")
      const { rows } = await this.pool.query(
        `SELECT a."accountId" gh_id, u.id, u.name, u.image, u.username
         FROM "account" a JOIN "user" u ON u.id = a."userId"
         WHERE a."providerId" = 'github' AND a."accountId" IN (${ph})`,
        ghIds,
      )
      return rows as GithubUserMapping[]
    } catch {
      return []
    }
  }
  // Idempotent backfill (see sqlite.ts) — stamp author_id from a known author_gh_id→user mapping.
  async backfillAuthorIds(): Promise<number> {
    try {
      const res = await this.pool.query(
        `UPDATE "artifact" SET author_id = (
           SELECT u.id FROM "account" a JOIN "user" u ON u.id = a."userId"
           WHERE a."providerId" = 'github' AND a."accountId" = "artifact".author_gh_id LIMIT 1)
         WHERE author_id IS NULL AND author_gh_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM "account" a JOIN "user" u ON u.id = a."userId"
             WHERE a."providerId" = 'github' AND a."accountId" = "artifact".author_gh_id)`,
      )
      return res.rowCount ?? 0
    } catch {
      return 0
    }
  }
  async getUserByUsername(username: string): Promise<UserProfile | null> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, name, image, username, profession, about, discoverable FROM "user" WHERE username = $1`,
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
  async setUserOnboarded(userId: string, onboarded: boolean): Promise<void> {
    await this.pool.query(`UPDATE "user" SET onboarded = $1 WHERE id = $2`, [onboarded, userId])
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
      // Escape ILIKE metacharacters so a literal %/_/\ in the query matches itself —
      // a search for "%" finds nothing, not everyone.
      const like = `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
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
  async listDiscoverableUsers(limit: number): Promise<UserProfile[]> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, name, image, username, profession, about FROM "user"
         WHERE discoverable IS NOT FALSE AND username IS NOT NULL
         ORDER BY username LIMIT $1`,
        [limit],
      )
      return rows as UserProfile[]
    } catch {
      return []
    }
  }

  async listWorkspaceMates(userId: string, limit: number): Promise<UserProfile[]> {
    try {
      const { rows } = await this.pool.query(
        `SELECT DISTINCT u.id, u.name, u.image, u.username, u.profession, u.about
         FROM membership m1
         JOIN membership m2 ON m2.org_id = m1.org_id AND m2.user_id != m1.user_id
         JOIN "user" u ON u.id = m2.user_id
         WHERE m1.user_id = $1 AND u.username IS NOT NULL
         ORDER BY u.username LIMIT $2`,
        [userId, limit],
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
      // node-postgres returns json/jsonb columns already parsed, so this can be a
      // real array; text columns stay strings. parseOAuthScopes handles both.
      scopes: string | string[] | null
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
  async setOAuthClientWorkspace(userId: string, clientId: string, orgId: string): Promise<void> {
    await this.db
      .insert(oauthClientWorkspace)
      .values({ id: crypto.randomUUID(), user_id: userId, client_id: clientId, org_id: orgId })
      .onConflictDoUpdate({
        target: [oauthClientWorkspace.user_id, oauthClientWorkspace.client_id],
        set: { org_id: orgId },
      })
  }
  async getOAuthClientWorkspace(userId: string, clientId: string): Promise<string | null> {
    const rows = await this.db
      .select({ org_id: oauthClientWorkspace.org_id })
      .from(oauthClientWorkspace)
      .where(
        and(eq(oauthClientWorkspace.user_id, userId), eq(oauthClientWorkspace.client_id, clientId)),
      )
    return rows[0]?.org_id ?? null
  }
  async pruneStaleOAuthClients(cutoffIso: string): Promise<number> {
    try {
      const res = await this.pool.query(
        `DELETE FROM "oauthClient" WHERE "userId" IS NULL AND "createdAt" < $1
           AND "clientId" NOT IN (SELECT "clientId" FROM "oauthConsent")
           AND "clientId" NOT IN (SELECT "clientId" FROM "oauthAccessToken")`,
        [cutoffIso],
      )
      // Workspace bindings for clients that no longer exist (pruned above, or
      // any earlier sweep) have nothing left to resolve against — sweep them too.
      await this.pool.query(
        `DELETE FROM oauth_client_workspace
          WHERE client_id NOT IN (SELECT "clientId" FROM "oauthClient")`,
      )
      return res.rowCount ?? 0
    } catch {
      return 0
    }
  }
  async listUserGrants(userId: string): Promise<OAuthGrantSummary[]> {
    try {
      const { rows } = await this.pool.query(
        `SELECT k."clientId" AS client_id, c."name" AS client_name,
                k."scopes" AS scopes, k."updatedAt" AS granted_at
           FROM "oauthConsent" k
           JOIN "oauthClient" c ON c."clientId" = k."clientId"
          WHERE k."userId" = $1
          ORDER BY k."updatedAt" DESC`,
        [userId],
      )
      return (
        rows as {
          client_id: string
          client_name: string | null
          scopes: string | string[] | null
          granted_at: Date | string | null
        }[]
      ).map((r) => ({
        clientId: r.client_id,
        clientName: r.client_name || r.client_id,
        scopes: parseOAuthScopes(r.scopes),
        grantedAt: (r.granted_at instanceof Date
          ? r.granted_at
          : new Date(r.granted_at ?? Date.now())
        ).toISOString(),
      }))
    } catch {
      return []
    }
  }
  async revokeUserGrant(userId: string, clientId: string): Promise<void> {
    for (const table of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"]) {
      try {
        await this.pool.query(`DELETE FROM "${table}" WHERE "userId" = $1 AND "clientId" = $2`, [
          userId,
          clientId,
        ])
      } catch {
        // Table absent on this deploy → skip; the others still run.
      }
    }
  }
  async deleteAgent(id: string, orgId: string): Promise<void> {
    await this.db.delete(agent).where(and(eq(agent.id, id), eq(agent.org_id, orgId)))
  }
  async createAgentMention(m: NewAgentMention): Promise<void> {
    await this.db.insert(agentMention).values(m)
  }
  // ---- Workspace invitations ---------------------------------------------
  async createInvitation(i: NewInvitation): Promise<InvitationRecord> {
    const rows = await this.db.insert(invitation).values(i).returning()
    return one(rows) as InvitationRecord
  }
  async getInvitationByToken(tokenHash: string): Promise<InvitationRecord | null> {
    const rows = await this.db.select().from(invitation).where(eq(invitation.token, tokenHash))
    return (rows[0] as InvitationRecord | undefined) ?? null
  }
  listPendingInvitations(orgId: string): Promise<InvitationRecord[]> {
    return this.db
      .select()
      .from(invitation)
      .where(and(eq(invitation.org_id, orgId), isNull(invitation.accepted_at)))
      .orderBy(desc(invitation.created_at)) as Promise<InvitationRecord[]>
  }
  async deletePendingInvitationsFor(orgId: string, email: string): Promise<void> {
    await this.db
      .delete(invitation)
      .where(
        and(
          eq(invitation.org_id, orgId),
          eq(invitation.email, email),
          isNull(invitation.accepted_at),
        ),
      )
  }
  async deleteInvitation(id: string, orgId: string): Promise<void> {
    await this.db.delete(invitation).where(and(eq(invitation.id, id), eq(invitation.org_id, orgId)))
  }
  async markInvitationAccepted(id: string): Promise<void> {
    await this.db
      .update(invitation)
      .set({ accepted_at: new Date().toISOString() })
      .where(eq(invitation.id, id))
  }
  // ---- Account deletion cascade (see MetaStore.deleteUserData) ------------
  async deleteUserData(userId: string): Promise<void> {
    await this.db.delete(membership).where(eq(membership.user_id, userId))
    await this.db.delete(artifactMember).where(eq(artifactMember.user_id, userId))
    await this.db.delete(collectionMember).where(eq(collectionMember.user_id, userId))
    await this.db.delete(follow).where(eq(follow.user_id, userId))
    await this.db.delete(artifactFavorite).where(eq(artifactFavorite.user_id, userId))
    await this.db.delete(notification).where(eq(notification.user_id, userId))
    await this.db.update(artifact).set({ author_id: null }).where(eq(artifact.author_id, userId))
    await this.db.update(version).set({ author_id: null }).where(eq(version.author_id, userId))
    await this.db.update(comment).set({ author_id: null }).where(eq(comment.author_id, userId))
    await this.db.update(proposal).set({ author_id: null }).where(eq(proposal.author_id, userId))
    await this.db.update(agent).set({ created_by: null }).where(eq(agent.created_by, userId))
    await this.db
      .update(invitation)
      .set({ invited_by: null })
      .where(eq(invitation.invited_by, userId))
    await this.db.delete(workspace).where(eq(workspace.id, `ws_p_${userId}`))
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
  async setArtifactUpdatedAt(id: string, updatedAt: string): Promise<void> {
    await this.db.update(artifact).set({ updated_at: updatedAt }).where(eq(artifact.id, id))
  }
  async setArtifactAuthor(artifactId: string, author: GithubAuthor | null): Promise<void> {
    await this.db
      .update(artifact)
      .set({
        author_name: author?.name ?? null,
        author_login: author?.login ?? null,
        author_avatar: author?.avatar ?? null,
        author_gh_id: author?.ghId ?? null,
      })
      .where(eq(artifact.id, artifactId))
  }
  async createAuditLog(a: NewAuditLog): Promise<void> {
    await this.db.insert(auditLog).values(a)
  }
  // Atomic delete: all FK-dependent rows and the artifact row commit together.
  async deleteArtifact(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // A context's manifest FK means deleting a manifest deletes its context
      // (and sessions) — a context cannot outlive its definition, by design.
      // Subqueries, matching the sqlite/d1 layer (D1 bound-parameter cap).
      const ctxIds = tx
        .select({ id: context.id })
        .from(context)
        .where(eq(context.manifest_artifact_id, id))
      await tx
        .delete(sessionMessage)
        .where(
          inArray(
            sessionMessage.session_id,
            tx
              .select({ id: contextSession.id })
              .from(contextSession)
              .where(inArray(contextSession.context_id, ctxIds)),
          ),
        )
      await tx.delete(contextSession).where(inArray(contextSession.context_id, ctxIds))
      await tx.delete(context).where(eq(context.manifest_artifact_id, id))
      await tx.delete(reviewRound).where(eq(reviewRound.artifact_id, id))
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
