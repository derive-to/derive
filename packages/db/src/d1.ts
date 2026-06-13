import type { D1Database } from "@cloudflare/workers-types"
import type {
  AgentMentionRecord,
  AgentRecord,
  ArtifactMemberRecord,
  ArtifactRecord,
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
  NewCollection,
  NewCollectionMember,
  NewComment,
  NewDelivery,
  NewMembership,
  NewNotification,
  NewProposal,
  NewVersion,
  NewView,
  NewWebhook,
  NotificationRecord,
  ProposalRecord,
  ProposalState,
  Role,
  UserDir,
  VersionRecord,
  ViewStats,
  WebhookRecord,
  WorkspaceRecord,
} from "@dock/core"
import { and, asc, count, desc, eq, inArray, isNull, like, lt, lte, or, sql } from "drizzle-orm"
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1"
import {
  agent,
  agentMention,
  artifact,
  artifactFavorite,
  artifactMember,
  artifactTag,
  collection,
  collectionItem,
  collectionMember,
  comment,
  membership,
  notification,
  proposal,
  version,
  webhook,
  webhookDelivery,
  workspace,
} from "./schema"

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
}
const VIEW_WINDOW_MS = 30 * 86400_000

/**
 * Cloudflare D1 driver. Same schema as the SQLite driver; apply
 * deploy/d1-schema.sql once before first use. D1 has no interactive
 * transactions, so addVersion is read-then-write — the UNIQUE(artifact_id, n)
 * constraint turns a race into a clean error rather than a duplicate.
 */
export class D1MetaStore implements MetaStore {
  private db: DrizzleD1Database<typeof schema>

  constructor(d1: D1Database) {
    this.db = drizzle(d1, { schema })
  }

  async createArtifact(a: NewArtifact): Promise<ArtifactRecord> {
    await this.db.insert(artifact).values(a).run()
    return (await this.getByShortId(a.short_id)) as ArtifactRecord
  }

  async getByShortId(shortId: string): Promise<ArtifactRecord | null> {
    return (
      (await this.db.select().from(artifact).where(eq(artifact.short_id, shortId)).get()) ?? null
    )
  }

