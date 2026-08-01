// Approve / send back a review round from a Work Object button.
//
// The sibling of lib/slack-proposal.ts, and deliberately its twin: same resolution order, same
// re-read-don't-trust-the-button rule, same Actor construction, same ephemeral-on-refusal
// behaviour. A reviewer clicking Approve in Slack must land in exactly the state
// `derive approve` or the sidebar button would produce, because the agent polling catch_up
// cannot tell — and must not care — which surface settled the round.
//
// Permissions mirror routes/review.ts rather than inventing a Slack-specific rule: `comment` to
// send back (answering is collaboration), `approve` to approve (it is the build go-signal), and
// the billing gate on approve alone.

import { type Actor, type ArtifactRecord, can, type MetaStore, maxRole } from "@derive/core"
import type { Backplane } from "../bus"
import { postSlackResponseUrl } from "./slack"

export interface SlackReviewDeps {
  meta: MetaStore
  bus: Backplane
  billingBlocked: (orgId: string) => Promise<{ code: string; message: string } | null>
}

export interface SlackReviewArgs {
  teamId: string
  slackUserId: string
  /** The artifact the card is for, resolved from the Work Object's external_ref. */
  artifact: ArtifactRecord
  op: "approve" | "send_back"
  responseUrl?: string
}

/** Settle the artifact's pending round as the clicking user. All feedback rides `response_url`,
 *  so this runs off the interaction ack path. */
export const runSlackReviewAction = async (
  deps: SlackReviewDeps,
  args: SlackReviewArgs,
): Promise<void> => {
  const { meta, bus } = deps
  const artifact = args.artifact
  const eph = (text: string): Promise<boolean> =>
    args.responseUrl
      ? postSlackResponseUrl(args.responseUrl, { text, response_type: "ephemeral" })
      : Promise.resolve(false)

  // No link → no Derive principal to authorize against. Same prompt the proposal buttons give.
  const link = await meta.getSlackUserLinkBySlackId(args.teamId, args.slackUserId)
  if (!link) {
    await eph("Link your Slack account (Settings → Integrations) to review from Slack.")
    return
  }

  // Re-read the round rather than trusting anything on the card: it may have been settled from
  // Derive, or by someone else in this channel, since the unfurl was rendered.
  const round = await meta.getPendingRound(artifact.id)
  if (!round) {
    await eph("There's no review pending on that doc any more.")
    return
  }

  // Authorize as the linked Derive user — mirrors context.actorFor's human branch, then can().
  const orgRole = (await meta.getMembership(artifact.org_id, link.user_id))?.role ?? null
  const am = await meta.getArtifactMember(artifact.id, link.user_id)
  const cRoles = await meta.collectionRolesForArtifact(artifact.id, link.user_id)
  const actor: Actor = {
    kind: "user",
    userId: link.user_id,
    artifactRole: maxRole(am?.role ?? null, ...cRoles),
    orgRole,
    locked: !!artifact.password_hash,
    unlocked: false,
  }
  const need = args.op === "approve" ? "approve" : "comment"
  if (!can(actor, need, artifact.workspace_access, artifact.link_role)) {
    await eph(
      args.op === "approve"
        ? "You don't have permission to approve on that doc."
        : "You don't have permission to comment on that doc.",
    )
    return
  }

  try {
    if (args.op === "approve") {
      // Approving is the go-signal that unblocks a build; request-changes-shaped actions stay
      // free, exactly as the proposal path gates only its publishing branch.
      const blocked = await deps.billingBlocked(artifact.org_id)
      if (blocked) {
        await eph(blocked.message)
        return
      }
    }
    const updated = await meta.resolveReviewRound(round.id, {
      state: args.op === "approve" ? "approved" : "sent_back",
      note: null,
    })
    if (!updated) {
      // Lost a race with another surface settling the same round.
      await eph("That review was just settled somewhere else.")
      return
    }
    bus.publish(artifact.id, {
      type: args.op === "approve" ? "review.approved" : "review.sent_back",
      round_id: round.id,
    })
    await eph(
      args.op === "approve"
        ? ":white_check_mark: Approved — the agent is unblocked."
        : ":leftwards_arrow_with_hook: Sent back — your answers are on their way.",
    )
  } catch {
    await eph("Sorry — that didn't go through. Try it in Derive.")
  }
}
