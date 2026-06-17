import {
  type ArtifactRecord,
  type BlobStore,
  type MetaStore,
  publish,
  type RepoSourceRecord,
  type SyncProgress,
} from "@dock/core"
import { zipSync } from "fflate"
import { type BundlePlan, commonDir, planBundle } from "./bundle-from-repo"
import { sha256 } from "./crypto"
import { fetchBlob, lastCommitDate, listTree, matchesGlobs, parseRepo } from "./github"

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
  /** The source file's last-commit date, mirrored into the artifact's `updated_at`
   *  (so the card shows the SOURCE's last change, not Dock's ingest time). Set the
   *  first time we resolve it; `""` records an attempt that found none (so we don't
   *  retry forever); absent means not yet sourced → the date backfill will fill it. */
  updatedAt?: string
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
  /** Matching docs still needing work after this run (>0 when a batch hit maxFiles).
   *  The caller re-runs until it reaches 0 to finish a large repo across batches. */
  remaining: number
  /** Removals withheld this run by the mass-removal safety guard (a suspect listing
   *  that would have tombstoned too large a fraction of the tracked files). */
  removalsSkipped?: number
}

/** Optional guards, mirroring the publish route: a per-file byte cap and a
 *  workspace storage-quota check. Omitted (e.g. in unit tests) ⇒ no limits. */
export interface SyncLimits {
  maxBytes: number
  overStorage: (incoming: number) => Promise<boolean>
  /** Max NEW/changed docs to publish in one run (skips don't count). Bounds the
   *  work so a huge repo can't exceed the runtime's request/CPU budget — the rest
   *  carry forward and finish on the next run. Omitted ⇒ unbounded (Node/tests). */
  maxFiles?: number
  /** Mass-removal circuit breaker. A run never tombstones more than `removalRatio`
   *  of the tracked files once the count exceeds `removalFloor` — so a glitchy/empty
   *  listing can't wipe a collection. Defaults: floor 10, ratio 0.5. */
  removalFloor?: number
  removalRatio?: number
}

const basename = (path: string): string => path.split("/").pop() || path
const isHtml = (path: string): boolean => /\.html?$/i.test(path)
const stripExt = (path: string): string => {
  const b = basename(path)
  const dot = b.lastIndexOf(".")
  return dot > 0 ? b.slice(0, dot) : b
}

/**
 * A human display title for a synced file: the doc's own heading, so the library
 * shows "Taxonomy System" not "packages/core/ai-services/TAXONOMY.md" (the path
 * lives in `source_path`). Markdown → first ATX `#` heading; HTML → `<title>` then
 * first `<h1>`; otherwise the basename without extension.
 */
