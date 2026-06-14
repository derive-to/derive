import { type BlobStore, type MetaStore, publish, type RepoSourceRecord } from "@dock/core"
import { fetchBlob, listTree, matchesGlobs, parseRepo } from "./github"

/** Per-path mirror state, persisted as JSON in repo_source.files. */
export interface SyncedFile {
  artifact_id: string
  short_id: string
  /** The git blob sha last mirrored — a re-sync skips a file whose sha is unchanged. */
  sha: string
}
type FileMap = Record<string, SyncedFile>

export interface SyncResult {
  added: number
  updated: number
  removed: number
  skipped: number
}

const basename = (path: string): string => path.split("/").pop() || path
const parseMap = (json: string): FileMap => {
  try {
    return JSON.parse(json || "{}") as FileMap
  } catch {
    return {}
  }
}

/**
 * Mirror one repo source into its collection, one-way. Lists the tree, keeps the
 * docs matching the include globs, and for each: skips it if its sha is
 * unchanged, publishes a new artifact if it's new, or appends a version if it
 * changed. Files that vanished from the repo are tombstoned (the 410 path). The
 * new path→artifact map + status are persisted on the source. GitHub failures
 * propagate (GitHubError) so the caller can record them on the source row.
 */
export async function runSync(
  meta: MetaStore,
  blobs: BlobStore,
  source: RepoSourceRecord,
  now: string,
): Promise<SyncResult> {
  const repo = parseRepo(source.repo)
  if (!repo) throw new Error(`invalid repo: ${source.repo}`)
  const globs = source.includes
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)

  const { entries, truncated } = await listTree(repo, source.ref, source.token)
  const docs = entries.filter((e) => matchesGlobs(e.path, globs))

  const prev = parseMap(source.files)
  const next: FileMap = {}
  const res: SyncResult = { added: 0, updated: 0, removed: 0, skipped: 0 }

  for (const e of docs) {
    const before = prev[e.path]
    if (before && before.sha === e.sha) {
      next[e.path] = before
      res.skipped++
      continue
    }
    const bytes = await fetchBlob(repo, e.sha, source.token)
    const input = {
      bytes,
      filename: basename(e.path),
      isBundle: false,
      title: e.path,
      author: "GitHub sync",
      message: `sync ${source.ref}@${e.sha.slice(0, 7)}`,
      orgId: source.org_id,
    }
    if (before) {
      const { artifact } = await publish(meta, blobs, input, before.short_id)
      // A file can be deleted then re-added; clear any tombstone so it renders again.
      await meta.setArtifactRemoved(artifact.id, null)
      next[e.path] = { artifact_id: artifact.id, short_id: artifact.short_id, sha: e.sha }
      res.updated++
    } else {
      const { artifact } = await publish(meta, blobs, input)
      await meta.addCollectionItem(source.collection_id, artifact.id)
      next[e.path] = { artifact_id: artifact.id, short_id: artifact.short_id, sha: e.sha }
      res.added++
    }
  }

  // Tombstone files that disappeared from the repo. Skip this when the tree was
  // truncated — an absent path there means "not listed", not "deleted".
  for (const path in prev) {
    if (next[path]) continue
    if (truncated) {
      next[path] = prev[path] as SyncedFile // carry forward; don't touch the artifact
      continue
    }
    await meta.setArtifactRemoved((prev[path] as SyncedFile).artifact_id, now)
    res.removed++
  }

  const status = truncated ? "ok (repo tree truncated; some files not listed)" : "ok"
  await meta.updateRepoSourceSync(source.id, {
    files: JSON.stringify(next),
    last_synced_at: now,
    last_status: status,
  })
  return res
}
