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
import Database from "better-sqlite3"
import { and, asc, count, desc, eq, inArray, isNull, like, lt, lte, or, sql } from "drizzle-orm"
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3"
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
  MIGRATION_STATEMENTS,
  membership,
  notification,
  proposal,
  report,
  SCHEMA_STATEMENTS,
  version,
  webhook,
  webhookDelivery,
  workspace,
} from "./schema"

const VIEW_WINDOW_MS = 30 * 86400_000

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

/** Embedded SQLite (WAL). The zero-dependency default; no external services. */
export class SqliteMetaStore implements MetaStore {
  private raw: Database.Database
  private db: BetterSQLite3Database<typeof schema>

  constructor(path: string) {
    this.raw = new Database(path)
    this.raw.pragma("journal_mode = WAL")
    for (const stmt of SCHEMA_STATEMENTS) this.raw.exec(stmt)
    // Forward-only column adds (SQLite lacks ADD COLUMN IF NOT EXISTS); a
    // "duplicate column" throw means the migration is already applied.
    for (const stmt of MIGRATION_STATEMENTS) {
      try {
        this.raw.exec(stmt)
      } catch {
        /* already applied */
      }
    }
    this.db = drizzle(this.raw, { schema })
  }

  async createArtifact(a: NewArtifact): Promise<ArtifactRecord> {
    this.db.insert(artifact).values(a).run()
    return (await this.getByShortId(a.short_id)) as ArtifactRecord
  }

  async getByShortId(shortId: string): Promise<ArtifactRecord | null> {
    return this.db.select().from(artifact).where(eq(artifact.short_id, shortId)).get() ?? null
  }

  async addVersion(artifactId: string, v: NewVersion): Promise<VersionRecord> {
    const n = this.db.transaction((tx) => {
      const row = tx
        .select({ cv: artifact.current_version })
        .from(artifact)
        .where(eq(artifact.id, artifactId))
        .get()
      if (!row) throw new Error(`artifact not found: ${artifactId}`)
      const next = row.cv + 1
      tx.insert(version)
        .values({ ...v, artifact_id: artifactId, n: next })
        .run()
      tx.update(artifact).set({ current_version: next }).where(eq(artifact.id, artifactId)).run()
      return next
    })
    return (await this.getVersion(artifactId, n)) as VersionRecord
  }

  async listVersions(artifactId: string): Promise<VersionRecord[]> {
    return this.db
      .select()
      .from(version)
      .where(eq(version.artifact_id, artifactId))
      .orderBy(asc(version.n))
      .all()
  }

  async getVersion(artifactId: string, n: number): Promise<VersionRecord | null> {
    return (
      this.db
        .select()
        .from(version)
        .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
        .get() ?? null
    )
  }

  async createComment(c: NewComment): Promise<CommentRecord> {
    this.db.insert(comment).values(c).run()
    return this.db.select().from(comment).where(eq(comment.id, c.id)).get() as CommentRecord
  }

  async getComment(id: string): Promise<CommentRecord | null> {
    return this.db.select().from(comment).where(eq(comment.id, id)).get() ?? null
  }

  async updateComment(
    id: string,
    fields: { body_md?: string; meta?: string | null },
  ): Promise<CommentRecord | null> {
    this.db.update(comment).set(fields).where(eq(comment.id, id)).run()
    return this.getComment(id)
  }

  async listComments(
    artifactId: string,
    opts?: { state?: CommentState },
  ): Promise<CommentRecord[]> {
    const where = opts?.state
      ? and(eq(comment.artifact_id, artifactId), eq(comment.state, opts.state))
      : eq(comment.artifact_id, artifactId)
    return this.db.select().from(comment).where(where).orderBy(asc(comment.created_at)).all()
  }

  async setThreadState(artifactId: string, threadId: string, state: CommentState): Promise<number> {
    const res = this.db
      .update(comment)
      .set({ state })
      .where(and(eq(comment.artifact_id, artifactId), eq(comment.thread_id, threadId)))
      .run()
    return res.changes
  }

