// THE REVIEW-REQUEST FAN-OUT, written once for both publish surfaces.
//
// A publish that asks for review notifies the reviewer through every channel that can carry
// it: the round itself, the live bus, the webhook/channel card, the email, the Slack DM.
// Both the HTTP route (routes/artifacts.ts) and the MCP publish tool (mcp-tools/publish.ts)
// run this one sequence — two hand-rolled copies of a five-channel fan-out would quietly
// disagree on which channels carry the note, and the note is the go-signal. The call sites
// keep only what genuinely differs: who the reviewer is, and what the channel card should
// attribute.
//
// The Slack completion, bell + auto-open push an agent-credentialed publish owes the human behind the grant
// (`agentPushFanout`) is shared for the same reason: one row per push, a review ask beats a
// plain publish, and the delivery receipt becomes `opened_in_tab`.

import {
  type ArtifactRecord,
  artifactUrl,
  type BlobStore,
  type MetaStore,
  newId,
} from "@derive/core"
import type { Backplane } from "../bus"
import type { WebhookEvent } from "../events"
import { log } from "../log"
import { enqueueChannelDelivery } from "../webhooks"
import { buildReviewEmail } from "./email"
import { buildReviewSummary, type ReviewSummary } from "./review-summary"
import {
  enqueueSlackArtifactCompletedDm,
  enqueueSlackReviewRequestedDm,
  wantsReviewEmail,
} from "./slack-dm"

export interface ReviewRequestDeps {
  meta: MetaStore
  blobs: BlobStore
  bus: Backplane
  baseUrl: string
  notify: (a: ArtifactRecord, event: WebhookEvent, data: Record<string, unknown>) => Promise<void>
  pokeWebhooks?: () => void
}

export interface ReviewRequestInput {
  /** The user the round asks. Resolving WHO stays at the call site — the HTTP route falls
   *  back to the workspace's first owner, the MCP tool to the human behind the grant. */
  reviewer: string
  /** Who asked, as the round records it (an agent id, or the acting user's id). */
  requestedById: string
  /** Who asked, as a person reads it — the email, the DM and the channel card all say it. */
  requestedByName: string
  version: number
  /** The requester's note, when the surface carries one. Rides the round, the email and
   *  the Slack DM alike — the go-signal must read the same everywhere. */
  note?: string | null
  /** What the channel card's human/agent filter keys on: the agent principal when one is
   *  acting, else the acting user; null when neither is known. The card's `author` is
   *  always `requestedByName`. */
  actorId: string | null
}

/** Open the round and run the whole reviewer fan-out. Returns the round id. */
export const openReviewRound = async (
  deps: ReviewRequestDeps,
  artifact: ArtifactRecord,
  input: ReviewRequestInput,
): Promise<string> => {
  const round = await deps.meta.createReviewRound({
    id: newId("rr"),
    artifact_id: artifact.id,
    version: input.version,
    requested_by: input.requestedById,
    requested_for: input.reviewer,
    ...(input.note !== undefined ? { note: input.note } : {}),
  })
  deps.bus.publish(artifact.id, { type: "review.requested", round_id: round.id })
  await deps.notify(artifact, "review.requested", {
    version: input.version,
    requested_by: input.requestedByName,
    author: input.requestedByName,
    actor_id: input.actorId,
  })
  let summary: ReviewSummary
  try {
    summary = await buildReviewSummary(
      deps.meta,
      deps.blobs,
      artifact.id,
      input.version,
      input.note,
    )
  } catch (err) {
    log.warn("review summary could not be built; sending the review request without a diff", {
      artifact: artifact.id,
      version: input.version,
      error: err instanceof Error ? err.message : String(err),
    })
    summary = {
      fromVersion: input.version > 1 ? input.version - 1 : null,
      toVersion: input.version,
      added: 0,
      removed: 0,
      changes: [],
      totalChanges: 0,
      highlights: [],
      note: input.note ?? null,
    }
  }
  const [reviewer, pref, orgSettings] = await Promise.all([
    deps.meta.getUsers([input.reviewer]).then(([user]) => user),
    deps.meta.getUserNotificationPref(artifact.org_id, input.reviewer),
    deps.meta.getOrgSettings(artifact.org_id),
  ])
  // Slack is the default review surface, including attended Derive sessions. It now carries
  // enough of the diff to be useful rather than merely echoing that a request exists.
  await enqueueSlackReviewRequestedDm(
    { meta: deps.meta, baseUrl: deps.baseUrl },
    artifact,
    {
      requestedBy: input.requestedByName,
      roundId: round.id,
      version: input.version,
      note: input.note ?? null,
      summary,
    },
    input.reviewer,
  )
  // Review email requires both the workspace master gate and an explicit personal opt-in.
  if (orgSettings.emailNotifications && wantsReviewEmail(pref?.prefs) && reviewer?.email)
    await enqueueChannelDelivery(deps.meta, "email", "review.requested", {
      to: reviewer.email,
      toName: reviewer.name ?? undefined,
      ...buildReviewEmail(deps.baseUrl, artifact, {
        requestedBy: input.requestedByName,
        version: input.version,
        note: input.note ?? null,
        summary,
      }),
    })
  // notify() poked before these direct outbox rows existed. Wake the drainer again so Slack
  // arrives immediately instead of waiting for the next hosted cron tick.
  deps.pokeWebhooks?.()
  return round.id
}

