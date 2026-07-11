import {
  type BlobStore,
  type MetaStore,
  newId,
  type RepoSourceRecord,
  type VersionRecord,
} from "@derive/core"
import type { Backplane } from "../bus"
import { log } from "../log"
import { publishSweepEvents } from "./anchor-sweep"

interface PrPreviewDeps {
  meta: MetaStore
  blobs: BlobStore
  bus: Backplane
  baseUrl: string
  /** Queue a source for a mirror run — the sync-trigger wrapper owned by syncRoutes. */
  launch: (source: RepoSourceRecord, inlineFallback: boolean) => Promise<void>
}

/**
 * PR-preview lifecycle: the collection/blob orchestration behind Derive's GitHub PR
 * previews, lifted out of the route file (it's domain work the webhook drives, not
 * routing). A PR preview is an ephemeral, READ-ONLY repo_source (`pr_number` set, `ref`
 * = the PR head sha) into its own collection ("PR #<n>: <title>"). It inherits the branch
 * source's installation + include globs, and the engine scopes the mirror to just the PR's
 * changed docs. Created on open/synchronize, torn down on close, graduated on merge.
 */
export function makePrPreview({ meta, blobs, bus, baseUrl, launch }: PrPreviewDeps) {
  // Upsert a preview to the PR's current head. An existing preview is re-pointed at the
  // new head sha (its file map is kept, so the engine updates artifacts in place and
  // tombstones docs the PR no longer touches); a missing one is created fresh.
  const upsertPrPreview = async (
    branch: RepoSourceRecord,
    existing: RepoSourceRecord | undefined,
    prNumber: number,
    prTitle: string,
    headSha: string,
  ): Promise<{ collectionId: string }> => {
    const title = `PR #${prNumber}: ${prTitle.trim() || "(untitled)"}`.slice(0, 200)
    if (existing) {
      await meta.updateRepoSourceSync(existing.id, { ref: headSha })
      await meta.updateCollection(existing.collection_id, { title })
      await launch(existing, true)
      return { collectionId: existing.collection_id }
    }
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: branch.org_id,
      title,
      created_by: branch.created_by,
    })
    await meta.setCollectionMember({
      id: newId("cm"),
      collection_id: col.id,
      user_id: branch.created_by,
      role: "owner",
    })
    const source = await meta.createRepoSource({
      id: newId("rs"),
      org_id: branch.org_id,
      collection_id: col.id,
      repo: branch.repo,
      ref: headSha,
      includes: branch.includes,
      token: null,
      installation_id: branch.installation_id,
      pr_number: prNumber,
      created_by: branch.created_by,
    })
    await launch(source, true)
    return { collectionId: col.id }
  }

  // The body of the sticky "preview" comment Derive posts on a PR: a friendly line + a
  // deep link into the preview collection. No em dashes (customer-facing copy).
  const previewCommentBody = (collectionId: string, docCount: number): string => {
    const link = `${baseUrl.replace(/\/$/, "")}/?collection=${collectionId}`
    const docs = `${docCount} doc${docCount === 1 ? "" : "s"}`
    return `📦 **Derive preview** of this PR: ${docs} rendered with versions, comments, and review.\n\n👉 [Open the preview in Derive](${link})`
  }

  // Tear down a preview WITHOUT graduating it: tombstone its artifacts, drop the source
  // + collection. Used when a PR is CLOSED-without-merge (nothing landed) or stops
  // changing any docs. A MERGED PR goes through graduatePreview instead.
  const removePrPreview = async (preview: RepoSourceRecord): Promise<void> => {
    let artifactIds: string[] = []
    try {
      const map = JSON.parse(preview.files || "{}") as Record<string, { artifact_id?: string }>
      artifactIds = Object.values(map)
        .map((f) => f?.artifact_id)
        .filter((id): id is string => !!id)
    } catch {
      // A malformed map → nothing to tombstone; still drop the source + collection.
    }
    const removedAt = new Date().toISOString()
    // Tombstone every managed artifact in one update, not a setArtifactRemoved per id.
    await meta.setArtifactsRemoved(artifactIds, removedAt)
    await meta.deleteRepoSource(preview.id, preview.org_id)
    await meta.deleteCollection(preview.collection_id)
  }

  type PreviewFile = { artifact_id?: string } & Record<string, unknown>
  const parseFileMap = (s: string): Record<string, PreviewFile> => {
    try {
      return JSON.parse(s || "{}") as Record<string, PreviewFile>
    } catch {
      return {}
    }
  }

  // Fold a preview artifact into the canonical doc that already exists for its path,
  // then delete the preview copy. The PR's versions APPEND onto the canonical (blob keys
  // are content-addressed, so this is cheap and addVersion bumps current_version), so
  // they become part of its history. Comment threads are re-cloned onto the canonical
  // with fresh ids (preserving the root==thread_id invariant + the thread state) and
  // re-anchored against the new current version, so review carries over.
  const foldIntoCanonical = async (
    preview: RepoSourceRecord,
    previewId: string,
    canonicalId: string,
  ): Promise<void> => {
    const prefix = `PR #${preview.pr_number}`
    let latest: VersionRecord | null = null
    for (const v of await meta.listVersions(previewId)) {
      latest = await meta.addVersion(canonicalId, {
        id: newId("ver"),
        blob_key: v.blob_key,
        content_type: v.content_type,
        size_bytes: v.size_bytes,
        author: v.author,
        author_login: v.author_login,
        author_avatar: v.author_avatar,
        author_gh_id: v.author_gh_id,
        message: v.message ? `${prefix}: ${v.message}` : prefix,
        name: v.name,
      })
    }
    const comments = await meta.listComments(previewId)
    const threads = new Map<string, typeof comments>()
    for (const cm of comments) {
      const arr = threads.get(cm.thread_id)
      if (arr) arr.push(cm)
      else threads.set(cm.thread_id, [cm])
    }
    const baseVersion = latest?.n ?? 1
    for (const group of threads.values()) {
      const root = group.find((c) => c.id === c.thread_id) ?? group[0]
      if (!root) continue
      const newThreadId = newId("cmt")
      for (const cm of [root, ...group.filter((c) => c !== root)]) {
        await meta.createComment({
          id: cm === root ? newThreadId : newId("cmt"),
          artifact_id: canonicalId,
          thread_id: newThreadId,
          base_version: baseVersion,
          path: cm.path,
          anchor: cm.anchor,
          body_md: cm.body_md,
          author: cm.author,
          author_id: cm.author_id,
        })
      }
      if (root.state !== "open") await meta.setThreadState(canonicalId, newThreadId, root.state)
    }
    // Re-anchor the canonical doc's threads (incl. the migrated ones) against its new
    // current version — quoted text that survived the merge stays anchored, the rest flips
    // to `outdated` (Derive's normal post-version-bump behavior). Announce the transitions
    // on the bus too, so a tab open on the canonical doc live-updates after a PR graduates.
    if (latest) await publishSweepEvents(meta, blobs, bus, canonicalId, latest)
    // The preview copy is now redundant — hard-delete it (cascades its versions + comments).
    await meta.deleteArtifact(previewId, preview.org_id)
  }

  // On MERGE, GRADUATE the preview into the canonical collection instead of dropping it:
  // the docs you reviewed live on in "GitHub: <repo>" with their comments + the PR's
  // versions folded into history. Per path the preview owns: a doc the main mirror
  // doesn't track yet (the PR ADDS it) is PROMOTED — re-homed into the main collection and
  // handed to the branch source, keeping its artifact + versions + comments; a doc the
  // main mirror already owns (the PR EDITS it) is FOLDED into that canonical artifact.
  // Best-effort per path: one bad path is logged + skipped, never aborting the rest.
  const graduatePreview = async (preview: RepoSourceRecord): Promise<void> => {
    const branch = (await meta.listRepoSourcesByInstallation(preview.installation_id ?? "")).find(
      (s) => s.pr_number == null && s.repo.toLowerCase() === preview.repo.toLowerCase(),
    )
    // The branch mirror was disconnected mid-PR — nothing to graduate into; just tear down.
    if (!branch) return removePrPreview(preview)

    const previewMap = parseFileMap(preview.files)
    // Re-read the branch source for the freshest file map — the merge-commit push may be
    // syncing it concurrently; read-modify-write shrinks (not eliminates) that window.
    const freshBranch = (await meta.getRepoSource(branch.id, branch.org_id)) ?? branch
    const branchMap = parseFileMap(freshBranch.files)

    for (const [path, pf] of Object.entries(previewMap)) {
      if (!pf.artifact_id) continue
      try {
        const canonicalId = branchMap[path]?.artifact_id
        if (canonicalId && canonicalId !== pf.artifact_id) {
          await foldIntoCanonical(preview, pf.artifact_id, canonicalId)
          // The canonical doc now carries the merged content; mark the path current (with
          // the PR head sha) so the merge-push sync sees no change and skips it.
          branchMap[path] = { ...branchMap[path], ...pf }
        } else {
          // PROMOTE: re-home the artifact into the main collection + transfer ownership.
          await meta.removeCollectionItem(preview.collection_id, pf.artifact_id)
          await meta.addCollectionItem(branch.collection_id, pf.artifact_id)
          await meta.setArtifactSourcePath(pf.artifact_id, path)
          branchMap[path] = pf
        }
      } catch (err) {
        log.warn("pr graduate path skipped", {
          repo: preview.repo,
          pr: preview.pr_number,
          path,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    await meta.updateRepoSourceSync(branch.id, { files: JSON.stringify(branchMap) })
    // Drop the preview shell. Folded artifacts are already deleted; promoted ones were
    // moved out of this collection, so deleting it leaves the graduated docs untouched.
    await meta.deleteRepoSource(preview.id, preview.org_id)
    await meta.deleteCollection(preview.collection_id)
  }

  return { upsertPrPreview, previewCommentBody, removePrPreview, graduatePreview }
}
