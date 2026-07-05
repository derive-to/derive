import {
  type ArtifactRecord,
  type BlobStore,
  type GithubAuthor,
  type MetaStore,
  mapPoolSettled,
  publish,
  type RepoSourceRecord,
  type SyncProgress,
} from "@derive/core"
import { zipSync } from "fflate"
import { type BundlePlan, commonDir, planBundle } from "./bundle-from-repo"
import { sha256 } from "./crypto"
import {
  type CommitAuthor,
  fetchBlob,
  fetchBlobsBatch,
  lastCommit,
  listPullFiles,
  listTree,
  matchesGlobs,
  parseRepo,
} from "./github"

// Pre-warm the byte cache via BATCHED GraphQL reads rather than one GET per file:
// GitHub bills an aliased multi-blob query at ~1 rate-limit point (vs 1 per file) and
// it's one round-trip per chunk, so a few hundred docs fetch in a handful of cheap
// requests — far under the secondary limits (100 concurrent / 900 points/min) and
// aligned with GitHub's "prefer serial" guidance.
const GRAPHQL_BATCH = 20 // max blobs per GraphQL query
const GRAPHQL_MAX_RESPONSE = 2 * 1024 * 1024 // and cap a chunk's summed text at ~2MB
const GRAPHQL_MAX_BLOB = 512 * 1024 // blobs bigger than this skip GraphQL (no text) → REST
const GRAPHQL_CONCURRENCY = 4 // a few queries in flight; each is ~1 point

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
   *  (so the card shows the SOURCE's last change, not Derive's ingest time). Set the
   *  first time we resolve it; `""` records an attempt that found none (so we don't
   *  retry forever); absent means not yet sourced → the date backfill will fill it. */
  updatedAt?: string
  /** Whether the source file's last-commit AUTHOR has been sourced (mirrored into the
   *  artifact's author_* columns). Mirrors `updatedAt`'s semantics: `true` once attempted
   *  (a real author or none), absent means not yet sourced → the author backfill fills it.
   *  Date + author are fetched in a single Commits call, so the two sentinels move together. */
  authorSourced?: boolean
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

  // A commit author becomes the artifact's denormalized author only when GitHub gave us
  // *something* to attribute to (a login or a git author name); a fully-empty commit
  // author leaves the columns null. The display name prefers the GitHub login, then the
  // raw git author name.
  const toGithubAuthor = (a: CommitAuthor | null): GithubAuthor | null => {
    if (!a || (!a.login && !a.name)) return null
    return { name: a.name ?? a.login, login: a.login, avatar: a.avatar, ghId: a.ghId }
  }

  // Mirror the source file's last-commit date AND author into the artifact (the card's
  // "updated" + "who last changed this"). The git tree carries neither, so this is one
  // Commits API call per file — fetched ONCE here and reused for both. Records the result
  // on the map entry (date sentinel + authorSourced) so a re-sync never re-fetches a file
  // it already sourced. Best-effort: a null date leaves publish's now(); a null author
  // clears the columns. Returns the resolved author so the publish path can store it
  // per-version too without a second call.
  const stampCommit = async (
    artifactId: string,
    repoPath: string,
    entry: SyncedFile,
  ): Promise<GithubAuthor | null> => {
    const { date, author } = await lastCommit(repo, repoPath, source.ref, source.token)
    if (date) await meta.setArtifactUpdatedAt(artifactId, date)
    const gh = toGithubAuthor(author)
    await meta.setArtifactAuthor(artifactId, gh)
    entry.updatedAt = date ?? ""
    entry.authorSourced = true
    return gh
  }
  // The existing tracked files were synced before date/author were sourced (`updatedAt`
  // absent). Backfill them lazily — bounded per run so one sync doesn't make hundreds
  // of Commits calls; the leftover counts as `remaining`, so the runner continues until
  // every file is sourced. Unbounded in tests (no `limits`).
  const DATE_BACKFILL_PER_RUN = limits ? 150 : Number.POSITIVE_INFINITY
  let datesBackfilled = 0
  const backfillCommit = async (entry: SyncedFile, repoPath: string) => {
    // Fetch when EITHER sentinel is unset: a brand-new entry (neither set) or a legacy
    // one dated before authors existed (`updatedAt` set, `authorSourced` absent). The
    // single Commits call fills both, so they converge after one backfill.
    const needs = entry.updatedAt === undefined || entry.authorSourced === undefined
    if (!needs || datesBackfilled >= DATE_BACKFILL_PER_RUN) return
    datesBackfilled++
    await stampCommit(entry.artifact_id, repoPath, entry)
  }

  try {
    // First batch of a fresh source: show "connecting/listing" before the count.
    if (Object.keys(prev).length === 0) await writeProgress("listing")
    const { entries, truncated } = await listTree(repo, source.ref, source.token)
    const shaByPath = new Map(entries.map((e) => [e.path, e.sha]))
    const sizeByPath = new Map(entries.map((e) => [e.path, e.size ?? 0]))
    const matchedDocs = entries.filter((e) => matchesGlobs(e.path, globs))
    // A PR PREVIEW (source.pr_number set) mirrors ONLY the docs this PR changed —
    // not the whole repo at the head — so the preview shows exactly what the PR
    // touches. The changed set is re-derived from GitHub each run (PRs are small,
    // usually one batch). Bundle assets still resolve over the FULL tree via
    // shaByPath, so editing a bundle's entry page mirrors the whole bundle; a change
    // to an asset alone mirrors it standalone (acceptable for a preview). On a failed
    // listPullFiles this throws and the batch retries — fail closed, never mirror the
    // whole repo into a PR collection.
    let docs = matchedDocs
    if (source.pr_number != null) {
      const changed = new Set(await listPullFiles(repo, source.pr_number, source.token))
      docs = matchedDocs.filter((e) => changed.has(e.path))
    }
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

    // Warm the byte cache for `paths` in as few requests as possible: small text blobs
    // ride ONE batched GraphQL query per chunk (the bulk of a docs sync); blobs too big
    // for GraphQL to return text are left for the lazy REST fetch. Chunks are bounded by
    // count and summed size. A cache miss always falls back to fetchBytes, so an
    // incomplete prewarm is a perf miss, never a correctness bug.
    const prewarm = async (paths: Iterable<string>): Promise<void> => {
      const small: { path: string; sha: string }[] = []
      for (const path of paths) {
        const sha = shaByPath.get(path)
        if (sha === undefined || byteCache.has(path)) continue
        if ((sizeByPath.get(path) ?? 0) > GRAPHQL_MAX_BLOB) continue // too big for GraphQL text
        small.push({ path, sha })
      }
      const chunks: { path: string; sha: string }[][] = []
      let cur: { path: string; sha: string }[] = []
      let curBytes = 0
      for (const it of small) {
        const sz = sizeByPath.get(it.path) ?? 0
        if (
          cur.length >= GRAPHQL_BATCH ||
          (cur.length > 0 && curBytes + sz > GRAPHQL_MAX_RESPONSE)
        ) {
          chunks.push(cur)
          cur = []
          curBytes = 0
        }
        cur.push(it)
        curBytes += sz
      }
      if (cur.length) chunks.push(cur)
      await mapPoolSettled(chunks, GRAPHQL_CONCURRENCY, async (chunk) => {
        const bySha = await fetchBlobsBatch(
          repo,
          chunk.map((c) => c.sha),
          source.token,
        )
        for (const c of chunk) {
          const bytes = bySha.get(c.sha)
          if (bytes) byteCache.set(c.path, bytes)
        }
      })
    }

    // ---- Phase A: plan bundles for HTML docs --------------------------------
    // For each HTML doc, decide whether it's a bundle (references local assets,
    // transitively through its stylesheets) and which files it owns. Unchanged
    // bundles reuse their stored membership (no fetch); only new/changed HTML is
    // read + scanned. `consumed` collects the asset paths a bundle owns, so a
    // shared CSS is never ALSO mirrored standalone.
    //
    // First, batch-prewarm the byte cache for the HTML Phase A will actually read (the
    // non-stable entries, exactly what the loop below fetches). Markdown-only repos
    // warm nothing here; the win is Phase B below.
    const htmlToWarm = docs
      .filter((e) => {
        if (!isHtml(e.path)) return false
        const before = prev[e.path]
        const stable =
          before?.kind === "bundle" &&
          before.members?.[e.path] === e.sha &&
          Object.entries(before.members).every(([p, s]) => shaByPath.get(p) === s)
        return !stable
      })
      .map((e) => e.path)
    await prewarm(htmlToWarm)

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
      // Source the commit ONCE up front: its author is recorded on the version + the
      // artifact at publish time (replacing the literal "GitHub sync"), and its date is
      // reused for the updated_at stamp below — no second Commits call. Best-effort.
      const { date, author } = await lastCommit(repo, repoPath, source.ref, source.token)
      const gh = toGithubAuthor(author)
      // Display name: the GitHub login, else the git author name, else "GitHub sync" when
      // GitHub gave us no identity at all (keeps the prior behavior for unmappable commits).
      const displayName = gh?.login ?? gh?.name ?? "GitHub sync"
      const input = {
        bytes,
        filename,
        isBundle,
        title,
        author: displayName,
        authorLogin: gh?.login ?? null,
        authorAvatar: gh?.avatar ?? null,
        authorGhId: gh?.ghId ?? null,
        message: `sync ${source.ref}@${sha.slice(0, 7)}`,
        orgId: source.org_id,
        // A mirrored repo is a workspace resource, not someone's draft: explicitly
        // workspace-visible (the publish default is private, which would hide the
        // whole mirror — sync writes no member rows).
        visibility: "org" as const,
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
      // A changed/new file: stamp its last-commit date now (the forward fix; a fresh full
      // sync dates everything as it publishes, within the maxFiles batch). The author is
      // already on the artifact (denormalized by addVersion) + the version row.
      if (date) await meta.setArtifactUpdatedAt(artifact.id, date)
      next[repoPath] = {
        artifact_id: artifact.id,
        short_id: artifact.short_id,
        sha,
        kind,
        members,
        updatedAt: date ?? "",
        authorSourced: true,
      }
      await onPublished()
    }

    // Batch-prewarm the byte cache for everything Phase B will fetch: the changed
    // single files + the members of changed bundles. Mirrors the skip/rename logic
    // below so we never fetch bytes the loop won't use (skips, unchanged files, and
    // pure renames fetch nothing), and is bounded by the same per-run cap so a huge
    // repo doesn't prewarm beyond one batch. This is the dominant speedup.
    const toWarm = new Set<string>()
    let warmBudget = limits?.maxFiles ?? Number.POSITIVE_INFINITY
    for (const e of docs) {
      if (warmBudget <= 0) break
      if (consumed.has(e.path)) continue
      const before = prev[e.path]
      const plan = plans.get(e.path)
      if (plan) {
        const memberShas: Record<string, string> = {}
        for (const m of plan.members) memberShas[m.repoPath] = shaByPath.get(m.repoPath) ?? ""
        if (before?.kind === "bundle" && before.sha === compositeSha(memberShas)) continue
        for (const m of plan.members) toWarm.add(m.repoPath)
        warmBudget--
      } else {
        if (before && before.kind !== "bundle" && before.sha === e.sha) continue
        if (!before && vanishedBySha.has(e.sha)) continue
        toWarm.add(e.path)
        warmBudget--
      }
    }
    await prewarm(toWarm)

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
          await backfillCommit(before, e.path) // source its date + author if it predates the feature
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
        await backfillCommit(before, e.path) // source its date + author if it predates the feature
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
    // Files not yet commit-sourced (the backfill hit its per-run cap) keep the run
    // "remaining" so the runner re-invokes until every artifact carries a real date +
    // author. Either sentinel missing counts (they're filled together).
    const dateRemaining = Object.values(next).filter(
      (n) => n.updatedAt === undefined || n.authorSourced === undefined,
    ).length
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
