import Database from "better-sqlite3"
import { and, asc, eq } from "drizzle-orm"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type {
  ArtifactRecord,
  MetaStore,
  NewArtifact,
  NewVersion,
  VersionRecord,
} from "@dock/core"
import { SCHEMA_STATEMENTS, artifact, version } from "./schema"

const schema = { artifact, version }

/** Embedded SQLite (WAL). The zero-dependency default; no external services. */
export class SqliteMetaStore implements MetaStore {
  private raw: Database.Database
  private db: BetterSQLite3Database<typeof schema>

  constructor(path: string) {
    this.raw = new Database(path)
    this.raw.pragma("journal_mode = WAL")
    for (const stmt of SCHEMA_STATEMENTS) this.raw.exec(stmt)
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

  close(): void {
    this.raw.close()
  }
}
