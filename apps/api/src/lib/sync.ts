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
  /** Files that moved path (same content) — the artifact + its comments are kept. */
  renamed: number
  /** Unchanged, or skipped this run because too large / over the storage quota. */
  skipped: number
}

/** Optional guards, mirroring the publish route: a per-file byte cap and a
 *  workspace storage-quota check. Omitted (e.g. in unit tests) ⇒ no limits. */
export interface SyncLimits {
  maxBytes: number
  overStorage: (incoming: number) => Promise<boolean>
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
 * unchanged, detects a pure rename (same sha, new path) and re-homes the existing
 * artifact, publishes a new artifact if it's genuinely new, or appends a version
 * if it changed. Files that vanished are tombstoned (the 410 path).
 *
 * The path→artifact map is persisted on the way out of EVERY exit — success or a
 * thrown GitHub/publish error — carrying forward un-processed entries. So a
 * mid-run failure leaves an idempotent map: a retry treats already-mirrored paths
 * as updates/skips and never re-creates duplicate artifacts. GitHub failures
 * still propagate (after the partial map is saved) so the caller can surface them.
 */
export async function runSync(
  meta: MetaStore,
  blobs: BlobStore,
  source: RepoSourceRecord,
  now: string,
  limits?: SyncLimits,
): Promise<SyncResult> {
  const repo = parseRepo(source.repo)
  if (!repo) throw new Error(`invalid repo: ${source.repo}`)
  const globs = source.includes
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)

  const prev = parseMap(source.files)
  const next: FileMap = {}
  const res: SyncResult = { added: 0, updated: 0, removed: 0, renamed: 0, skipped: 0 }
  // Old paths consumed by a rename — never carried forward or tombstoned (their
  // artifact now lives under the new path).
  const renamedAway = new Set<string>()
  const tooLarge: string[] = []

  // Keep un-processed prev entries mapped. Used ONLY when we can't trust "absent
  // means deleted": a truncated tree (unlisted ≠ gone) or a mid-run failure
  // (didn't reach them). On a clean full sync, next is authoritative and a
  // genuinely-deleted file is correctly absent (it was tombstoned, not carried).
  const carryForward = () => {
    for (const path in prev) {
      const ent = prev[path]
      if (ent && !(path in next) && !renamedAway.has(path)) next[path] = ent
    }
  }
  const persist = async (status: string) => {
    await meta.updateRepoSourceSync(source.id, {
      files: JSON.stringify(next),
      last_synced_at: now,
      last_status: status,
    })
  }

  try {
    const { entries, truncated } = await listTree(repo, source.ref, source.token)
    const docs = entries.filter((e) => matchesGlobs(e.path, globs))
    const docPaths = new Set(docs.map((d) => d.path))

    // Vanished prev paths indexed by sha → rename candidates (same content moved
    // to a new path). Skipped when truncated (we can't trust "absent"). First
    // vanished per sha wins.
    const vanishedBySha = new Map<string, { path: string; entry: SyncedFile }>()
    if (!truncated)
      for (const path in prev) {
        const ent = prev[path]
        if (ent && !docPaths.has(path) && !vanishedBySha.has(ent.sha))
          vanishedBySha.set(ent.sha, { path, entry: ent })
      }

    for (const e of docs) {
      const before = prev[e.path]
      if (before && before.sha === e.sha) {
        next[e.path] = before
        res.skipped++
        continue
      }
      // Pure rename: a new path whose sha matches a vanished one is the same file
      // moved. Re-home the existing artifact (keep its comments) — retitle, clear
      // any tombstone, ensure it's in the collection. No blob fetch, no version.
      if (!before) {
        const moved = vanishedBySha.get(e.sha)
        if (moved && !renamedAway.has(moved.path)) {
          renamedAway.add(moved.path)
          vanishedBySha.delete(e.sha)
          await meta.setArtifactTitle(moved.entry.artifact_id, e.path)
          await meta.setArtifactRemoved(moved.entry.artifact_id, null)
          await meta.addCollectionItem(source.collection_id, moved.entry.artifact_id)
          next[e.path] = { ...moved.entry, sha: e.sha }
          res.renamed++
          continue
        }
      }
      const bytes = await fetchBlob(repo, e.sha, source.token)
      // Guard the publish path the same way the manual route does: a per-file byte
      // cap + the workspace storage quota. An offending file is skipped (the prior
      // version, if any, stays mapped), never published.
      if (limits && (bytes.length > limits.maxBytes || (await limits.overStorage(bytes.length)))) {
        if (before) next[e.path] = before
        tooLarge.push(e.path)
        res.skipped++
        continue
      }
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

    // Tombstone files that truly disappeared from the repo. Skipped when the tree
    // was truncated (absent ≠ deleted) or when the path was consumed by a rename.
    if (!truncated)
      for (const path in prev) {
        const ent = prev[path]
        if (!ent || next[path] || renamedAway.has(path)) continue
        await meta.setArtifactRemoved(ent.artifact_id, now)
        res.removed++
      }

    if (truncated) carryForward() // don't drop (and later re-create) unlisted files
    let status = truncated ? "ok (repo tree truncated; some files not listed)" : "ok"
    if (tooLarge.length) status += ` (${tooLarge.length} file(s) skipped: too large or over quota)`
    await persist(status)
    return res
  } catch (err) {
    carryForward() // a retry sees mirrored paths as updates, never re-creates them
    await persist(`error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
    throw err
  }
}
