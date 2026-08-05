// The one-time sweep that gives artifacts published BEFORE summaries existed the description
// every unfurl surface now shows.
//
// Sibling of `reindexSearchBatch` (lib/search.ts) and deliberately the same shape: publishing
// keeps summaries current going forward (lib/after-publish.ts), so this exists only to close the
// gap behind that wiring. Operator-triggered rather than a cron sweep, because unlike a preview
// render — which costs our own browser — every summary here costs a model call, and spending that
// across a whole corpus should be somebody's decision rather than a background job's.
//
// It calls the PUBLISH PATH's own `summarizeVersion`, so a backfilled artifact is described by
// exactly the same code as a freshly published one.

import type { ArtifactRecord, BlobStore, MetaStore, VersionRecord } from "@derive/core"
import { log } from "../log"
import type { Summarizer } from "../summarizer"
import { summarizeVersion } from "./after-publish"

export interface SummaryBackfillDeps {
  blobs: BlobStore
  meta: Pick<MetaStore, "listArtifacts" | "getVersion" | "setVersionSummary">
  summarize: Summarizer
}

export interface SummaryBackfillResult {
  /** Artifacts walked on this page. */
  scanned: number
  /** Artifacts whose current version already had one — the idempotency margin, so re-running
   *  from cursor 0 after a partial sweep costs a read each rather than a model call each. */
  alreadyHad: number
  /** Artifacts handed to the summarizer. NOT all of these produce a summary: a non-text version
   *  or one with too little prose is a legitimate skip, and `summarizeVersion` logs the reason. */
  attempted: number
  nextCursor: { key: string; id: string } | null
}

/**
 * How many artifacts one call may walk.
 *
 * Much smaller than `search-reindex`'s 200, and for a different reason. That endpoint's per-item
 * work is a blob read and a store write; this one's is a MODEL CALL, ~1–2 seconds of wall time
 * each. Two hundred of those serially would exceed the invocation long before any subrequest
 * ceiling. Bounded concurrency below recovers most of it — the calls are I/O, not CPU — but the
 * page stays small so a slow model cannot wedge the operator's cursor.
 */
export const BACKFILL_MAX_LIMIT = 50
export const BACKFILL_DEFAULT_LIMIT = 25

/** How many summaries are in flight at once. Enough to hide per-call latency, low enough that a
 *  page cannot flood a rate-limited model endpoint. */
const CONCURRENCY = 5

/** Run `work` over `items`, at most CONCURRENCY at a time. */
const pooled = async <T>(items: T[], work: (item: T) => Promise<void>): Promise<void> => {
  let next = 0
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]
      if (item !== undefined) await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, runner))
}

export const backfillSummaryBatch = async (
  deps: SummaryBackfillDeps,
  opts: { orgId?: string; cursor?: { key: string; id: string }; limit: number },
): Promise<SummaryBackfillResult> => {
  const arts = await deps.meta.listArtifacts({
    orgId: opts.orgId,
    cursor: opts.cursor,
    limit: opts.limit,
    excludeRemoved: true,
  })
  let alreadyHad = 0
  let attempted = 0
  const todo: { artifact: ArtifactRecord; version: VersionRecord }[] = []
  for (const a of arts) {
    const version = await deps.meta.getVersion(a.id, a.current_version)
    if (!version) continue // no current version to describe
    // Skipping an artifact that already has one is what makes a re-sweep cheap: a partial run
    // can be resumed from cursor 0 without paying the model twice for everything before it.
    if (version.summary) {
      alreadyHad++
      continue
    }
    todo.push({ artifact: a, version })
  }
  await pooled(todo, async ({ artifact, version: v }) => {
    attempted++
    // Isolated per artifact: one unreadable blob or a single model failure must not abort the
    // page and wedge the cursor. `summarizeVersion` already swallows its own skip cases and logs
    // them; this catches the ones it cannot, so the sweep always makes forward progress.
    try {
      await summarizeVersion(deps.meta, deps.blobs, deps.summarize, artifact, v)
    } catch (err) {
      log.error("summary backfill skipped one artifact", {
        artifact: artifact.id,
        err: String(err),
      })
    }
  })
  const last = arts.at(-1)
  return {
    scanned: arts.length,
    alreadyHad,
    attempted,
    // Identical to reindexSearchBatch's construction, so the operator loop is the one they
    // already know: re-POST with nextCursor until it comes back null.
    nextCursor: arts.length >= opts.limit && last ? { key: last.created_at, id: last.id } : null,
  }
}
