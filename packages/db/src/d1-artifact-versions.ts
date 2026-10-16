import type { D1Database } from "@cloudflare/workers-types"
import type { ArtifactRecord, NewArtifact, NewVersion, VersionRecord } from "@derive/core"
import { and, eq, sql } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import {
  artifactVersionFields,
  publishedArtifactFields,
  replacementVersionFields,
} from "./publication-fields"
import { schema } from "./repos"

/** Native D1 batches commit the row, head, and fact invalidation together. */
export const d1ArtifactVersions = (d1: D1Database, db: DrizzleD1Database<typeof schema>) => {
  const { artifact, version, versionData } = schema
  const prepare = (query: { sql: string; params: unknown[] }) =>
    d1.prepare(query.sql).bind(...query.params)
  const dialect = new SQLiteSyncDialect()

  const append = async (
    artifactId: string,
    v: NewVersion,
    expected?: number,
  ): Promise<VersionRecord | null> => {
    const at = new Date().toISOString()
    const insert = sql`insert into version (id, artifact_id, n, blob_key, content_type, size_bytes,
      author, author_login, author_avatar, author_gh_id, author_id, agent_id, agent_name,
      source, message, name, edit_session, created_at)
      select ${v.id}, id, current_version + 1, ${v.blob_key}, ${v.content_type}, ${v.size_bytes ?? 0},
      ${v.author}, ${v.author_login ?? null}, ${v.author_avatar ?? null}, ${v.author_gh_id ?? null},
      ${v.author_id ?? null}, ${v.agent_id ?? null}, ${v.agent_name ?? null}, ${v.source ?? null},
      ${v.message ?? null}, ${v.name ?? null}, ${v.edit_session ?? null}, ${at}
      from artifact where id = ${artifactId}
      ${expected === undefined ? sql`` : sql`and current_version = ${expected}`}`
    const bump = db
      .update(artifact)
      .set({
        ...artifactVersionFields(v, 0, at),
        current_version: sql`(select n from version where id = ${v.id})`,
      })
      .where(and(eq(artifact.id, artifactId), sql`changes() > 0`))
      .toSQL()
    // A reused id can exist even when the conditional INSERT writes nothing.
    // Only return a version after this batch updates the head.
    const read = db
      .select()
      .from(version)
      .where(and(eq(version.id, v.id), eq(version.artifact_id, artifactId), sql`changes() > 0`))
      .toSQL()
    const results = await d1.batch<VersionRecord>([
      prepare(dialect.sqlToQuery(insert)),
      prepare(bump),
      prepare(read),
    ])
    return results[2]?.results[0] ?? null
  }

  return {
    createPublishedArtifact: async (
      a: NewArtifact,
      v: NewVersion,
    ): Promise<{ artifact: ArtifactRecord; version: VersionRecord }> => {
      const at = new Date().toISOString()
      const create = db
        .insert(artifact)
        .values(publishedArtifactFields(a, v, at))
        .toSQL()
      const first = db
        .insert(version)
        .values({ ...v, artifact_id: a.id, n: 1, created_at: at })
        .toSQL()
      const readArtifact = db.select().from(artifact).where(eq(artifact.id, a.id)).toSQL()
      const readVersion = db.select().from(version).where(eq(version.id, v.id)).toSQL()
      const result = await d1.batch<ArtifactRecord | VersionRecord>([
        prepare(create),
        prepare(first),
        prepare(readArtifact),
        prepare(readVersion),
      ])
      const created = result[2]?.results[0] as ArtifactRecord | undefined
      const saved = result[3]?.results[0] as VersionRecord | undefined
      if (!created || !saved) throw new Error("Publication did not create both records")
      return { artifact: created, version: saved }
    },
    addVersion: async (artifactId: string, v: NewVersion): Promise<VersionRecord> => {
      const saved = await append(artifactId, v)
      if (!saved) throw new Error(`artifact not found: ${artifactId}`)
      return saved
    },
    addVersionIfCurrent: (
      artifactId: string,
      expected: number,
      v: NewVersion,
    ): Promise<VersionRecord | null> => append(artifactId, v, expected),
    replaceCurrentVersion: async (
      artifactId: string,
      expected: { n: number; blobKey: string },
      v: NewVersion,
    ): Promise<VersionRecord | null> => {
      const at = new Date().toISOString()
      const replace = db
        .update(version)
        .set(replacementVersionFields(v, at))
        .where(
          and(
            eq(version.artifact_id, artifactId),
            eq(version.n, expected.n),
            eq(version.blob_key, expected.blobKey),
            sql`exists (select 1 from artifact where id = ${artifactId} and current_version = ${expected.n})`,
          ),
        )
        .returning()
        .toSQL()
      // changes() belongs to this transaction's preceding statement. Bump before deleting facts,
      // so an empty facts table cannot hide a successful replacement.
      const bump = db
        .update(artifact)
        .set(artifactVersionFields(v, expected.n, at))
        .where(and(eq(artifact.id, artifactId), sql`changes() > 0`))
        .toSQL()
      const facts = db
        .delete(versionData)
        .where(
          and(
            eq(versionData.artifact_id, artifactId),
            eq(versionData.n, expected.n),
            sql`changes() > 0`,
          ),
        )
        .toSQL()
      const result = await d1.batch<VersionRecord>([
        prepare(replace),
        prepare(bump),
        prepare(facts),
      ])
      return result[0]?.results[0] ?? null
    },
  }
}
