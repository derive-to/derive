import type {
  ArtifactRecord,
  MetaStore,
  NewArtifact,
  NewVersion,
  VersionRecord,
} from "@dock/core"

/** Minimal structural type for a Cloudflare D1 binding (avoids a hard dep on workers-types). */
export interface D1Like {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T = unknown>(): Promise<T | null>
      run(): Promise<unknown>
      all<T = unknown>(): Promise<{ results: T[] }>
    }
  }
}

/**
 * Hosted driver: Cloudflare D1 — same SQL as the SQLite driver.
 * Apply deploy/d1-schema.sql once via `wrangler d1 migrations` before first use.
 * NOTE: addVersion is read-then-write without a transaction (D1 has no interactive
 * transactions); the UNIQUE(artifact_id, n) constraint turns races into clean 500s.
 */
export class D1MetaStore implements MetaStore {
  constructor(private db: D1Like) {}

  async createArtifact(a: NewArtifact): Promise<ArtifactRecord> {
    await this.db
      .prepare(
        `INSERT INTO artifact (id, short_id, org_id, slug, title, visibility, kind, spa)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(a.id, a.short_id, a.org_id, a.slug, a.title, a.visibility, a.kind, a.spa)
      .run()
    return (await this.getByShortId(a.short_id)) as ArtifactRecord
  }

  async getByShortId(shortId: string): Promise<ArtifactRecord | null> {
    return this.db
      .prepare(`SELECT * FROM artifact WHERE short_id = ?`)
      .bind(shortId)
      .first<ArtifactRecord>()
  }

  async addVersion(artifactId: string, v: NewVersion): Promise<VersionRecord> {
    const row = await this.db
      .prepare(`SELECT current_version FROM artifact WHERE id = ?`)
      .bind(artifactId)
      .first<{ current_version: number }>()
    if (!row) throw new Error(`artifact not found: ${artifactId}`)
    const n = row.current_version + 1
    await this.db
      .prepare(
        `INSERT INTO version (id, artifact_id, n, blob_key, content_type, author, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(v.id, artifactId, n, v.blob_key, v.content_type, v.author, v.message)
      .run()
    await this.db
      .prepare(`UPDATE artifact SET current_version = ? WHERE id = ?`)
      .bind(n, artifactId)
      .run()
    return (await this.getVersion(artifactId, n)) as VersionRecord
  }

  async listVersions(artifactId: string): Promise<VersionRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM version WHERE artifact_id = ? ORDER BY n ASC`)
      .bind(artifactId)
      .all<VersionRecord>()
    return results
  }

  async getVersion(artifactId: string, n: number): Promise<VersionRecord | null> {
    return this.db
      .prepare(`SELECT * FROM version WHERE artifact_id = ? AND n = ?`)
      .bind(artifactId, n)
      .first<VersionRecord>()
  }
}
