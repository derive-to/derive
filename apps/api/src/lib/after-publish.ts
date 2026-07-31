// The side-effect chain every new live version runs, in ONE place. A version reaches
// "live" from three entry points — the HTTP publish route, the MCP publish tool, and a
// version restore — and each used to hand-copy the same fan-out. When they drift, an MCP
// publish silently skips webhooks (the exact bug this consolidation exists to prevent from
// recurring). Proposal-approve shares the realtime core via `emitVersionBump` but keeps its
// own `proposal.approved` webhook, so it stays in proposal-actions.ts.
//
// `lint:api` forbids constructing a raw `version.published` bus event or the follower
// fan-out anywhere but this file — every publish path must route through here.

import {
  type ArtifactRecord,
  type BlobStore,
  DERIVED_FACT_GEN,
  deriveFacts,
  FACT_GEN,
  type MetaStore,
  newId,
  parseFacts,
  type SearchIndex,
  type VersionRecord,
} from "@derive/core"
import type { Backplane } from "../bus"
import type { WebhookEvent } from "../events"
import { log } from "../log"
import { publishSweepEvents } from "./anchor-sweep"
import { indexArtifactVersion } from "./search"

/** The realtime + render + re-anchor core shared by every version bump (publish, restore,
 *  proposal-approve): announce the new version so open tabs live-reload, enqueue its preview
 *  render, then re-anchor existing threads against the new content. Webhook delivery and
 *  follower fan-out are NOT here — they differ per path and live in {@link afterPublish}. */
export interface VersionBumpDeps {
  meta: MetaStore
  blobs: BlobStore
  bus: Backplane
  /** Preview render. Kept off the request path by the CALLER's `background()` (waitUntil on
   *  Workers, inline on Node), so awaiting here costs a deployment nothing and stops the write
   *  being orphaned. Optional so a caller without render access (a test) omits it. */
  notifyRender?: (a: ArtifactRecord, n: number) => void | Promise<void>
  /** The optional dense/semantic search index (Cloudflare edge). When bound, every version
   *  bump keeps it current alongside the lexical FTS — best-effort, in indexArtifactVersion. */
  search?: SearchIndex
  /** Off-hot-path escape hatch (waitUntil on Workers, inline on Node), used for the data-slot
   *  history backfill — the one bump-time job that can cost dozens of blob reads. Optional
   *  because restore and proposal-approve reach this without one; they just pay it inline. */
  background?: (work: Promise<unknown>) => Promise<void>
}

export const emitVersionBump = async (
  deps: VersionBumpDeps,
  artifact: ArtifactRecord,
  version: VersionRecord,
): Promise<void> => {
  const { meta, blobs, bus, notifyRender } = deps
  bus.publish(artifact.id, { type: "version.published", n: version.n, message: version.message })
  await notifyRender?.(artifact, version.n)
  await publishSweepEvents(meta, blobs, bus, artifact.id, version)
  // Keep the workspace search index current for the new live version. Best-effort:
  // a search-index hiccup must never fail a publish that already succeeded, so log
  // and move on — the artifact re-indexes on its next publish (and the backfill
  // sweep is the safety net for anything missed).
  try {
    await indexArtifactVersion(meta, blobs, artifact, version, deps.search)
  } catch (err) {
    log.error("search index update failed", { artifact: artifact.id, err: String(err) })
  }
  // Extract this version's structured facts into queryable rows. Sibling to search
  // indexing — same "every publish/restore/proposal-approve" reach, same best-effort
  // contract (a hiccup must never fail a publish that already went live). The publish
  // response already advises about any UNstored slot via publishAdvisories; this is the
  // persistence half, and both call the one parser so they can't disagree.
  try {
    await extractVersionData(meta, blobs, version, deps.background)
  } catch (err) {
    log.error("data-slot extraction failed", { artifact: artifact.id, err: String(err) })
  }
}

/** Extract a single-file HTML/markdown version's facts and persist them (see
 *  @derive/core data-facts). Bundles, decks and non-text versions carry no facts and are
 *  skipped. Writes only when at least one slot parsed — a fresh version has no prior rows,
 *  so there is nothing to clear when it has none. */