  async listArtifacts(opts?: ListArtifactsOpts): Promise<ArtifactRecord[]> {
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
    const rows = this.db
      .select()
      .from(artifact)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(artifact.created_at), desc(artifact.id))
    return opts?.limit ? rows.limit(opts.limit).all() : rows.all()
  }
  async artifactIdsByTag(tag: string): Promise<string[]> {
    return this.db
      .select({ id: artifactTag.artifact_id })
      .from(artifactTag)
      .where(eq(artifactTag.tag, tag))
      .all()
      .map((r) => r.id)
  }
  async countArtifacts(): Promise<number> {
    return this.db.select({ c: count() }).from(artifact).get()?.c ?? 0
  }
  async storageBytes(): Promise<number> {
    const row = this.db
      .select({ s: sql<number>`coalesce(sum(${version.size_bytes}), 0)` })
      .from(version)
      .get()
    return Number(row?.s ?? 0)
  }
  async tagCounts(): Promise<{ tag: string; count: number }[]> {
    return this.db
      .select({ tag: artifactTag.tag, count: count() })
      .from(artifactTag)
      .groupBy(artifactTag.tag)
      .orderBy(asc(artifactTag.tag))
      .all()
  }

  async recordView(v: NewView): Promise<void> {
    this.raw
      .prepare(
        `INSERT INTO view (id, artifact_id, version, viewer, viewer_kind) VALUES (?,?,?,?,?)`,
      )
      .run(v.id, v.artifact_id, v.version, v.viewer, v.viewer_kind)
  }

  async viewedSince(
    artifactId: string,
    viewer: string,
    version: number,
    sinceIso: string,
  ): Promise<boolean> {
    const row = this.raw
      .prepare(
        `SELECT 1 FROM view WHERE artifact_id=? AND viewer=? AND version=? AND created_at>=? LIMIT 1`,
      )
      .get(artifactId, viewer, version, sinceIso)
    return !!row
  }

  async pruneViews(cutoffIso: string): Promise<number> {
    return this.raw.prepare(`DELETE FROM view WHERE created_at < ?`).run(cutoffIso).changes
  }

  async viewStats(artifactId: string): Promise<ViewStats> {
    const cutoff = new Date(Date.now() - VIEW_WINDOW_MS).toISOString()
    const n = (q: string, ...p: unknown[]) => (this.raw.prepare(q).get(...p) as { n: number }).n
    return {
      total: n(`SELECT count(*) n FROM view WHERE artifact_id=?`, artifactId),
      unique: n(`SELECT count(DISTINCT viewer) n FROM view WHERE artifact_id=?`, artifactId),
      perVersion: this.raw
        .prepare(
          `SELECT version, count(*) count FROM view WHERE artifact_id=? GROUP BY version ORDER BY version`,
        )
        .all(artifactId) as { version: number; count: number }[],
      daily: this.raw
        .prepare(
          `SELECT substr(created_at,1,10) day, count(*) count FROM view WHERE artifact_id=? AND created_at>=? GROUP BY day ORDER BY day`,
        )
        .all(artifactId, cutoff) as { day: string; count: number }[],
      recent: this.raw
        .prepare(
          `SELECT viewer, viewer_kind kind, max(created_at) at FROM view WHERE artifact_id=? GROUP BY viewer, viewer_kind ORDER BY at DESC LIMIT 8`,
        )
        .all(artifactId) as { viewer: string; kind: "user" | "anon"; at: string }[],
    }
  }

  async viewCounts(artifactIds: string[]): Promise<Record<string, number>> {
    if (artifactIds.length === 0) return {}
    const ph = artifactIds.map(() => "?").join(",")
    const rows = this.raw
      .prepare(
        `SELECT artifact_id, count(*) c FROM view WHERE artifact_id IN (${ph}) GROUP BY artifact_id`,
      )
      .all(...artifactIds) as { artifact_id: string; c: number }[]
    const out: Record<string, number> = {}
    for (const r of rows) out[r.artifact_id] = r.c
    return out
  }

  // ---- Webhooks + outbox -------------------------------------------------
  createWebhook(w: NewWebhook): Promise<WebhookRecord> {
    return Promise.resolve(this.db.insert(webhook).values(w).returning().get())
  }
  listWebhooks(): Promise<WebhookRecord[]> {
    return Promise.resolve(this.db.select().from(webhook).orderBy(desc(webhook.created_at)).all())
  }
  getWebhook(id: string): Promise<WebhookRecord | null> {
    return Promise.resolve(this.db.select().from(webhook).where(eq(webhook.id, id)).get() ?? null)
  }
  async deleteWebhook(id: string): Promise<void> {
    this.db.delete(webhook).where(eq(webhook.id, id)).run()
  }
  activeWebhooks(artifactId: string): Promise<WebhookRecord[]> {
    return Promise.resolve(
      this.db
        .select()
        .from(webhook)
        .where(
          and(
            eq(webhook.active, 1),
            or(isNull(webhook.artifact_id), eq(webhook.artifact_id, artifactId)),
          ),
        )
        .all(),
    )
  }
  async enqueueDelivery(d: NewDelivery): Promise<void> {
    this.db.insert(webhookDelivery).values(d).run()
  }
  claimDueDeliveries(now: string, limit: number): Promise<DeliveryRecord[]> {
    return Promise.resolve(
      this.db
        .select()
        .from(webhookDelivery)
        .where(
          and(eq(webhookDelivery.status, "pending"), lte(webhookDelivery.next_attempt_at, now)),
        )
        .orderBy(asc(webhookDelivery.next_attempt_at))
        .limit(limit)
        .all(),
    )
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
    this.db.update(webhookDelivery).set(f).where(eq(webhookDelivery.id, id)).run()
  }
  recentDeliveries(webhookId: string, limit: number): Promise<DeliveryRecord[]> {
    return Promise.resolve(
      this.db
        .select()
        .from(webhookDelivery)
        .where(eq(webhookDelivery.webhook_id, webhookId))
        .orderBy(desc(webhookDelivery.created_at))
        .limit(limit)
        .all(),
    )
  }

  // ---- Permissions: membership + per-artifact shares ---------------------
  async getMembership(orgId: string, userId: string): Promise<MembershipRecord | null> {
    return (
      this.db
        .select()
        .from(membership)
        .where(and(eq(membership.org_id, orgId), eq(membership.user_id, userId)))
        .get() ?? null
    )
  }
  listMemberships(orgId: string): Promise<MembershipRecord[]> {
    return Promise.resolve(
      this.db.select().from(membership).where(eq(membership.org_id, orgId)).all(),
    )
  }
  async countMemberships(orgId: string): Promise<number> {
    return (
      this.db.select({ n: count() }).from(membership).where(eq(membership.org_id, orgId)).get()
        ?.n ?? 0
    )
  }
  setMembership(m: NewMembership): Promise<MembershipRecord> {
    return Promise.resolve(
      this.db
        .insert(membership)
        .values(m)
        .onConflictDoUpdate({
          target: [membership.org_id, membership.user_id],
          set: { role: m.role },
        })
        .returning()
        .get(),
    )
  }
  async removeMembership(orgId: string, userId: string): Promise<void> {
    this.db
      .delete(membership)
      .where(and(eq(membership.org_id, orgId), eq(membership.user_id, userId)))
      .run()
  }
  async getWorkspace(orgId: string): Promise<WorkspaceRecord | null> {
    return this.db.select().from(workspace).where(eq(workspace.id, orgId)).get() ?? null
  }
  setWorkspace(orgId: string, name: string): Promise<WorkspaceRecord> {
    return Promise.resolve(
      this.db
        .insert(workspace)
        .values({ id: orgId, name })
        .onConflictDoUpdate({ target: workspace.id, set: { name } })
        .returning()
        .get(),
    )
  }

  async getArtifactMember(
    artifactId: string,
    userId: string,
  ): Promise<ArtifactMemberRecord | null> {
    return (
      this.db
        .select()
        .from(artifactMember)
        .where(and(eq(artifactMember.artifact_id, artifactId), eq(artifactMember.user_id, userId)))
        .get() ?? null
    )
  }
  listArtifactMembers(artifactId: string): Promise<ArtifactMemberRecord[]> {
    return Promise.resolve(
      this.db.select().from(artifactMember).where(eq(artifactMember.artifact_id, artifactId)).all(),
    )
  }
  setArtifactMember(m: NewArtifactMember): Promise<ArtifactMemberRecord> {
    return Promise.resolve(
      this.db
        .insert(artifactMember)
        .values(m)
        .onConflictDoUpdate({
          target: [artifactMember.artifact_id, artifactMember.user_id],
          set: { role: m.role },
        })
        .returning()
        .get(),
    )
  }
  async removeArtifactMember(artifactId: string, userId: string): Promise<void> {
    this.db
      .delete(artifactMember)
      .where(and(eq(artifactMember.artifact_id, artifactId), eq(artifactMember.user_id, userId)))
      .run()
  }

  // ---- Favorites + tags --------------------------------------------------
  async listUserFavoriteIds(userId: string): Promise<string[]> {
    return this.db
      .select({ id: artifactFavorite.artifact_id })
      .from(artifactFavorite)
      .where(eq(artifactFavorite.user_id, userId))
      .all()
      .map((r) => r.id)
  }
  async setFavorite(artifactId: string, userId: string): Promise<void> {
    this.db
      .insert(artifactFavorite)
      .values({ id: crypto.randomUUID(), artifact_id: artifactId, user_id: userId })
      .onConflictDoNothing({ target: [artifactFavorite.artifact_id, artifactFavorite.user_id] })
      .run()
  }
  async removeFavorite(artifactId: string, userId: string): Promise<void> {
    this.db
      .delete(artifactFavorite)
      .where(
        and(eq(artifactFavorite.artifact_id, artifactId), eq(artifactFavorite.user_id, userId)),
      )
      .run()
  }
  async tagsForArtifacts(artifactIds: string[]): Promise<Record<string, string[]>> {
    if (artifactIds.length === 0) return {}
    const rows = this.db
      .select({ artifact_id: artifactTag.artifact_id, tag: artifactTag.tag })
      .from(artifactTag)
      .where(inArray(artifactTag.artifact_id, artifactIds))
      .all()
    const out: Record<string, string[]> = {}
    for (const r of rows) {
      if (!out[r.artifact_id]) out[r.artifact_id] = []
      out[r.artifact_id].push(r.tag)
    }
    for (const k in out) out[k].sort()
    return out
  }
  async setArtifactTags(artifactId: string, tags: string[]): Promise<void> {
    this.raw.transaction(() => {
      this.db.delete(artifactTag).where(eq(artifactTag.artifact_id, artifactId)).run()
      for (const tag of tags) {
        this.db
          .insert(artifactTag)
          .values({ id: crypto.randomUUID(), artifact_id: artifactId, tag })
          .run()
      }
    })()
  }

  // ---- Collections -------------------------------------------------------
  createCollection(c: NewCollection): Promise<CollectionRecord> {
    return Promise.resolve(this.db.insert(collection).values(c).returning().get())
  }
  async getCollection(id: string): Promise<CollectionRecord | null> {
    return this.db.select().from(collection).where(eq(collection.id, id)).get() ?? null
  }
  async updateCollection(id: string, fields: { title?: string }): Promise<CollectionRecord | null> {
    if (fields.title === undefined) return this.getCollection(id)
    return (
      this.db
        .update(collection)
        .set({ title: fields.title })
        .where(eq(collection.id, id))
        .returning()
        .get() ?? null
    )
  }
  async deleteCollection(id: string): Promise<void> {
    this.raw.transaction(() => {
      this.db.delete(collectionItem).where(eq(collectionItem.collection_id, id)).run()
      this.db.delete(collectionMember).where(eq(collectionMember.collection_id, id)).run()
      this.db.delete(collection).where(eq(collection.id, id)).run()
    })()
  }
  async listCollections(): Promise<(CollectionRecord & { count: number })[]> {
    const rows = this.db.select().from(collection).orderBy(desc(collection.created_at)).all()
    const counts = this.db
      .select({ id: collectionItem.collection_id, c: count() })
      .from(collectionItem)
      .groupBy(collectionItem.collection_id)
      .all()
    const cmap = new Map(counts.map((r) => [r.id, r.c]))
    return rows.map((r) => ({ ...r, count: cmap.get(r.id) ?? 0 }))
  }
  async collectionArtifactIds(collectionId: string): Promise<string[]> {
    return this.db
      .select({ id: collectionItem.artifact_id })
      .from(collectionItem)
      .where(eq(collectionItem.collection_id, collectionId))
      .all()
      .map((r) => r.id)
  }
  async collectionIdsForArtifact(artifactId: string): Promise<string[]> {
    return this.db
      .select({ id: collectionItem.collection_id })
      .from(collectionItem)
      .where(eq(collectionItem.artifact_id, artifactId))
      .all()
      .map((r) => r.id)
  }
  async addCollectionItem(collectionId: string, artifactId: string): Promise<void> {
    this.db
      .insert(collectionItem)
      .values({ id: crypto.randomUUID(), collection_id: collectionId, artifact_id: artifactId })
      .onConflictDoNothing({ target: [collectionItem.collection_id, collectionItem.artifact_id] })
      .run()
  }
  async removeCollectionItem(collectionId: string, artifactId: string): Promise<void> {
    this.db
      .delete(collectionItem)
      .where(
        and(
          eq(collectionItem.collection_id, collectionId),
          eq(collectionItem.artifact_id, artifactId),
        ),
      )
      .run()
  }
  async getCollectionMember(
    collectionId: string,
    userId: string,
  ): Promise<CollectionMemberRecord | null> {
    return (
      this.db
        .select()
        .from(collectionMember)
        .where(
          and(
            eq(collectionMember.collection_id, collectionId),
            eq(collectionMember.user_id, userId),
          ),
        )
        .get() ?? null
    )
  }
  listCollectionMembers(collectionId: string): Promise<CollectionMemberRecord[]> {
    return Promise.resolve(
      this.db
        .select()
        .from(collectionMember)
        .where(eq(collectionMember.collection_id, collectionId))
        .all(),
    )
  }
  setCollectionMember(m: NewCollectionMember): Promise<CollectionMemberRecord> {
    return Promise.resolve(
      this.db
        .insert(collectionMember)
        .values(m)
        .onConflictDoUpdate({
          target: [collectionMember.collection_id, collectionMember.user_id],
          set: { role: m.role },
        })
        .returning()
        .get(),
    )
  }
  async removeCollectionMember(collectionId: string, userId: string): Promise<void> {
    this.db
      .delete(collectionMember)
      .where(
        and(eq(collectionMember.collection_id, collectionId), eq(collectionMember.user_id, userId)),
      )
      .run()
  }
  async collectionRolesForArtifact(artifactId: string, userId: string): Promise<Role[]> {
    return this.db
      .select({ role: collectionMember.role })
      .from(collectionMember)
      .innerJoin(collectionItem, eq(collectionItem.collection_id, collectionMember.collection_id))
      .where(and(eq(collectionItem.artifact_id, artifactId), eq(collectionMember.user_id, userId)))
      .all()
      .map((r) => r.role)
  }

  // ---- Reviews: proposed versions ----------------------------------------
  createProposal(p: NewProposal): Promise<ProposalRecord> {
    return Promise.resolve(this.db.insert(proposal).values(p).returning().get())
  }
  async getProposal(id: string): Promise<ProposalRecord | null> {
    return this.db.select().from(proposal).where(eq(proposal.id, id)).get() ?? null
  }
  listProposals(artifactId: string, opts?: { state?: ProposalState }): Promise<ProposalRecord[]> {
    const where = opts?.state
      ? and(eq(proposal.artifact_id, artifactId), eq(proposal.state, opts.state))
      : eq(proposal.artifact_id, artifactId)
    return Promise.resolve(
      this.db.select().from(proposal).where(where).orderBy(desc(proposal.created_at)).all(),
    )
  }
  async openProposalCounts(artifactIds: string[]): Promise<Record<string, number>> {
    if (artifactIds.length === 0) return {}
    const ph = artifactIds.map(() => "?").join(",")
    const rows = this.raw
      .prepare(
        `SELECT artifact_id, count(*) c FROM proposal WHERE state='open' AND artifact_id IN (${ph}) GROUP BY artifact_id`,
      )
      .all(...artifactIds) as { artifact_id: string; c: number }[]
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
    return (
      this.db
        .update(proposal)
        .set({ ...fields, decided_at: new Date().toISOString() })
        .where(eq(proposal.id, id))
        .returning()
        .get() ?? null
    )
  }

  // ---- User directory (Better Auth's `user` table; raw, may be absent) ---
  async findUserByEmail(email: string): Promise<UserDir | null> {
    try {
      return (
        (this.raw
          .prepare(`SELECT id, email, name FROM user WHERE email = ?`)
          .get(email) as UserDir) ?? null
      )
    } catch {
      return null
    }
  }
  async getUsers(ids: string[]): Promise<UserDir[]> {
    if (ids.length === 0) return []
    try {
      const ph = ids.map(() => "?").join(",")
      return this.raw
        .prepare(`SELECT id, email, name FROM user WHERE id IN (${ph})`)
        .all(...ids) as UserDir[]
    } catch {
      return []
    }
  }

  // ---- Notifications (in-app, one row per recipient) ---------------------
  async createNotification(n: NewNotification): Promise<void> {
    this.db.insert(notification).values(n).run()
  }
  listNotifications(userId: string, limit: number): Promise<NotificationRecord[]> {
    return Promise.resolve(
      this.db
        .select()
        .from(notification)
        .where(eq(notification.user_id, userId))
        .orderBy(desc(notification.created_at))
        .limit(limit)
        .all(),
    )
  }
  async unreadNotificationCount(userId: string): Promise<number> {
    return (
      this.db
        .select({ n: count() })
        .from(notification)
        .where(and(eq(notification.user_id, userId), eq(notification.read, 0)))
        .get()?.n ?? 0
    )
  }
  async markNotificationsRead(userId: string, ids: string[] | "all"): Promise<void> {
    const where =
      ids === "all"
        ? eq(notification.user_id, userId)
        : ids.length > 0
          ? and(eq(notification.user_id, userId), inArray(notification.id, ids))
          : null
    if (!where) return
    this.db.update(notification).set({ read: 1 }).where(where).run()
  }

  // ---- Agents + their pull inbox -----------------------------------------
  createAgent(a: NewAgent): Promise<AgentRecord> {
    return Promise.resolve(this.db.insert(agent).values(a).returning().get())
  }
  listAgents(orgId: string): Promise<AgentRecord[]> {
    return Promise.resolve(this.db.select().from(agent).where(eq(agent.org_id, orgId)).all())
  }
  async getAgentByToken(token: string): Promise<AgentRecord | null> {
    return this.db.select().from(agent).where(eq(agent.token, token)).get() ?? null
  }
  async deleteAgent(id: string): Promise<void> {
    this.db.delete(agent).where(eq(agent.id, id)).run()
  }
  async createAgentMention(m: NewAgentMention): Promise<void> {
    this.db.insert(agentMention).values(m).run()
  }
  listPendingAgentMentions(agentId: string, limit: number): Promise<AgentMentionRecord[]> {
    return Promise.resolve(
      this.db
        .select()
        .from(agentMention)
        .where(and(eq(agentMention.agent_id, agentId), eq(agentMention.state, "pending")))
        .orderBy(asc(agentMention.created_at))
        .limit(limit)
        .all(),
    )
  }
  async ackAgentMention(agentId: string, id: string): Promise<boolean> {
    const res = this.db
      .update(agentMention)
      .set({ state: "done" })
      .where(and(eq(agentMention.id, id), eq(agentMention.agent_id, agentId)))
      .run()
    return res.changes > 0
  }

  // ---- Moderation: reports, takedown, audit log --------------------------
  createReport(r: NewReport): Promise<ReportRecord> {
    return Promise.resolve(this.db.insert(report).values(r).returning().get())
  }
  listReports(opts?: { state?: ReportState; limit?: number }): Promise<ReportRecord[]> {
    const q = this.db
      .select()
      .from(report)
      .where(opts?.state ? eq(report.state, opts.state) : undefined)
      .orderBy(desc(report.created_at))
    return Promise.resolve((opts?.limit ? q.limit(opts.limit) : q).all())
  }
  async countOpenReports(): Promise<number> {
    return this.db.select({ n: count() }).from(report).where(eq(report.state, "open")).get()?.n ?? 0
  }
  async setReportState(id: string, state: ReportState): Promise<void> {
    this.db.update(report).set({ state }).where(eq(report.id, id)).run()
  }
  async setArtifactRemoved(id: string, removedAt: string | null): Promise<void> {
    this.db.update(artifact).set({ removed_at: removedAt }).where(eq(artifact.id, id)).run()
  }
  async createAuditLog(a: NewAuditLog): Promise<void> {
    this.db.insert(auditLog).values(a).run()
  }
  listAuditLog(opts?: { artifactId?: string; limit?: number }): Promise<AuditLogRecord[]> {
    const q = this.db
      .select()
      .from(auditLog)
      .where(opts?.artifactId ? eq(auditLog.artifact_id, opts.artifactId) : undefined)
      .orderBy(desc(auditLog.created_at))
    return Promise.resolve((opts?.limit ? q.limit(opts.limit) : q).all())
  }

  close(): void {
    this.raw.close()
  }
}