export interface AgentPushInput {
  /** The human behind the grant — bell row owner and auto-open channel. */
  user: string
  /** The agent principal, for attribution and the service-context check. */
  agentId: string
  agentName: string
  version: number
  /** A round was opened for this push — the bell says "review", never both rows. */
  reviewRound: boolean
  /** A create pushes even without a round; a plain revision does not. */
  isNew: boolean
  /** Whether this surface should try to auto-open the artifact in a live Derive tab. */
  notifyBrowser?: boolean
}

/**
 * The Slack completion, bell + auto-open an agent-credentialed publish owes the human behind
 * the grant, so a push reaches them even with no tab open. Returns whether an open tab caught the push
 * (`opened_in_tab`), so the agent knows whether to open the URL itself.
 */
export const agentPushFanout = async (
  deps: Pick<ReviewRequestDeps, "meta" | "blobs" | "bus" | "baseUrl" | "pokeWebhooks">,
  artifact: ArtifactRecord,
  input: AgentPushInput,
): Promise<boolean> => {
  // A successful agent publish is the reliable completion boundary shared by every client.
  // Review asks already enqueue a richer actionable DM, so one version never produces both.
  if (!input.reviewRound) {
    let summary: ReviewSummary
    try {
      summary = await buildReviewSummary(deps.meta, deps.blobs, artifact.id, input.version)
    } catch (err) {
      log.warn("completion summary could not be built; sending completion without a diff", {
        artifact: artifact.id,
        version: input.version,
        error: err instanceof Error ? err.message : String(err),
      })
      summary = {
        fromVersion: input.version > 1 ? input.version - 1 : null,
        toVersion: input.version,
        added: 0,
        removed: 0,
        changes: [],
        totalChanges: 0,
        highlights: [],
        note: null,
      }
    }
    await enqueueSlackArtifactCompletedDm(
      { meta: deps.meta, baseUrl: deps.baseUrl },
      artifact,
      { agentName: input.agentName, version: input.version, summary },
      input.user,
    )
    // Completion rows intentionally wait for the regular outbox tick, giving rapid publishes
    // time to collapse into the latest card. Review requests still poke immediately above.
  }
  // One bell row per push that warrants one: a review ask beats a plain "published".
  if (input.reviewRound || input.isNew) {
    const row = {
      id: newId("n"),
      user_id: input.user,
      actor: input.agentName,
      kind: input.reviewRound ? ("review" as const) : ("publish" as const),
      artifact_id: artifact.id,
      artifact_short_id: artifact.short_id,
      artifact_title: artifact.title,
      thread_id: "",
      comment_id: "",
      preview: input.reviewRound
        ? `requested your review of v${input.version}`
        : (artifact.title ?? "published something new"),
    }
    await deps.meta.createNotification(row)
    deps.bus.publish(`u:${input.user}`, {
      type: "notification",
      notification: { ...row, read: 0, created_at: new Date().toISOString() },
    })
  }
  if (input.notifyBrowser === false) return false

  // A context-bound agent is an askable service: its publishes are routinely OTHER
  // people's asks riding this owner's grant, so the push must not commandeer the owner's
  // browser. Flag it — the client downgrades auto-open to a toast (the bell row still
  // lands).
  const contexts = await deps.meta.listContexts(artifact.org_id)
  const service = contexts.some((x) => x.agent_id === input.agentId)
  const pushed = {
    type: "artifact.pushed" as const,
    event_id: newId("ev"),
    short_id: artifact.short_id,
    artifact_id: artifact.id,
    title: artifact.title,
    version: input.version,
    kind: input.isNew ? ("created" as const) : ("revised" as const),
    url: artifactUrl(deps.baseUrl, artifact),
    agent: input.agentName,
    review_requested: input.reviewRound,
    service,
  }
  const channel = `u:${input.user}`
  if (deps.bus.publishWithReceipt) {
    return await Promise.race([
      deps.bus.publishWithReceipt(channel, pushed).then((n) => n > 0),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
    ])
  }
  deps.bus.publish(channel, pushed)
  return false
}
