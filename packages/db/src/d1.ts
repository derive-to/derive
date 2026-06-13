import type { D1Database } from "@cloudflare/workers-types"
import type {
  ArtifactMemberRecord,
  ArtifactRecord,
  CommentRecord,
  CommentState,
  DeliveryRecord,
  DeliveryStatus,
  MembershipRecord,
  MetaStore,
  NewArtifact,
  NewArtifactMember,
  NewComment,
  NewDelivery,
  NewMembership,
  NewNotification,
  NewVersion,
  NewView,
  NewWebhook,
  NotificationRecord,
  UserDir,
  VersionRecord,
  ViewStats,
  WebhookRecord,
} from "@dock/core"
import { and, asc, count, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm"
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1"
import {
  artifact,
  artifactMember,
  comment,
  membership,
  notification,
  version,
  webhook,
  webhookDelivery,
} from "./schema"

const schema = {
  artifact,
  version,
  comment,
  webhook,
  webhookDelivery,
  membership,
  artifactMember,
  notification,
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

  async listArtifacts(opts?: { limit?: number }): Promise<ArtifactRecord[]> {
    const q = this.db.select().from(artifact).orderBy(desc(artifact.created_at))
    return (opts?.limit ? q.limit(opts.limit) : q).all()
  }

  async recordView(v: NewView): Promise<void> {
    await this.db.run(
      sql`INSERT INTO view (id, artifact_id, version, viewer, viewer_kind) VALUES (${v.id}, ${v.artifact_id}, ${v.version}, ${v.viewer}, ${v.viewer_kind})`,
    )
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
}
