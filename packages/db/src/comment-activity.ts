import type { CommentActivityRecord } from "@derive/core"
import { type SQL, sql } from "drizzle-orm"

type Counts = { artifact_id: string; open_threads: number | string; threads: number | string }
type Person = { artifact_id: string; author_id: string | null; author: string }

/** Both native stores count threads and bound author reads before returning rows. */
export const readCommentActivity = async (
  execute: (statement: SQL) => Promise<unknown[]>,
  artifactIds: string[],
): Promise<CommentActivityRecord[]> => {
  if (!artifactIds.length) return []
  const ids = sql.join(
    artifactIds.map((id) => sql`${id}`),
    sql`, `,
  )
  const [counts, people] = await Promise.all([
    execute(sql`SELECT artifact_id,
      count(DISTINCT CASE WHEN state = 'open' THEN thread_id END) AS open_threads,
      count(DISTINCT thread_id) AS threads
      FROM comment WHERE artifact_id IN (${ids}) GROUP BY artifact_id`),
    execute(sql`SELECT artifact_id, author_id, author FROM (
      SELECT artifact_id, author_id, author,
        row_number() OVER (PARTITION BY artifact_id ORDER BY created_at DESC, id DESC) AS recent
      FROM (
        SELECT artifact_id, author_id, author, created_at, id,
          row_number() OVER (
            PARTITION BY artifact_id, author_id,
              CASE WHEN author_id IS NULL THEN author ELSE '' END
            ORDER BY created_at DESC, id DESC
          ) AS person
        FROM comment WHERE artifact_id IN (${ids})
      ) distinct_authors WHERE person = 1
    ) latest_authors WHERE recent <= 5 ORDER BY artifact_id, recent`),
  ])
  const byArtifact = new Map<string, CommentActivityRecord["people"]>()
  for (const person of people as Person[]) {
    const own = byArtifact.get(person.artifact_id) ?? []
    own.push({ author_id: person.author_id, author: person.author })
    byArtifact.set(person.artifact_id, own)
  }
  return (counts as Counts[]).map((row) => ({
    artifact_id: row.artifact_id,
    open_threads: Number(row.open_threads),
    threads: Number(row.threads),
    people: byArtifact.get(row.artifact_id) ?? [],
  }))
}
