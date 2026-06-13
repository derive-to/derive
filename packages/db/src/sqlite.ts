import Database from "better-sqlite3"
import { and, asc, desc, eq, isNull, lte, or } from "drizzle-orm"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type {
  ArtifactRecord,
  CommentRecord,
  CommentState,
  DeliveryRecord,
  DeliveryStatus,
  MetaStore,
  NewArtifact,
  NewComment,
  NewDelivery,
  NewVersion,
  NewView,
  NewWebhook,
  VersionRecord,
  ViewStats,
  WebhookRecord,
} from "@dock/core"
import { MIGRATION_STATEMENTS, SCHEMA_STATEMENTS, artifact, comment, version, webhook, webhookDelivery } from "./schema"

const VIEW_WINDOW_MS = 30 * 86400_000

const schema = { artifact, version, comment, webhook, webhookDelivery }

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
      tx.insert(version).values({ ...v, artifact_id: artifactId, n: next }).run()
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

  async setThreadState(
    artifactId: string,
    threadId: string,
    state: CommentState,
  ): Promise<number> {
    const res = this.db
      .update(comment)
      .set({ state })
      .where(and(eq(comment.artifact_id, artifactId), eq(comment.thread_id, threadId)))
      .run()
    return res.changes
  }

  async listArtifacts(opts?: { limit?: number }): Promise<ArtifactRecord[]> {
    const q = this.db.select().from(artifact).orderBy(desc(artifact.created_at))
    return opts?.limit ? q.limit(opts.limit).all() : q.all()
  }

  async recordView(v: NewView): Promise<void> {
    this.raw
      .prepare(`INSERT INTO view (id, artifact_id, version, viewer, viewer_kind) VALUES (?,?,?,?,?)`)
      .run(v.id, v.artifact_id, v.version, v.viewer, v.viewer_kind)
  }

  async viewStats(artifactId: string): Promise<ViewStats> {
    const cutoff = new Date(Date.now() - VIEW_WINDOW_MS).toISOString()
    const n = (q: string, ...p: unknown[]) =>
      (this.raw.prepare(q).get(...p) as { n: number }).n
    return {
      total: n(`SELECT count(*) n FROM view WHERE artifact_id=?`, artifactId),
      unique: n(`SELECT count(DISTINCT viewer) n FROM view WHERE artifact_id=?`, artifactId),
      perVersion: this.raw
        .prepare(`SELECT version, count(*) count FROM view WHERE artifact_id=? GROUP BY version ORDER BY version`)
        .all(artifactId) as { version: number; count: number }[],
      daily: this.raw
        .prepare(`SELECT substr(created_at,1,10) day, count(*) count FROM view WHERE artifact_id=? AND created_at>=? GROUP BY day ORDER BY day`)
        .all(artifactId, cutoff) as { day: string; count: number }[],
      recent: this.raw
        .prepare(`SELECT viewer, viewer_kind kind, max(created_at) at FROM view WHERE artifact_id=? GROUP BY viewer, viewer_kind ORDER BY at DESC LIMIT 8`)
        .all(artifactId) as { viewer: string; kind: "user" | "anon"; at: string }[],
    }
  }

  async viewCounts(artifactIds: string[]): Promise<Record<string, number>> {
    if (artifactIds.length === 0) return {}
    const ph = artifactIds.map(() => "?").join(",")
    const rows = this.raw
      .prepare(`SELECT artifact_id, count(*) c FROM view WHERE artifact_id IN (${ph}) GROUP BY artifact_id`)
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
        .where(and(eq(webhook.active, 1), or(isNull(webhook.artifact_id), eq(webhook.artifact_id, artifactId))))
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
        .where(and(eq(webhookDelivery.status, "pending"), lte(webhookDelivery.next_attempt_at, now)))
        .orderBy(asc(webhookDelivery.next_attempt_at))
        .limit(limit)
        .all(),
    )
  }
  async updateDelivery(
    id: string,
    f: { status: DeliveryStatus; attempts: number; last_error: string | null; next_attempt_at: string },
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

  close(): void {
    this.raw.close()
  }
}