const extractVersionData = async (
  meta: Pick<MetaStore, "setVersionData" | "getVersionData" | "getVersion">,
  blobs: BlobStore,
  version: VersionRecord,
  background?: (work: Promise<unknown>) => Promise<void>,
): Promise<void> => {
  const ct = version.content_type
  if (ct !== "text/html" && ct !== "text/markdown") return
  const bytes = await blobs.get(version.blob_key)
  if (!bytes) return
  const source = new TextDecoder().decode(bytes)
  const { facts } = parseFacts(source, ct)
  // Derived facts ($outline/$links/$stats) ride the same pass over bytes already decoded:
  // the host's mechanical reading, in the namespace the author grammar can't reach. They
  // are cache entries with names — recomputable, never counted, never rewarded — so their
  // gen is the DERIVER's generation, not the extraction grammar's.
  const derived = deriveFacts(source, ct)
  const rows = [
    ...facts.map((s) => ({
      id: newId("vd"),
      slot: s.slot,
      json: s.json,
      size_bytes: s.bytes,
      gen: FACT_GEN,
    })),
    ...derived.map((s) => ({
      id: newId("vd"),
      slot: s.slot,
      json: s.json,
      size_bytes: s.bytes,
      gen: DERIVED_FACT_GEN,
    })),
  ]
  if (rows.length === 0) return
  // ONE setVersionData call: it is a full replace, so asserted and derived must land
  // together or the second write erases the first — the same union trap the backfill
  // below documents for itself.
  await meta.setVersionData(version.artifact_id, version.n, rows)
  if (facts.length === 0) return
  // Off the hot path where the caller can: the walk-back costs a blob read per version.
  // ASSERTED names only — old versions get their derived rows lazily on first read, so a
  // backfill walk never pays derivation for versions nobody asks about.
  const backfill = backfillNewSlots(
    meta,
    blobs,
    version,
    facts.map((s) => s.slot),
  )
  await (background ? background(backfill) : backfill)
}

/** Versions walked back when a fact first appears. Bounded because each one costs a blob
 *  read: enough to cover a month of daily publishing, short of scanning an artifact with
 *  a thousand versions on a whim. */
const BACKFILL_MAX_VERSIONS = 50

/**
 * When a fact appears on an artifact for the FIRST time, extract it from the versions
 * that came before.
 *
 * Extraction runs at publish, so without this a fact's series begins the day it was added
 * and the history is silently lost — the first sharp edge anyone adding a fact to a real
 * artifact meets, and the one that made this repo's own fourteen-version demo come back
 * empty. The blocks were usually already in those older pages (a page that carried its
 * figures before facts existed still carries them); nothing had ever read them.
 *
 * Fires only on the transition — a fact present in the previous version is already being
 * tracked, so an ordinary republish does no extra work. Merges rather than replaces, since
 * setVersionData is a full replace and an older version may already have other facts.
 * Best-effort and bounded: this must never fail or noticeably slow a publish that already
 * went live.
 */
const backfillNewSlots = async (
  meta: Pick<MetaStore, "setVersionData" | "getVersionData" | "getVersion">,
  blobs: BlobStore,
  version: VersionRecord,
  slotNames: string[],
): Promise<void> => {
  if (version.n <= 1 || slotNames.length === 0) return
  try {
    const previous = await meta.getVersionData(version.artifact_id, version.n - 1)
    const alreadyTracked = new Set(previous.map((r) => r.slot))
    const fresh = new Set(slotNames.filter((s) => !alreadyTracked.has(s)))
    if (fresh.size === 0) return

    const oldest = Math.max(1, version.n - BACKFILL_MAX_VERSIONS)
    let filled = 0
    for (let n = version.n - 1; n >= oldest; n--) {
      const old = await meta.getVersion(version.artifact_id, n)
      if (!old) continue
      const ct = old.content_type
      if (ct !== "text/html" && ct !== "text/markdown") continue
      const bytes = await blobs.get(old.blob_key)
      if (!bytes) continue
      const found = parseFacts(new TextDecoder().decode(bytes), ct).facts.filter((s) =>
        fresh.has(s.slot),
      )
      if (!found.length) continue
      // Union with whatever that version already has: setVersionData replaces the row set.
      const existing = await meta.getVersionData(version.artifact_id, n)
      const have = new Set(existing.map((r) => r.slot))
      const additions = found.filter((s) => !have.has(s.slot))
      if (!additions.length) continue
      await meta.setVersionData(version.artifact_id, n, [
        ...existing.map((r) => ({
          id: r.id,
          slot: r.slot,
          json: r.json,
          size_bytes: r.size_bytes,
          gen: r.gen,
        })),
        ...additions.map((s) => ({
          id: newId("vd"),
          slot: s.slot,
          json: s.json,
          size_bytes: s.bytes,
          gen: FACT_GEN,
        })),
      ])
      filled++
    }
    // Say what was recovered and how far back it reached. On Workers this runs inside
    // waitUntil, whose budget can end it mid-walk: the result is a SHORTER history, never a
    // wrong one, but without this line a truncated backfill and a complete one look
    // identical afterwards. `truncated` marks the case where an older version may still be
    // unfilled because the cap, not the content, stopped the walk.
    if (filled)
      log.info("data-slot backfill", {
        artifact: version.artifact_id,
        facts: [...fresh],
        versions_filled: filled,
        oldest_scanned: oldest,
        truncated: oldest > 1,
      })
  } catch (err) {
    log.error("data-slot backfill failed", { artifact: version.artifact_id, err: String(err) })
  }
}