  async addVersion(artifactId: string, v: NewVersion): Promise<VersionRecord> {
    const row = await this.db
      .select({ cv: artifact.current_version })
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .get()
    if (!row) throw new Error(`artifact not found: ${artifactId}`)
    const n = row.cv + 1
    await this.db
      .insert(version)
      .values({ ...v, artifact_id: artifactId, n })
      .run()
    await this.db
      .update(artifact)
      .set({ current_version: n })
      .where(eq(artifact.id, artifactId))
      .run()
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
      (await this.db
        .select()
        .from(version)
        .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
        .get()) ?? null
    )
  }

  async createComment(c: NewComment): Promise<CommentRecord> {
    await this.db.insert(comment).values(c).run()
    return (await this.db.select().from(comment).where(eq(comment.id, c.id)).get()) as CommentRecord
  }

  async getComment(id: string): Promise<CommentRecord | null> {
    return (await this.db.select().from(comment).where(eq(comment.id, id)).get()) ?? null
  }

  async updateComment(
    id: string,
    fields: { body_md?: string; meta?: string | null },
  ): Promise<CommentRecord | null> {
    await this.db.update(comment).set(fields).where(eq(comment.id, id)).run()
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
    const res = await this.db
      .update(comment)
      .set({ state })
      .where(and(eq(comment.artifact_id, artifactId), eq(comment.thread_id, threadId)))
      .run()
    return res.meta.changes ?? 0
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
    const q = this.db
      .select()
      .from(artifact)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(artifact.created_at), desc(artifact.id))
    return (opts?.limit ? q.limit(opts.limit) : q).all()
  }
  async artifactIdsByTag(tag: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: artifactTag.artifact_id })
      .from(artifactTag)
      .where(eq(artifactTag.tag, tag))
      .all()
    return rows.map((r) => r.id)
  }
  async countArtifacts(): Promise<number> {
    const r = await this.db.select({ c: count() }).from(artifact).get()
    return r?.c ?? 0
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
    await this.db.run(
      sql`INSERT INTO view (id, artifact_id, version, viewer, viewer_kind) VALUES (${v.id}, ${v.artifact_id}, ${v.version}, ${v.viewer}, ${v.viewer_kind})`,
    )
  }

  async viewedSince(
    artifactId: string,
    viewer: string,
    version: number,
    sinceIso: string,
  ): Promise<boolean> {
    const row = await this.db.get(
      sql`SELECT 1 FROM view WHERE artifact_id=${artifactId} AND viewer=${viewer} AND version=${version} AND created_at>=${sinceIso} LIMIT 1`,
    )
    return !!row
  }

  async pruneViews(cutoffIso: string): Promise<number> {
    const res = await this.db.run(sql`DELETE FROM view WHERE created_at < ${cutoffIso}`)
    return res.meta.changes ?? 0
  }

  async viewStats(artifactId: string): Promise<ViewStats> {
    const cutoff = new Date(Date.now() - VIEW_WINDOW_MS).toISOString()
    const tot = (await this.db.get(
      sql`SELECT count(*) n FROM view WHERE artifact_id=${artifactId}`,
    )) as { n: number }
    const uni = (await this.db.get(
      sql`SELECT count(DISTINCT viewer) n FROM view WHERE artifact_id=${artifactId}`,
    )) as { n: number }
    const perVersion = (await this.db.all(
      sql`SELECT version, count(*) count FROM view WHERE artifact_id=${artifactId} GROUP BY version ORDER BY version`,
    )) as { version: number; count: number }[]
    const daily = (await this.db.all(
      sql`SELECT substr(created_at,1,10) day, count(*) count FROM view WHERE artifact_id=${artifactId} AND created_at>=${cutoff} GROUP BY day ORDER BY day`,
    )) as { day: string; count: number }[]
    const recent = (await this.db.all(
      sql`SELECT viewer, viewer_kind kind, max(created_at) at FROM view WHERE artifact_id=${artifactId} GROUP BY viewer, viewer_kind ORDER BY at DESC LIMIT 8`,
    )) as { viewer: string; kind: "user" | "anon"; at: string }[]
    return { total: tot.n, unique: uni.n, perVersion, daily, recent }
  }

  async viewCounts(artifactIds: string[]): Promise<Record<string, number>> {
    if (artifactIds.length === 0) return {}
    const ids = sql.join(
      artifactIds.map((id) => sql`${id}`),
      sql`, `,
    )
    const rows = (await this.db.all(
      sql`SELECT artifact_id, count(*) c FROM view WHERE artifact_id IN (${ids}) GROUP BY artifact_id`,
    )) as { artifact_id: string; c: number }[]
    const out: Record<string, number> = {}
    for (const r of rows) out[r.artifact_id] = r.c
    return out
  }

  // ---- Webhooks + outbox -------------------------------------------------
  async createWebhook(w: NewWebhook): Promise<WebhookRecord> {
    return this.db.insert(webhook).values(w).returning().get()
  }
  listWebhooks(): Promise<WebhookRecord[]> {
    return this.db.select().from(webhook).orderBy(desc(webhook.created_at)).all()
  }
  async getWebhook(id: string): Promise<WebhookRecord | null> {
    return (await this.db.select().from(webhook).where(eq(webhook.id, id)).get()) ?? null
  }
  async deleteWebhook(id: string): Promise<void> {
    await this.db.delete(webhook).where(eq(webhook.id, id)).run()
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
      .all()
  }
  async enqueueDelivery(d: NewDelivery): Promise<void> {
    await this.db.insert(webhookDelivery).values(d).run()
  }
  claimDueDeliveries(now: string, limit: number): Promise<DeliveryRecord[]> {
    return this.db
      .select()
      .from(webhookDelivery)
      .where(and(eq(webhookDelivery.status, "pending"), lte(webhookDelivery.next_attempt_at, now)))
      .orderBy(asc(webhookDelivery.next_attempt_at))
      .limit(limit)
      .all()
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
    await this.db.update(webhookDelivery).set(f).where(eq(webhookDelivery.id, id)).run()
  }
  recentDeliveries(webhookId: string, limit: number): Promise<DeliveryRecord[]> {
    return this.db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.webhook_id, webhookId))
      .orderBy(desc(webhookDelivery.created_at))
      .limit(limit)
      .all()
  }

  // ---- Permissions: membership + per-artifact shares ---------------------
  async getMembership(orgId: string, userId: string): Promise<MembershipRecord | null> {
    return (
      (await this.db
        .select()
        .from(membership)
        .where(and(eq(membership.org_id, orgId), eq(membership.user_id, userId)))
        .get()) ?? null
    )
  }
  listMemberships(orgId: string): Promise<MembershipRecord[]> {
    return this.db.select().from(membership).where(eq(membership.org_id, orgId)).all()
  }
  async countMemberships(orgId: string): Promise<number> {
    const r = await this.db
      .select({ n: count() })
      .from(membership)
      .where(eq(membership.org_id, orgId))
      .get()
    return r?.n ?? 0
  }
  setMembership(m: NewMembership): Promise<MembershipRecord> {
    return this.db
      .insert(membership)
      .values(m)
      .onConflictDoUpdate({
        target: [membership.org_id, membership.user_id],
        set: { role: m.role },
      })
      .returning()
      .get()
  }
  async removeMembership(orgId: string, userId: string): Promise<void> {
    await this.db
      .delete(membership)
      .where(and(eq(membership.org_id, orgId), eq(membership.user_id, userId)))
      .run()
  }
  async getWorkspace(orgId: string): Promise<WorkspaceRecord | null> {
    return (await this.db.select().from(workspace).where(eq(workspace.id, orgId)).get()) ?? null
  }
  setWorkspace(orgId: string, name: string): Promise<WorkspaceRecord> {
    return this.db
      .insert(workspace)
      .values({ id: orgId, name })
      .onConflictDoUpdate({ target: workspace.id, set: { name } })
      .returning()
      .get()
  }

  async getArtifactMember(
    artifactId: string,
    userId: string,
  ): Promise<ArtifactMemberRecord | null> {
    return (
      (await this.db
        .select()
        .from(artifactMember)
        .where(and(eq(artifactMember.artifact_id, artifactId), eq(artifactMember.user_id, userId)))
        .get()) ?? null
    )
  }
  listArtifactMembers(artifactId: string): Promise<ArtifactMemberRecord[]> {
    return this.db
      .select()
      .from(artifactMember)
      .where(eq(artifactMember.artifact_id, artifactId))
      .all()
  }
  setArtifactMember(m: NewArtifactMember): Promise<ArtifactMemberRecord> {
    return this.db
      .insert(artifactMember)
      .values(m)
      .onConflictDoUpdate({
        target: [artifactMember.artifact_id, artifactMember.user_id],
        set: { role: m.role },
      })
      .returning()
      .get()
  }
  async removeArtifactMember(artifactId: string, userId: string): Promise<void> {
    await this.db
      .delete(artifactMember)
      .where(and(eq(artifactMember.artifact_id, artifactId), eq(artifactMember.user_id, userId)))
      .run()
  }

  // ---- Favorites + tags --------------------------------------------------
  async listUserFavoriteIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: artifactFavorite.artifact_id })
      .from(artifactFavorite)
      .where(eq(artifactFavorite.user_id, userId))
      .all()
    return rows.map((r) => r.id)
  }
  async setFavorite(artifactId: string, userId: string): Promise<void> {
    await this.db
      .insert(artifactFavorite)
      .values({ id: crypto.randomUUID(), artifact_id: artifactId, user_id: userId })
      .onConflictDoNothing({ target: [artifactFavorite.artifact_id, artifactFavorite.user_id] })
      .run()
  }
  async removeFavorite(artifactId: string, userId: string): Promise<void> {
    await this.db
      .delete(artifactFavorite)
      .where(
        and(eq(artifactFavorite.artifact_id, artifactId), eq(artifactFavorite.user_id, userId)),
      )
      .run()
  }
  async tagsForArtifacts(artifactIds: string[]): Promise<Record<string, string[]>> {
    if (artifactIds.length === 0) return {}
    const rows = await this.db
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
  // D1 has no interactive transactions; replace is delete-then-insert.
  async setArtifactTags(artifactId: string, tags: string[]): Promise<void> {
    await this.db.delete(artifactTag).where(eq(artifactTag.artifact_id, artifactId)).run()
    if (tags.length)
      await this.db
        .insert(artifactTag)
        .values(tags.map((tag) => ({ id: crypto.randomUUID(), artifact_id: artifactId, tag })))
        .run()
  }

  // ---- Collections (no interactive transactions on D1; sequential writes) -
  async createCollection(c: NewCollection): Promise<CollectionRecord> {
    return this.db.insert(collection).values(c).returning().get()
  }
  async getCollection(id: string): Promise<CollectionRecord | null> {
    return (await this.db.select().from(collection).where(eq(collection.id, id)).get()) ?? null
  }
  async updateCollection(id: string, fields: { title?: string }): Promise<CollectionRecord | null> {
    if (fields.title === undefined) return this.getCollection(id)
    return (
      (await this.db
        .update(collection)
        .set({ title: fields.title })
        .where(eq(collection.id, id))
        .returning()
        .get()) ?? null
    )
  }
  async deleteCollection(id: string): Promise<void> {
    await this.db.delete(collectionItem).where(eq(collectionItem.collection_id, id)).run()
    await this.db.delete(collectionMember).where(eq(collectionMember.collection_id, id)).run()
    await this.db.delete(collection).where(eq(collection.id, id)).run()
  }
  async listCollections(): Promise<(CollectionRecord & { count: number })[]> {
    const rows = await this.db.select().from(collection).orderBy(desc(collection.created_at)).all()
    const counts = await this.db
      .select({ id: collectionItem.collection_id, c: count() })
      .from(collectionItem)
      .groupBy(collectionItem.collection_id)
      .all()
    const cmap = new Map(counts.map((r) => [r.id, r.c]))
    return rows.map((r) => ({ ...r, count: cmap.get(r.id) ?? 0 }))
  }
  async collectionArtifactIds(collectionId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: collectionItem.artifact_id })
      .from(collectionItem)
      .where(eq(collectionItem.collection_id, collectionId))
      .all()
    return rows.map((r) => r.id)
  }
  async collectionIdsForArtifact(artifactId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: collectionItem.collection_id })
      .from(collectionItem)
      .where(eq(collectionItem.artifact_id, artifactId))
      .all()
    return rows.map((r) => r.id)
  }
  async addCollectionItem(collectionId: string, artifactId: string): Promise<void> {
    await this.db
      .insert(collectionItem)
      .values({ id: crypto.randomUUID(), collection_id: collectionId, artifact_id: artifactId })
      .onConflictDoNothing({ target: [collectionItem.collection_id, collectionItem.artifact_id] })
      .run()
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
      .run()
  }
  async getCollectionMember(
    collectionId: string,
    userId: string,
  ): Promise<CollectionMemberRecord | null> {
    return (
      (await this.db
        .select()
        .from(collectionMember)
        .where(
          and(
            eq(collectionMember.collection_id, collectionId),
            eq(collectionMember.user_id, userId),
          ),
        )
        .get()) ?? null
    )
  }
  listCollectionMembers(collectionId: string): Promise<CollectionMemberRecord[]> {
    return this.db
      .select()
      .from(collectionMember)
      .where(eq(collectionMember.collection_id, collectionId))
      .all()
  }
  setCollectionMember(m: NewCollectionMember): Promise<CollectionMemberRecord> {
    return this.db
      .insert(collectionMember)
      .values(m)
      .onConflictDoUpdate({
        target: [collectionMember.collection_id, collectionMember.user_id],
        set: { role: m.role },
      })
      .returning()
      .get()
  }
  async removeCollectionMember(collectionId: string, userId: string): Promise<void> {
    await this.db
      .delete(collectionMember)
      .where(
        and(eq(collectionMember.collection_id, collectionId), eq(collectionMember.user_id, userId)),
      )
      .run()
  }
  async collectionRolesForArtifact(artifactId: string, userId: string): Promise<Role[]> {
    const rows = await this.db
      .select({ role: collectionMember.role })
      .from(collectionMember)
      .innerJoin(collectionItem, eq(collectionItem.collection_id, collectionMember.collection_id))
      .where(and(eq(collectionItem.artifact_id, artifactId), eq(collectionMember.user_id, userId)))
      .all()
    return rows.map((r) => r.role)
  }

  // ---- Reviews: proposed versions ----------------------------------------
  createProposal(p: NewProposal): Promise<ProposalRecord> {
    return this.db.insert(proposal).values(p).returning().get()
  }
  async getProposal(id: string): Promise<ProposalRecord | null> {
    return (await this.db.select().from(proposal).where(eq(proposal.id, id)).get()) ?? null
  }
  listProposals(artifactId: string, opts?: { state?: ProposalState }): Promise<ProposalRecord[]> {
    const where = opts?.state
      ? and(eq(proposal.artifact_id, artifactId), eq(proposal.state, opts.state))
      : eq(proposal.artifact_id, artifactId)
    return this.db.select().from(proposal).where(where).orderBy(desc(proposal.created_at)).all()
  }
  async openProposalCounts(artifactIds: string[]): Promise<Record<string, number>> {
    if (artifactIds.length === 0) return {}
    const ids = sql.join(
      artifactIds.map((id) => sql`${id}`),
      sql`, `,
    )
    const rows = (await this.db.all(
      sql`SELECT artifact_id, count(*) c FROM proposal WHERE state='open' AND artifact_id IN (${ids}) GROUP BY artifact_id`,
    )) as { artifact_id: string; c: number }[]
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
      (await this.db
        .update(proposal)
        .set({ ...fields, decided_at: new Date().toISOString() })
        .where(eq(proposal.id, id))
        .returning()
        .get()) ?? null
    )
  }

  // ---- User directory (Better Auth's `user` table; raw, may be absent) ---
  async findUserByEmail(email: string): Promise<UserDir | null> {
    try {
      return (
        ((await this.db.get(
          sql`SELECT id, email, name FROM user WHERE email = ${email}`,
        )) as UserDir) ?? null
      )
    } catch {
      return null
    }
  }
  async getUsers(ids: string[]): Promise<UserDir[]> {
    if (ids.length === 0) return []
    try {
      const list = sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )
      return (await this.db.all(
        sql`SELECT id, email, name FROM user WHERE id IN (${list})`,
      )) as UserDir[]
    } catch {
      return []
    }
  }

  // ---- Notifications (in-app, one row per recipient) ---------------------
  async createNotification(n: NewNotification): Promise<void> {
    await this.db.insert(notification).values(n).run()
  }
  listNotifications(userId: string, limit: number): Promise<NotificationRecord[]> {
    return this.db
      .select()
      .from(notification)
      .where(eq(notification.user_id, userId))
      .orderBy(desc(notification.created_at))
      .limit(limit)
      .all()
  }
  async unreadNotificationCount(userId: string): Promise<number> {
    const r = await this.db
      .select({ n: count() })
      .from(notification)
      .where(and(eq(notification.user_id, userId), eq(notification.read, 0)))
      .get()
    return r?.n ?? 0
  }
  async markNotificationsRead(userId: string, ids: string[] | "all"): Promise<void> {
    const where =
      ids === "all"
        ? eq(notification.user_id, userId)
        : ids.length > 0
          ? and(eq(notification.user_id, userId), inArray(notification.id, ids))
          : null
    if (!where) return
    await this.db.update(notification).set({ read: 1 }).where(where).run()
  }

  // ---- Agents + their pull inbox -----------------------------------------
  createAgent(a: NewAgent): Promise<AgentRecord> {
    return this.db.insert(agent).values(a).returning().get()
  }
  listAgents(orgId: string): Promise<AgentRecord[]> {
    return this.db.select().from(agent).where(eq(agent.org_id, orgId)).all()
  }
  async getAgentByToken(token: string): Promise<AgentRecord | null> {
    return (await this.db.select().from(agent).where(eq(agent.token, token)).get()) ?? null
  }
  async deleteAgent(id: string): Promise<void> {
    await this.db.delete(agent).where(eq(agent.id, id)).run()
  }
  async createAgentMention(m: NewAgentMention): Promise<void> {
    await this.db.insert(agentMention).values(m).run()
  }
  listPendingAgentMentions(agentId: string, limit: number): Promise<AgentMentionRecord[]> {
    return this.db
      .select()
      .from(agentMention)
      .where(and(eq(agentMention.agent_id, agentId), eq(agentMention.state, "pending")))
      .orderBy(asc(agentMention.created_at))
      .limit(limit)
      .all()
  }
  async ackAgentMention(agentId: string, id: string): Promise<boolean> {
    const res = await this.db
      .update(agentMention)
      .set({ state: "done" })
      .where(and(eq(agentMention.id, id), eq(agentMention.agent_id, agentId)))
      .run()
    return (res.meta.changes ?? 0) > 0
  }
}