const extractTitle = (bytes: Uint8Array, path: string): string => {
  const clean = (s: string) =>
    s
      .replace(/<[^>]+>/g, "")
      .replace(/[`*_]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200)
  const text = new TextDecoder().decode(bytes)
  if (isHtml(path)) {
    const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    const h1 = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    const got = clean(title || h1 || "")
    if (got) return got
  } else if (/\.(md|markdown)$/i.test(path)) {
    for (const line of text.split("\n").slice(0, 60)) {
      const m = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
      if (m?.[1]) {
        const got = clean(m[1])
        if (got) return got
      }
    }
  }
  return stripExt(path)
}
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
  const res: SyncResult = { added: 0, updated: 0, removed: 0, renamed: 0, skipped: 0, remaining: 0 }
  const renamedAway = new Set<string>()
  const tooLarge: string[] = []
  // Per-run work budget: how many publishes we've done, and whether we stopped
  // early because we hit maxFiles (the rest carry forward to the next run).
  let processed = 0
  let capped = false

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
  // Live, pollable progress (the UI bar + global chip). `total` is set once the
  // tree is listed; `done` is the size of the (incrementally persisted) map. Floored
  // at the carried-forward count so a multi-batch sync never bounces backward: each
  // batch starts with `next` empty but `prev` already holding the prior batches'
  // work, so without the floor the bar would snap 50→0→100→0 between batches.
  const prevCount = Object.keys(prev).length
  let total = 0
  const writeProgress = (phase: SyncProgress["phase"], message?: string) =>
    meta.setRepoSourceProgress(
      source.id,
      JSON.stringify({
        phase,
        done: Math.max(Object.keys(next).length, prevCount),
        total,
        ...(message ? { message } : {}),
        updatedAt: now,
      } satisfies SyncProgress),
    )

  // Count a publish and, every PROGRESS_EVERY, flush the partial map + live status
  // + progress. Incrementally durable (a killed run leaves a consistent map, never
  // orphan artifacts) AND lets the UI poll a precise bar.
  const PROGRESS_EVERY = 15
  const onPublished = async () => {
    processed++
    if (processed % PROGRESS_EVERY === 0) {
      await persist(`syncing ${processed} files…`)
      await writeProgress("mirroring")
    }
  }

  // Mirror the source file's last-commit date into the artifact's `updated_at`, so the
  // card shows when the SOURCE last changed, not when Dock ingested it (the git tree
  // carries no dates — this is one extra Commits API call per file). Records the result
  // on the map entry: a real date, or `""` when none resolved, so a re-sync never
  // re-fetches a file it already sourced. Best-effort — a null leaves publish's `now()`.
  const stampDate = async (artifactId: string, repoPath: string, entry: SyncedFile) => {
    const date = await lastCommitDate(repo, repoPath, source.ref, source.token)
    if (date) await meta.setArtifactUpdatedAt(artifactId, date)
    entry.updatedAt = date ?? ""
  }
  // The existing tracked files were synced before dates were sourced (`updatedAt`
  // absent). Backfill them lazily — bounded per run so one sync doesn't make hundreds
  // of Commits calls; the leftover counts as `remaining`, so the runner continues until
  // every file is dated. Unbounded in tests (no `limits`).
  const DATE_BACKFILL_PER_RUN = limits ? 150 : Number.POSITIVE_INFINITY
  let datesBackfilled = 0
  const backfillDate = async (entry: SyncedFile, repoPath: string) => {
    if (entry.updatedAt !== undefined || datesBackfilled >= DATE_BACKFILL_PER_RUN) return
    datesBackfilled++
    await stampDate(entry.artifact_id, repoPath, entry)
  }

  try {
    // First batch of a fresh source: show "connecting/listing" before the count.
    if (Object.keys(prev).length === 0) await writeProgress("listing")
    const { entries, truncated } = await listTree(repo, source.ref, source.token)
    const shaByPath = new Map(entries.map((e) => [e.path, e.sha]))
    const docs = entries.filter((e) => matchesGlobs(e.path, globs))
    const docPaths = new Set(docs.map((d) => d.path))
    total = docs.length
    await writeProgress("mirroring")

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
    // `repoPath` is the file's path in the repo — the file-map key + the artifact's
    // `source_path` (structural location). `title` is the human display name
    // (extracted from the content). They're distinct: the map keys on the path, the
    // UI shows the title.
    const publishDoc = async (
      before: SyncedFile | undefined,
      bytes: Uint8Array,
      filename: string,
      isBundle: boolean,
      repoPath: string,
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
      let artifact: ArtifactRecord
      if (reuse && before) {
        artifact = (await publish(meta, blobs, input, before.short_id)).artifact
        res.updated++
      } else {
        if (before) await meta.setArtifactRemoved(before.artifact_id, now) // old kind retired
        artifact = (await publish(meta, blobs, input)).artifact
        await meta.addCollectionItem(source.collection_id, artifact.id)
        res.added++
      }
      await meta.setArtifactRemoved(artifact.id, null)
      await meta.setArtifactSourcePath(artifact.id, repoPath)
      const entry: SyncedFile = {
        artifact_id: artifact.id,
        short_id: artifact.short_id,
        sha,
        kind,
        members,
      }
      // A changed/new file: source its last-commit date now (this is the forward fix;
      // a fresh full sync dates everything as it publishes, within the maxFiles batch).
      await stampDate(artifact.id, repoPath, entry)
      next[repoPath] = entry
      await onPublished()
    }

    // ---- Phase B: mirror each doc ------------------------------------------
    for (const e of docs) {
      // Owned by another doc's bundle → never a standalone artifact (and if it was
      // one before, leaving it out of `next` tombstones the standalone copy).
      if (consumed.has(e.path)) continue
      // Hit the per-run work budget → stop; the rest carry forward to the next run.
      if (limits?.maxFiles && processed >= limits.maxFiles) {
        capped = true
        break
      }

      const before = prev[e.path]
      const plan = plans.get(e.path)

      if (plan) {
        // Bundle. Composite sha over current member shas drives the skip.
        const memberShas: Record<string, string> = {}
        for (const m of plan.members) memberShas[m.repoPath] = shaByPath.get(m.repoPath) ?? ""
        const composite = compositeSha(memberShas)
        if (before?.kind === "bundle" && before.sha === composite) {
          await backfillDate(before, e.path) // source its date if it predates the feature
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
        const entryTitle = extractTitle(zipFiles[plan.entryRel] ?? new Uint8Array(), plan.entryPath)
        await publishDoc(
          before,
          zipped,
          basename(plan.entryRel),
          true,
          e.path,
          entryTitle,
          composite,
          memberShas,
        )
        continue
      }

      // Single file. Unchanged → skip; pure rename → re-home; else publish.
      if (before && before.kind !== "bundle" && before.sha === e.sha) {
        await backfillDate(before, e.path) // source its date if it predates the feature
        next[e.path] = before
        res.skipped++
        continue
      }
      if (!before) {
        const moved = vanishedBySha.get(e.sha)
        if (moved && !renamedAway.has(moved.path)) {
          renamedAway.add(moved.path)
          vanishedBySha.delete(e.sha)
          // Pure rename: content unchanged, so the display title stays; only the
          // structural location (source_path) moves to the new path.
          await meta.setArtifactSourcePath(moved.entry.artifact_id, e.path)
          await meta.setArtifactRemoved(moved.entry.artifact_id, null)
          await meta.addCollectionItem(source.collection_id, moved.entry.artifact_id)
          next[e.path] = { ...moved.entry, sha: e.sha }
          res.renamed++
          await onPublished()
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
      await publishDoc(
        before,
        bytes,
        basename(e.path),
        false,
        e.path,
        extractTitle(bytes, e.path),
        e.sha,
      )
    }

    // Tombstone files that truly disappeared. Skipped when truncated (absent ≠
    // deleted), capped (we didn't process the whole repo this run), or consumed by
    // a rename. A path that became a bundle asset is NOT here (its standalone entry
    // was intentionally left out of `next` above, so it tombstones — correct).
    //
    // SAFETY (mass-removal circuit breaker): a one-way mirror must never wipe a
    // collection because a single listing came back wrong — a transient GitHub
    // error, a misconfigured branch/glob, or a repo that momentarily lists few/no
    // files (and isn't flagged `truncated`). If a run would tombstone a large
    // FRACTION of everything we track, treat the listing as suspect: skip the
    // removals, carry those entries forward (so they aren't dropped/re-created),
    // and flag it. Re-running on a genuinely-smaller repo removes them gradually
    // (each run can only ever remove up to the ratio), so nothing is permanently
    // lost and a glitch can't nuke the workspace.
    if (!truncated && !capped) {
      const vanished = Object.keys(prev).filter((p) => prev[p] && !next[p] && !renamedAway.has(p))
      const tracked = Object.keys(prev).length
      // Allow small removals freely; above the floor, never remove more than the
      // ratio of what we track in one run. Tunable via SyncLimits.
      const floor = limits?.removalFloor ?? 10
      const ratio = limits?.removalRatio ?? 0.5
      const massRemoval = vanished.length > floor && vanished.length > tracked * ratio
      if (massRemoval) {
        // Suspect listing — keep the artifacts (no tombstone), carry them forward.
        for (const path of vanished) {
          const ent = prev[path]
          if (ent) next[path] = ent
        }
        res.removalsSkipped = vanished.length
      } else {
        for (const path of vanished) {
          await meta.setArtifactRemoved((prev[path] as SyncedFile).artifact_id, now)
          res.removed++
        }
      }
    }

    // On a capped/truncated run, keep un-processed entries so they aren't dropped
    // (and re-created) — the next run continues from here.
    if (truncated || capped) carryForward()

    // Docs still needing work: not consumed, and not already current in `next`.
    const publishRemaining = docs.filter((e) => {
      if (consumed.has(e.path)) return false
      const n = next[e.path]
      if (!n) return true
      const plan = plans.get(e.path)
      if (plan) {
        const ms: Record<string, string> = {}
        for (const m of plan.members) ms[m.repoPath] = shaByPath.get(m.repoPath) ?? ""
        return n.kind !== "bundle" || n.sha !== compositeSha(ms)
      }
      return n.kind === "bundle" || n.sha !== e.sha
    }).length
    // Files not yet date-sourced (the backfill hit its per-run cap) keep the run
    // "remaining" so the runner re-invokes until every artifact carries a real date.
    const dateRemaining = Object.values(next).filter((n) => n.updatedAt === undefined).length
    res.remaining = publishRemaining + dateRemaining

    let status = capped
      ? `synced ${processed} this run · ${res.remaining} pending`
      : truncated
        ? "ok (repo tree truncated; some files not listed)"
        : "ok"
    if (tooLarge.length) status += ` (${tooLarge.length} file(s) skipped: too large or over quota)`
    if (res.removalsSkipped)
      status += ` · ⚠ withheld ${res.removalsSkipped} removal(s): listing returned far fewer files than tracked (re-run to confirm)`
    await persist(status)
    // Still "mirroring" while batches remain; "done" once the repo is fully synced.
    await writeProgress(res.remaining > 0 ? "mirroring" : "done")
    return res
  } catch (err) {
    carryForward()
    const message = err instanceof Error ? err.message : String(err)
    await persist(`error: ${message}`.slice(0, 300))
    await writeProgress("error", message.slice(0, 300))
    throw err
  }
}
