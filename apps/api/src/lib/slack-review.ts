// Send back a review round from a Work Object button.
//
// Same resolution order as every Slack action: resolve the link, re-read the round rather
// than trusting the card, construct the Actor, refuse ephemerally. A reviewer clicking Send
// back in Slack must land in exactly the state the sidebar button would produce, because the
// agent polling catch_up cannot tell — and must not care — which surface settled the round.
//
// Permissions mirror routes/review.ts rather than inventing a Slack-specific rule: `comment`
// to send back — answering is collaboration.

import { type Actor, type ArtifactRecord, can, type MetaStore, maxRole } from "@derive/core"
import type { Backplane } from "../bus"
import { postSlackResponseUrl } from "./slack"
import { isVerifiedLink, linkToActMessage } from "./slack-identity"

export interface SlackReviewDeps {
  meta: MetaStore
  bus: Backplane
}

export interface SlackReviewArgs {
  teamId: string
  slackUserId: string
  /** The artifact the card is for, resolved from the Work Object's external_ref. */
  artifact: ArtifactRecord
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

  // No link → no Derive principal to authorize against. Verified only: settling a round is
  // recorded as this person's decision.
  const link = await meta.getSlackUserLinkBySlackId(args.teamId, args.slackUserId)
  if (!link || !isVerifiedLink(link)) {
    await eph(linkToActMessage("send back a review", link))
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
  if (!can(actor, "comment", artifact.workspace_access, artifact.link_role)) {
    await eph("You don't have permission to comment on that doc.")
    return
  }

  try {
    const linkedUser = (await meta.getUsers([link.user_id]))[0]
    const updated = await meta.resolveReviewRound(round.id, {
      state: "sent_back",
      note: null,
      resolved_by: link.user_id,
      resolved_by_name:
        linkedUser?.name ?? linkedUser?.username ?? linkedUser?.email ?? link.user_id,
    })
    if (!updated) {
      // Lost a race with another surface settling the same round.
      await eph("That review was just settled somewhere else.")
      return
    }
    bus.publish(artifact.id, { type: "review.sent_back", round_id: round.id })
    await eph(":leftwards_arrow_with_hook: Sent back — your answers are on their way.")
  } catch {
    await eph("Sorry — that didn't go through. Try it in Derive.")
  }
}