export interface AfterPublishDeps extends VersionBumpDeps {
  notify: (a: ArtifactRecord, event: WebhookEvent, data: Record<string, unknown>) => Promise<void>
  /** Run after-response work off the hot path (webhook enqueue, follower fan-out). */
  background: (work: Promise<unknown>) => Promise<void>
}

export interface AfterPublishOpts {
  /** First version of a brand-new artifact — gates the one-time follower fan-out (a
   *  republish must not re-notify followers on every edit). */
  isNew: boolean
  /** The human behind the publish (a session user, or an agent's registrant). Their
   *  followers are the ones who care; null for a truly headless publish. */
  onBehalf: string | null
  /** Thread ids to resolve in the same call (a live publish that fixes feedback). The
   *  caller has already validated these belong to `artifact`. */
  resolves?: string[]
}

/**
 * Everything that must happen after a publish makes a version live, canonicalized so the
 * HTTP route, the MCP tool, and restore can't drift: fire the `version.published` webhook,
 * fan out to the publisher's followers (new + human + public only), resolve any threads
 * named in the call, then run the shared realtime/render/re-anchor bump. Returns the thread
 * ids actually resolved so the caller can report them.
 */
export const afterPublish = async (
  deps: AfterPublishDeps,
  artifact: ArtifactRecord,
  version: VersionRecord,
  opts: AfterPublishOpts,
): Promise<{ resolved: string[] }> => {
  const { meta, bus, notify, background } = deps
  await notify(artifact, "version.published", {
    version: version.n,
    message: version.message,
    author: version.author,
  })
  // Fan out to the publisher's followers: "someone you follow published X". Gated to a
  // known HUMAN behind the publish (an agent publish fans out to the followers of the
  // person it acts for), a publicly-listed artifact (a follow never surfaces a private
  // title), and a NEW artifact only. In the background so a popular author's fan-out never
  // adds to publish latency.
  if (opts.isNew && opts.onBehalf && artifact.listed === "public") {
    const behalf = opts.onBehalf
    background(fanOutToFollowers(meta, behalf, artifact))
  }
  // A live publish that fixes feedback resolves those threads directly.
  const resolved: string[] = []
  for (const threadId of opts.resolves ?? []) {
    await meta.setThreadState(artifact.id, threadId, "resolved")
    bus.publish(artifact.id, { type: "comment.resolved", thread_id: threadId, state: "resolved" })
    resolved.push(threadId)
  }
  await emitVersionBump(deps, artifact, version)
  return { resolved }
}

const fanOutToFollowers = async (
  meta: MetaStore,
  authorId: string,
  artifact: ArtifactRecord,
): Promise<void> => {
  const [author] = await meta.getUsers([authorId])
  if (!author) return
  const followers = await meta.listFollowers(author.id, 200)
  // One bulk insert for the whole fan-out, not a createNotification per follower.
  await meta.createNotifications(
    followers
      .filter((follower) => follower.id !== author.id)
      .map((follower) => ({
        id: newId("ntf"),
        user_id: follower.id,
        actor: author.name ?? author.username ?? "Someone",
        kind: "publish",
        artifact_id: artifact.id,
        artifact_short_id: artifact.short_id,
        artifact_title: artifact.title,
        thread_id: "",
        comment_id: "",
        preview: artifact.title ?? "published something new",
      })),
  )
}
