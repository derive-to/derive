// Approve / request-changes a proposal from a Slack button. Unlike thread resolve (a low-stakes
// action gated only by the channel connection), approving a proposal is editor-level, so it is
// authorized AS the clicking user's linked Derive account — the whole reason account linking is a
// prerequisite. Runs the same proposal-actions pipeline the HTTP route does.

import { type Actor, can, maxRole } from "@derive/core"
import {
  approveProposalAction,
  type ProposalActionDeps,
  requestChangesAction,
} from "./proposal-actions"
import { postSlackResponseUrl } from "./slack"
import { context, mrkdwnLabel } from "./slack-cards"
import { isVerifiedLink, linkToActMessage } from "./slack-identity"

/** `ProposalActionDeps` plus what THIS surface needs beyond what approve/request-changes
 *  themselves use: the billing gate, threaded in exactly like `meta` and the rest arrive —
 *  the caller (routes/slack.ts) builds this object from its own `ctx` destructure. */
export interface SlackProposalDeps extends ProposalActionDeps {
  billingBlocked: (orgId: string) => Promise<{ code: string; message: string } | null>
}

export interface SlackProposalArgs {
  teamId: string
  slackUserId: string
  proposalId: string
  artifactId: string
  op: "approve" | "request_changes"
  /** Where to send the ephemeral outcome / card update (from the interaction payload). */
  responseUrl?: string
  /** The original card's first block, kept when we replace the card after a decision. */
  sectionBlock?: unknown
}

/** Resolve the clicking Slack user to their Derive account, authorize (editor), run the action,
 *  and update the Slack card / send an ephemeral error. All feedback rides `response_url` so this
 *  can run off the interaction ack path (approving publishes a version — not sub-3s work). */
export const runSlackProposalAction = async (
  deps: SlackProposalDeps,
  args: SlackProposalArgs,
): Promise<void> => {
  const eph = (text: string): Promise<boolean> =>
    args.responseUrl
      ? postSlackResponseUrl(args.responseUrl, { text, response_type: "ephemeral" })
      : Promise.resolve(false)

  // No link → no Derive principal to authorize against; prompt them to link (private msg).
  // A deliberate link, not merely a matched email: approving publishes a version under this
  // person's name. See lib/slack-identity.ts for why the split is drawn at writes.
  const link = await deps.meta.getSlackUserLinkBySlackId(args.teamId, args.slackUserId)
  if (!link || !isVerifiedLink(link)) {
    await eph(linkToActMessage("decide proposals", link))
    return
  }
  const artifact = await deps.meta.getArtifactById(args.artifactId)
  const proposal = await deps.meta.getProposal(args.proposalId)
  if (!artifact || !proposal || proposal.artifact_id !== artifact.id) {
    await eph("That proposal is no longer available.")
    return
  }

  // Authorize as the linked Derive user — mirrors context.actorFor's human branch, then can().
  const orgRole = (await deps.meta.getMembership(artifact.org_id, link.user_id))?.role ?? null
  const am = await deps.meta.getArtifactMember(artifact.id, link.user_id)
  const cRoles = await deps.meta.collectionRolesForArtifact(artifact.id, link.user_id)
  const actor: Actor = {
    kind: "user",
    userId: link.user_id,
    artifactRole: maxRole(am?.role ?? null, ...cRoles),
    orgRole,
    locked: !!artifact.password_hash,
    unlocked: false,
  }
  if (!can(actor, "approve", artifact.workspace_access, artifact.link_role)) {
    await eph("You don't have permission to approve proposals on this artifact.")
    return
  }
  // Fresh open-state check (the proposal was just re-read), so a click on a card whose proposal
  // was already decided elsewhere no-ops with a message. NOTE: this is not a lock — two truly
  // concurrent decisions can still both pass (a pre-existing race the HTTP approve route shares;
  // the real fix is an atomic decide in core, out of scope here).
  if (proposal.state !== "open") {
    await eph(`This proposal is already ${proposal.state}.`)
    return
  }

  const [du] = await deps.meta.getUsers([link.user_id])
  const who = du?.name ?? link.user_id // raw name stored as the decider; escaped only for display
  const display = mrkdwnLabel(who)
  const replaceCard = (line: string): Promise<boolean> => {
    if (!args.responseUrl) return Promise.resolve(false)
    const blocks = [args.sectionBlock, context(`Derive · ${line}`)].filter(Boolean)
    return postSlackResponseUrl(args.responseUrl, { text: line, blocks, replace_original: true })
  }
  try {
    if (args.op === "approve") {
      // Approving publishes a version; request-changes doesn't, so it stays free the
      // same way proposal CREATION does — only this branch is gated.
      const blocked = await deps.billingBlocked(artifact.org_id)
      if (blocked) {
        await eph(blocked.message)
        return
      }
      const version = await approveProposalAction(deps, artifact, proposal, who, null, link.user_id)
      await replaceCard(`:white_check_mark: Approved by ${display} — now v${version.n}`)
    } else {
      await requestChangesAction(deps, artifact, proposal, who, null, link.user_id)
      await replaceCard(`:leftwards_arrow_with_hook: Changes requested by ${display}`)
    }
  } catch {
    await eph("Sorry — that didn't go through. Try approving in Derive.")
  }
}
