import { Pool } from "pg"
import type {
  ArtifactRecord,
  CommentRecord,
  CommentState,
  MetaStore,
  NewArtifact,
  NewComment,
  NewVersion,
  VersionRecord,
} from "@dock/core"
import { PG_SCHEMA_STATEMENTS } from "./pg-schema"

/**
 * Postgres metadata store (Neon, RDS, self-hosted) for horizontal scale — the
 * container is stateless and many instances share one database. Same interface
 * and record shapes as the SQLite driver. Raw parameterized SQL via node-postgres
 * keeps it dialect-explicit and free of the query-builder version skew.
 */
export class PgMetaStore implements MetaStore {
  private constructor(private pool: Pool) {}

  /** Connect and apply the schema (idempotent) before first use. */
  static async create(connectionString: string): Promise<PgMetaStore> {
    const pool = new Pool({ connectionString })
    for (const stmt of PG_SCHEMA_STATEMENTS) await pool.query(stmt)
    return new PgMetaStore(pool)
  }

  private async one<T>(text: string, params: unknown[]): Promise<T | null> {
    const { rows } = await this.pool.query(text, params)
    return (rows[0] as T) ?? null
  }

  async createArtifact(a: NewArtifact): Promise<ArtifactRecord> {
    await this.pool.query(
      `INSERT INTO artifact (id, short_id, org_id, slug, title, visibility, kind, spa)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [a.id, a.short_id, a.org_id, a.slug, a.title, a.visibility, a.kind, a.spa],
    )
    return (await this.getByShortId(a.short_id)) as ArtifactRecord
  }

  getByShortId(shortId: string): Promise<ArtifactRecord | null> {
    return this.one<ArtifactRecord>(`SELECT * FROM artifact WHERE short_id = $1`, [shortId])
  }

  async addVersion(artifactId: string, v: NewVersion): Promise<VersionRecord> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const cur = await client.query(
        `SELECT current_version FROM artifact WHERE id = $1 FOR UPDATE`,
        [artifactId],
      )
      if (!cur.rows[0]) throw new Error(`artifact not found: ${artifactId}`)
      const next = (cur.rows[0].current_version as number) + 1
      await client.query(
        `INSERT INTO version (id, artifact_id, n, blob_key, content_type, author, message)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [v.id, artifactId, next, v.blob_key, v.content_type, v.author, v.message],
      )
      await client.query(`UPDATE artifact SET current_version = $1 WHERE id = $2`, [
        next,
        artifactId,
      ])
      await client.query("COMMIT")
      return (await this.getVersion(artifactId, next)) as VersionRecord
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  }

  async listVersions(artifactId: string): Promise<VersionRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM version WHERE artifact_id = $1 ORDER BY n ASC`,
      [artifactId],
    )
    return rows as VersionRecord[]
  }

  getVersion(artifactId: string, n: number): Promise<VersionRecord | null> {
    return this.one<VersionRecord>(`SELECT * FROM version WHERE artifact_id = $1 AND n = $2`, [
      artifactId,
      n,
    ])
  }

  async createComment(c: NewComment): Promise<CommentRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO comment (id, artifact_id, thread_id, base_version, path, anchor, body_md, author)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [c.id, c.artifact_id, c.thread_id, c.base_version, c.path, c.anchor, c.body_md, c.author],
    )
    return rows[0] as CommentRecord
  }

  getComment(id: string): Promise<CommentRecord | null> {
    return this.one<CommentRecord>(`SELECT * FROM comment WHERE id = $1`, [id])
  }

  async listComments(artifactId: string, opts?: { state?: CommentState }): Promise<CommentRecord[]> {
    const { rows } = opts?.state
      ? await this.pool.query(
          `SELECT * FROM comment WHERE artifact_id = $1 AND state = $2 ORDER BY created_at ASC`,
          [artifactId, opts.state],
        )
      : await this.pool.query(
          `SELECT * FROM comment WHERE artifact_id = $1 ORDER BY created_at ASC`,
          [artifactId],
        )
    return rows as CommentRecord[]
  }

  async setThreadState(
    artifactId: string,
    threadId: string,
    state: CommentState,
  ): Promise<number> {
    const res = await this.pool.query(
      `UPDATE comment SET state = $1 WHERE artifact_id = $2 AND thread_id = $3`,
      [state, artifactId, threadId],
    )
    return res.rowCount ?? 0
  }

  async listArtifacts(opts?: { limit?: number }): Promise<ArtifactRecord[]> {
    const { rows } = opts?.limit
      ? await this.pool.query(`SELECT * FROM artifact ORDER BY created_at DESC LIMIT $1`, [
          opts.limit,
        ])
      : await this.pool.query(`SELECT * FROM artifact ORDER BY created_at DESC`)
    return rows as ArtifactRecord[]
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
