import { type BlobStore, type MetaStore, publish, type RepoSourceRecord } from "@dock/core"
import { zipSync } from "fflate"
import { type BundlePlan, commonDir, planBundle } from "./bundle-from-repo"
import { sha256 } from "./crypto"
import { fetchBlob, listTree, matchesGlobs, parseRepo } from "./github"

/** Per-path mirror state, persisted as JSON in repo_source.files. */
export interface SyncedFile {
  artifact_id: string
  short_id: string
  /**
   * The fingerprint a re-sync compares to decide "unchanged → skip". For a single
   * file it's the git blob sha; for a bundle it's a composite hash of every member
   * sha, so a change to ANY member (incl. a shared stylesheet) re-syncs the page.
   */
  sha: string
  /** "file" (default, omitted on legacy rows) or "bundle". */
  kind?: "file" | "bundle"
  /** For a bundle: each member's repo path → its blob sha, so we can tell which
   *  members changed and reconstruct the bundle without re-scanning when stable. */
  members?: Record<string, string>
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
const isHtml = (path: string): boolean => /\.html?$/i.test(path)
const parseMap = (json: string): FileMap => {
  try {
    return JSON.parse(json || "{}") as FileMap
  } catch {
    return {}
  }
}

/** A composite fingerprint over a bundle's members (path:sha pairs, order-stable). */
const compositeSha = (memberShas: Record<string, string>): string =>
  sha256(
    Object.keys(memberShas)
      .sort()
      .map((p) => `${p}:${memberShas[p]}`)
      .join("|"),
  )

/**
 * Mirror one repo source into its collection, one-way. Lists the tree, keeps the
 * docs matching the include globs, and for each: skips it if unchanged, detects a
 * pure rename and re-homes the existing artifact, publishes a new artifact if
 * genuinely new, or appends a version if it changed. An HTML doc that references
 * local repo assets (CSS/JS/images) is mirrored as a *bundle* (entry + assets) so
 * it renders styled; everything else is a single file. Vanished files are
 * tombstoned (the 410 path).
 *
 * The path→artifact map is persisted on EVERY exit — success or a thrown
 * GitHub/publish error — carrying forward un-processed entries, so a mid-run
 * failure leaves an idempotent map and a retry never re-creates duplicates.
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
  const renamedAway = new Set<string>()
  const tooLarge: string[] = []

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
    const shaByPath = new Map(entries.map((e) => [e.path, e.sha]))
    const docs = entries.filter((e) => matchesGlobs(e.path, globs))
    const docPaths = new Set(docs.map((d) => d.path))

    // Fetch + cache repo bytes by path (one fetch per blob across both phases).
    const byteCache = new Map<string, Uint8Array>()
    const fetchBytes = async (path: string): Promise<Uint8Array> => {
      const cached = byteCache.get(path)
      if (cached) return cached
      const sha = shaByPath.get(path)
      if (sha === undefined) throw new Error(`missing tree entry: ${path}`)
      const data = await fetchBlob(repo, sha, source.token)
      byteCache.set(path, data)
      return data
    }
    const fetchText = async (path: string): Promise<string | null> => {
      try {
        return new TextDecoder().decode(await fetchBytes(path))
      } catch {
        return null
      }
    }

    // ---- Phase A: plan bundles for HTML docs --------------------------------
    // For each HTML doc, decide whether it's a bundle (references local assets,
    // transitively through its stylesheets) and which files it owns. Unchanged
    // bundles reuse their stored membership (no fetch); only new/changed HTML is
    // read + scanned. `consumed` collects the asset paths a bundle owns, so a
    // shared CSS is never ALSO mirrored standalone.
    const plans = new Map<string, BundlePlan>()
    const consumed = new Set<string>()
    for (const e of docs) {
      if (!isHtml(e.path)) continue
      const before = prev[e.path]
      // Stable bundle: the entry blob is unchanged AND every stored member still
      // exists with the same sha → reuse the stored plan, no fetch or re-scan.
      const stable =
        before?.kind === "bundle" &&
        before.members?.[e.path] === e.sha &&
        Object.entries(before.members).every(([p, s]) => shaByPath.get(p) === s)
      if (stable && before?.members) {
        const memberPaths = Object.keys(before.members)
        const root = commonDir(memberPaths)
        const rel = (p: string) => (root ? p.slice(root.length + 1) : p)
        plans.set(e.path, {
          entryPath: e.path,
          root,
          entryRel: rel(e.path),
          members: memberPaths.map((repoPath) => ({ repoPath, rel: rel(repoPath) })),
        })
      } else {
        const html = await fetchText(e.path)
        const plan = html
          ? await planBundle(e.path, html, (p) => shaByPath.has(p), fetchText)
          : null
        if (plan) plans.set(e.path, plan)
      }
      const plan = plans.get(e.path)
      if (plan) for (const m of plan.members) if (m.repoPath !== e.path) consumed.add(m.repoPath)
    }

    // Rename candidates: vanished single-file paths indexed by sha. Bundles don't
    // participate (their composite sha never equals a blob sha).
    const vanishedBySha = new Map<string, { path: string; entry: SyncedFile }>()
    if (!truncated)
      for (const path in prev) {
        const ent = prev[path]
        if (ent && ent.kind !== "bundle" && !docPaths.has(path) && !vanishedBySha.has(ent.sha))
          vanishedBySha.set(ent.sha, { path, entry: ent })
      }

    // Republish helper that survives a kind change (file⇄bundle): an artifact's
    // kind is immutable, so when it flips we tombstone the old one and create new.
    const publishDoc = async (
      before: SyncedFile | undefined,
      bytes: Uint8Array,
      filename: string,
      isBundle: boolean,
      title: string,
      sha: string,
      members?: Record<string, string>,
    ) => {
      const kind: SyncedFile["kind"] = isBundle ? "bundle" : "file"
      const input = {
        bytes,
        filename,
        isBundle,
        title,
        author: "GitHub sync",
        message: `sync ${source.ref}@${sha.slice(0, 7)}`,
        orgId: source.org_id,
      }
      const reuse = before && (before.kind ?? "file") === kind
      if (reuse && before) {
        const { artifact } = await publish(meta, blobs, input, before.short_id)
        await meta.setArtifactRemoved(artifact.id, null)
        next[title] = { artifact_id: artifact.id, short_id: artifact.short_id, sha, kind, members }
        res.updated++
      } else {
        if (before) await meta.setArtifactRemoved(before.artifact_id, now) // old kind retired
        const { artifact } = await publish(meta, blobs, input)
        await meta.addCollectionItem(source.collection_id, artifact.id)
        next[title] = { artifact_id: artifact.id, short_id: artifact.short_id, sha, kind, members }
        res.added++
      }
    }

    // ---- Phase B: mirror each doc ------------------------------------------
    for (const e of docs) {
      // Owned by another doc's bundle → never a standalone artifact (and if it was
      // one before, leaving it out of `next` tombstones the standalone copy).
      if (consumed.has(e.path)) continue

      const before = prev[e.path]
      const plan = plans.get(e.path)

      if (plan) {
        // Bundle. Composite sha over current member shas drives the skip.
        const memberShas: Record<string, string> = {}
        for (const m of plan.members) memberShas[m.repoPath] = shaByPath.get(m.repoPath) ?? ""
        const composite = compositeSha(memberShas)
        if (before?.kind === "bundle" && before.sha === composite) {
          next[e.path] = before
          res.skipped++
          continue
        }
        // Assemble the zip from member bytes, then publish through the normal
        // bundle path (manifest, validation, read-only "managed" treatment).
        const zipFiles: Record<string, Uint8Array> = {}
        let total = 0
        for (const m of plan.members) {
          const bytes = await fetchBytes(m.repoPath)
          zipFiles[m.rel] = bytes
          total += bytes.length
        }
        if (limits && (total > limits.maxBytes || (await limits.overStorage(total)))) {
          if (before) next[e.path] = before
          tooLarge.push(e.path)
          res.skipped++
          continue
        }
        const zipped = zipSync(zipFiles)
        await publishDoc(
          before,
          zipped,
          basename(plan.entryRel),
          true,
          e.path,
          composite,
          memberShas,
        )
        continue
      }

      // Single file. Unchanged → skip; pure rename → re-home; else publish.
      if (before && before.kind !== "bundle" && before.sha === e.sha) {
        next[e.path] = before
        res.skipped++
        continue
      }
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
      const bytes = await fetchBytes(e.path)
      if (limits && (bytes.length > limits.maxBytes || (await limits.overStorage(bytes.length)))) {
        if (before) next[e.path] = before
        tooLarge.push(e.path)
        res.skipped++
        continue
      }
      await publishDoc(before, bytes, basename(e.path), false, e.path, e.sha)
    }

    // Tombstone files that truly disappeared. Skipped when truncated (absent ≠
    // deleted) or consumed by a rename. A path that became a bundle asset is NOT
    // here (its standalone entry was intentionally left out of `next` above, so it
    // tombstones — correct, the bundle owns it now).
    if (!truncated)
      for (const path in prev) {
        const ent = prev[path]
        if (!ent || next[path] || renamedAway.has(path)) continue
        await meta.setArtifactRemoved(ent.artifact_id, now)
        res.removed++
      }

    if (truncated) carryForward()
    let status = truncated ? "ok (repo tree truncated; some files not listed)" : "ok"
    if (tooLarge.length) status += ` (${tooLarge.length} file(s) skipped: too large or over quota)`
    await persist(status)
    return res
  } catch (err) {
    carryForward()
    await persist(`error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
    throw err
  }
}
