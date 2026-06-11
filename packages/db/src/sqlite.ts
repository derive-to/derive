import Database from "better-sqlite3"
import type {
  ArtifactRecord,
  MetaStore,
  NewArtifact,
  NewVersion,
  VersionRecord,
} from "@dock/core"
import { SCHEMA_STATEMENTS } from "./schema"

/** Embedded SQLite (WAL). The zero-dependency default; no external services. */
export class SqliteMetaStore implements MetaStore {
  private db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma("journal_mode = WAL")
    for (const stmt of SCHEMA_STATEMENTS) this.db.exec(stmt)
  }

  async createArtifact(a: NewArtifact): Promise<ArtifactRecord> {
    this.db
      .prepare(
        `INSERT INTO artifact (id, short_id, org_id, slug, title, visibility, kind, spa)
         VALUES (@id, @short_id, @org_id, @slug, @title, @visibility, @kind, @spa)`,
      )
      .run(a)
    return (await this.getByShortId(a.short_id)) as ArtifactRecord
  }

  async getByShortId(shortId: string): Promise<ArtifactRecord | null> {
    const row = this.db.prepare(`SELECT * FROM artifact WHERE short_id = ?`).get(shortId)
    return (row as ArtifactRecord | undefined) ?? null
  }

  async addVersion(artifactId: string, v: NewVersion): Promise<VersionRecord> {
    const insert = this.db.transaction((nv: NewVersion): number => {
      const row = this.db
        .prepare(`SELECT current_version FROM artifact WHERE id = ?`)
        .get(artifactId) as { current_version: number } | undefined
      if (!row) throw new Error(`artifact not found: ${artifactId}`)
      const n = row.current_version + 1
      this.db
        .prepare(
          `INSERT INTO version (id, artifact_id, n, blob_key, content_type, author, message)
           VALUES (@id, @artifact_id, @n, @blob_key, @content_type, @author, @message)`,
        )
        .run({ ...nv, artifact_id: artifactId, n })
      this.db.prepare(`UPDATE artifact SET current_version = ? WHERE id = ?`).run(n, artifactId)
      return n
    })
    const n = insert(v)
    return (await this.getVersion(artifactId, n)) as VersionRecord
  }

  async listVersions(artifactId: string): Promise<VersionRecord[]> {
    return this.db
      .prepare(`SELECT * FROM version WHERE artifact_id = ? ORDER BY n ASC`)
      .all(artifactId) as VersionRecord[]
  }

  async getVersion(artifactId: string, n: number): Promise<VersionRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM version WHERE artifact_id = ? AND n = ?`)
      .get(artifactId, n)
    return (row as VersionRecord | undefined) ?? null
  }

  close(): void {
    this.db.close()
  }
}
