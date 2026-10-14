import type { ArtifactStore } from "@aniraga/open-artifact-server/kit"
import { artifactRowOf, versionRowOf } from "./artifact-store-records"
import type { ArtifactRecord, MetaStore } from "./ports"

// Native D1 queries allow 100 parameters. Leave room for filters and the page limit.
const pages = (ids: readonly string[]) =>
  Array.from({ length: Math.ceil(ids.length / 80) }, (_, i) => ids.slice(i * 80, i * 80 + 80))

const projectArtifacts = async (meta: MetaStore, artifacts: ArtifactRecord[]) => {
  const ids = artifacts.map((artifact) => artifact.id)
  const versions = await Promise.all(
    pages(ids).map((page) =>
      Promise.all([
        meta.versionsForArtifacts(page, { n: 1, limit: page.length }),
        meta.currentVersions(page),
      ]),
    ),
  )
  const firstById = new Map(
    versions.flatMap(([first]) => first.map((version) => [version.artifact_id, version] as const)),
  )
  const currentById = new Map(versions.flatMap(([, current]) => Object.entries(current)))
  return artifacts.map((artifact) =>
    artifactRowOf(artifact, {
      first: firstById.get(artifact.id),
      current: currentById.get(artifact.id),
    }),
  )
}

type Reads = Pick<
  ArtifactStore,
  "getArtifact" | "listArtifacts" | "getVersion" | "listVersions" | "threadActivity"
>

/** Native rows remain the source of truth for the shared kit. */
export const artifactStoreReads = (meta: MetaStore): Reads => ({
  getArtifact: async (id) => {
    const row = await meta.getArtifactById(id)
    return row && !row.removed_at ? ((await projectArtifacts(meta, [row]))[0] ?? null) : null
  },
  listArtifacts: async (page) => {
    if (!page.space) return []
    return projectArtifacts(
      meta,
      await meta.listArtifacts({
        orgId: page.space,
        sort: "updated",
        limit: page.limit,
        cursor: page.after ? { key: page.after.updatedAt, id: page.after.id } : undefined,
        textSearch: page.search,
        firstAuthorId: page.createdBy,
        excludeRemoved: true,
      }),
    )
  },
  getVersion: async (id, n) => {
    const row = await meta.getVersion(id, n)
    return row ? versionRowOf(row) : null
  },
  listVersions: async (id) => (await meta.listVersions(id)).map(versionRowOf),
  threadActivity: async (ids) =>
    (await Promise.all(pages(ids).map((page) => meta.commentActivity(page)))).flat().map((row) => ({
      artifactId: row.artifact_id,
      open: row.open_threads,
      total: row.threads,
      people: row.people.map((person) => ({
        id: person.author_id ?? `legacy:${person.author}`,
        name: person.author,
      })),
    })),
})
