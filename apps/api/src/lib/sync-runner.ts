// Shared sync orchestration, decoupled from the HTTP route so the same code runs
// the sync from: (1) the route (when no background runner is wired — tests/dev),
// (2) the RepoSyncRunner Durable Object (Workers), and (3) the Node detached loop.
// One bounded batch at a time; the caller loops until `remaining === 0`.

import type { BlobStore, MetaStore, RepoSourceRecord } from "@derive/core"
import { decryptSecret } from "./crypto"
import { GitHubError } from "./github"
import { installationToken } from "./github-app"
import { MAX_UPLOAD_BYTES } from "./http"
import { runSync, type SyncResult } from "./sync"

/** Publishes per batch — bounds one run to a Worker/alarm budget. With concurrent
 *  blob prefetch the per-batch wall-clock is no longer fetch-bound, so a larger batch
 *  is safe: fewer batches means the repo tree is re-listed fewer times and fewer
 *  inter-alarm gaps. 150 keeps a worst-case all-changed batch under the Workers
 *  1000-subrequests/invocation ceiling (drop to 100 if that proves tight). */
const SYNC_BATCH = 150

/** No-op storage gate (background runs skip the workspace byte cap; the per-file
 *  cap + the artifact-count cap at trigger time still apply). */
const NO_STORAGE_LIMIT = async (): Promise<boolean> => false

/** The read token for a source: a freshly-minted installation token (App path) or
 *  the decrypted PAT (BYO path). Null when neither applies (a public repo). */
export async function effectiveToken(
  meta: MetaStore,
  encryptionKey: string | undefined,
  source: RepoSourceRecord,
): Promise<string | null> {
  if (source.installation_id) {
    const app = encryptionKey ? await meta.getGithubApp() : null
    if (!app || !encryptionKey)
      throw new GitHubError(400, "GitHub App is not configured on this instance")
    return installationToken(
      app.app_id,
      decryptSecret(app.private_key, encryptionKey),
      source.installation_id,
    )
  }
  return source.token && encryptionKey ? decryptSecret(source.token, encryptionKey) : source.token
}

/** Run ONE bounded batch for a source. Returns the result (incl. `remaining`). */
export async function runSourceBatch(
  meta: MetaStore,
  blobs: BlobStore,
  encryptionKey: string | undefined,
  source: RepoSourceRecord,
  overStorage: (incoming: number) => Promise<boolean> = NO_STORAGE_LIMIT,
): Promise<SyncResult> {
  const token = await effectiveToken(meta, encryptionKey, source)
  return runSync(meta, blobs, { ...source, token }, new Date().toISOString(), {
    maxBytes: MAX_UPLOAD_BYTES,
    maxFiles: SYNC_BATCH,
    overStorage,
  })
}

/**
 * Drive a source to completion: re-load it each batch (its file map grows) and run
 * batches until nothing remains. Used by the Node detached loop and as the inline
 * fallback in the route. The DO instead runs ONE batch per alarm (so it never holds
 * a long-running task) — both reach the same end state because progress + the file
 * map persist every batch. `maxBatches` is a runaway backstop.
 */
export async function runToCompletion(
  meta: MetaStore,
  blobs: BlobStore,
  encryptionKey: string | undefined,
  sourceId: string,
  maxBatches = 500,
): Promise<void> {
  for (let i = 0; i < maxBatches; i++) {
    const source = await meta.getRepoSource(sourceId)
    if (!source) return
    const res = await runSourceBatch(meta, blobs, encryptionKey, source)
    if (res.remaining === 0) return
  }
}

/** Is a source mid-sync? (drives the global "syncing" chip + Node restart-resume.) */
export const isSyncing = (s: RepoSourceRecord): boolean => {
  if (!s.progress) return false
  try {
    const phase = (JSON.parse(s.progress) as { phase?: string }).phase
    return phase === "queued" || phase === "listing" || phase === "mirroring"
  } catch {
    return false
  }
}
