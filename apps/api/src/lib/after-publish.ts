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
  type MetaStore,
  newId,
  sha256Hex,
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
  /** Fire-and-forget preview render. Optional so a caller without render access (a test) omits it. */
  notifyRender?: (a: ArtifactRecord, n: number) => void
}

export const emitVersionBump = async (
  deps: VersionBumpDeps,
  artifact: ArtifactRecord,
  version: VersionRecord,
): Promise<void> => {
  const { meta, blobs, bus, notifyRender } = deps
  bus.publish(artifact.id, { type: "version.published", n: version.n, message: version.message })
  notifyRender?.(artifact, version.n)
  await publishSweepEvents(meta, blobs, bus, artifact.id, version)
  // Keep the workspace search index current for the new live version. Best-effort:
  // a search-index hiccup must never fail a publish that already succeeded, so log
  // and move on — the artifact re-indexes on its next publish (and the backfill
  // sweep is the safety net for anything missed).
  try {
    await indexArtifactVersion(meta, blobs, artifact, version)
  } catch (err) {
    log.error("search index update failed", { artifact: artifact.id, err: String(err) })
  }
}

export interface AfterPublishDeps extends VersionBumpDeps {
  notify: (a: ArtifactRecord, event: WebhookEvent, data: Record<string, unknown>) => Promise<void>
  /** Run after-response work off the hot path (webhook enqueue, follower fan-out). */
  background: (work: Promise<unknown>) => Promise<void>
  /** Base domain for auto-assigned isolated subdomains (`<label>.<base>`). Unset ⇒
   *  auto-assignment off (self-host without domain mode) — artifacts still serve
   *  fine on /raw, just without the app-like capability grant. */
  subdomainBase?: string
  /** Server secret the unguessable subdomain label is derived from (the same
   *  encryption key the raw/preview tokens use). Unset ⇒ auto-assignment off. */
  subdomainSalt?: string
}

/** A bundle that routes every path to its entry — a client-side-routed SPA. This is
 *  the case that's actually BROKEN without an isolated origin (its router needs real
 *  History access), so it's the case auto-subdomain assignment targets. A plain
 *  single-file page renders fine on the shared sandbox; it doesn't earn a DNS name. */
const isSpaBundle = (a: ArtifactRecord): boolean => a.kind === "bundle" && a.spa === 1

/** The deterministic, unguessable subdomain label for an artifact: a salted hash of
 *  its id (never a sequential/guessable value — see the isolation plan). Deterministic
 *  on purpose: two racing publishes derive the SAME host, so the second setDomain is a
 *  harmless idempotent no-op rather than a second subdomain for one artifact. */
export const autoSubdomainLabel = async (artifactId: string, salt: string): Promise<string> => {
  const h = await sha256Hex(new TextEncoder().encode(`isolated-subdomain:${artifactId}:${salt}`))
  // 20 hex chars = 80 bits, unguessable; prefixed so it always leads with a letter
  // and can't collide with a reserved all-letters label.
  return `d${h.slice(0, 20)}`
}

/** Auto-assign an isolated per-artifact subdomain the first time an SPA bundle goes
 *  live, so its client routing / storage / service workers work (see headersFor's
 *  capability grant). Best-effort and idempotent: no config ⇒ skip, not an SPA ⇒
 *  skip, already has an artifact-bound host ⇒ skip. Never fails the publish. */
export const maybeAssignIsolatedSubdomain = async (
  deps: Pick<AfterPublishDeps, "meta" | "subdomainBase" | "subdomainSalt">,
  artifact: ArtifactRecord,
): Promise<void> => {
  const { meta, subdomainBase, subdomainSalt } = deps
  if (!subdomainBase || !subdomainSalt || !isSpaBundle(artifact)) return
  try {
    const existing = await meta.getArtifactDomains(artifact.id)
    if (existing.length) return // already isolated (auto or a vanity name)
    const host = `${await autoSubdomainLabel(artifact.id, subdomainSalt)}.${subdomainBase}`
    await meta.setDomain({
      host,
      artifact_id: artifact.id,
      org_id: artifact.org_id,
      kind: "subdomain",
    })
  } catch (err) {
    log.error("auto-subdomain assignment failed", { artifact: artifact.id, err: String(err) })
  }
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
  // First time an SPA bundle goes live, give it its own isolated origin so its
  // client routing / storage work — off the hot path, best-effort, idempotent.
  background(maybeAssignIsolatedSubdomain(deps, artifact))
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
