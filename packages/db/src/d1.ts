import type { D1Database } from "@cloudflare/workers-types"
import { and, asc, eq } from "drizzle-orm"
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1"
import type {
  ArtifactRecord,
  MetaStore,
  NewArtifact,
  NewVersion,
  VersionRecord,
} from "@dock/core"
import { artifact, version } from "./schema"

const schema = { artifact, version }

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
    return (await this.db.select().from(artifact).where(eq(artifact.short_id, shortId)).get()) ?? null
  }

  async addVersion(artifactId: string, v: NewVersion): Promise<VersionRecord> {
    const row = await this.db
      .select({ cv: artifact.current_version })
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .get()
    if (!row) throw new Error(`artifact not found: ${artifactId}`)
    const n = row.cv + 1
    await this.db.insert(version).values({ ...v, artifact_id: artifactId, n }).run()
    await this.db.update(artifact).set({ current_version: n }).where(eq(artifact.id, artifactId)).run()
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
}
