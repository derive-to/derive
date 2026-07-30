// Rich previews for Derive links pasted into Slack (the `link_shared` → `chat.unfurl` path).
//
// The whole design turns on one property of Slack's API: an unfurl is attached to the MESSAGE,
// not to a viewer. `chat.unfurl` takes no `user` parameter, so whatever we render is seen by
// everyone in the channel. The question is therefore never "may this viewer read it" but "may
// this be broadcast" — which the connected app already answers everywhere else with
// `artifact.listed !== "none"`, and which we answer the same way here.
//
// The one per-person surface Slack does offer is the sign-in prompt, which goes to the person
// who POSTED the link. We use it for someone who hasn't linked their Derive account: without a
// link there is no principal to authorize, and it doubles as the first proactive prompt to link.

import {
  type ArtifactRecord,
  candidateShortIds,
  type MetaStore,
  type UnfurlInfo,
  unfurlDescription,
} from "@derive/core"
import { context, mrkdwnLabel, section } from "./slack-cards"
import { encodeProposalAction, SLACK_PROPOSAL_ACTION } from "./slack-comments"
import { unfurlInfoFor } from "./unfurl-info"

/** The card for an artifact the channel may see: title, one-line description, and — for an open
 *  proposal — the buttons to decide it.
 *
 *  Deliberately NO image, even though `UnfurlInfo` carries one and Derive's OG screenshot is the
 *  best-looking thing it has. Slack fetches an unfurl's image ANONYMOUSLY, and `/v1/og/:ref`
 *  answers an anonymous fetch by the artifact's link role: a workspace-listed artifact with no
 *  world link — the common shape for internal docs — returns the title-less LOCKED card. So the
 *  image would be a padlock placeholder on precisely the cards people paste most, next to a
 *  title we are already showing. A broken-looking card is worse than none. Revisit if the OG
 *  endpoint ever accepts a signed, short-lived token an unfurl could carry. */
export const unfurlBlocks = (
  info: UnfurlInfo,
  hasOpenProposal: boolean,
  artifactId: string,
  proposalId: string | null,
): unknown[] => {
  const blocks: unknown[] = [
    section(
      `*<${info.pageUrl}|${mrkdwnLabel(info.title)}>*\n${mrkdwnLabel(unfurlDescription(info), 120)}`,
    ),
  ]
  // An open proposal turns the preview into somewhere you can act, the way Linear's issue
  // unfurls do. The clicker is re-authorized as their own linked account by the interactivity
  // handler, so showing the buttons to a channel is safe — an unauthorized click gets an
  // ephemeral refusal, not an action.
  if (hasOpenProposal && proposalId) {
    const value = encodeProposalAction(artifactId, proposalId)
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SLACK_PROPOSAL_ACTION.approve,
          text: { type: "plain_text", text: "Approve" },
          value,
          style: "primary",
        },
        {
          type: "button",
          action_id: SLACK_PROPOSAL_ACTION.requestChanges,
          text: { type: "plain_text", text: "Request changes" },
          value,
        },
        { type: "button", text: { type: "plain_text", text: "Open in Derive" }, url: info.pageUrl },
      ],
    })
  }
  blocks.push(context("Derive"))
  return blocks
}

/** The card for an artifact the sharer can read but which is NOT feed-visible. Says nothing
 *  about it — no title, no counts — because everyone in the channel sees this, including people
 *  who cannot open it.
 *
 *  It links to the BARE short id, never `artifactUrl`. The canonical share URL is
 *  `<slugified-title>-<short_id>`, so linking to it would smuggle the title into the href of a
 *  card whose whole point is not to reveal one — recoverable by hover, copy-link, or reading the
 *  message back from the API. Worse for a stale link: the slug is re-derived on every rename, so
 *  a card for a link pasted as a bare id, or before a rename, would ADD a title the channel
 *  never had. The canonical redirect resolves the bare id for anyone who may actually open it. */
export const lockedUnfurlBlocks = (baseUrl: string, shortId: string): unknown[] => [
  section(
    `:lock: *<${baseUrl}/artifacts/${encodeURIComponent(shortId)}|A private Derive artifact>*\nOnly people it's shared with can open it.`,
  ),
  context("Derive"),
]

/** What the caller should do with one shared link. */
export type UnfurlDecision =
  | { kind: "skip" }
  | { kind: "auth" }
  | { kind: "card"; url: string; blocks: unknown[] }

export interface UnfurlDeps {
  meta: MetaStore
  baseUrl: string
  /** The Derive workspace whose Slack install we are unfurling into. An artifact belonging to a
   *  DIFFERENT workspace never renders here, even if the sharer personally has access to it —
   *  the broadcast rule is about this workspace's channel, not about their private reach. */
  orgId: string
  /** Authorize an EXPLICIT user for `read` on standing alone — never the world link. A link
   *  role is personal to whoever holds the URL; an unfurl is a broadcast, so it must not be
   *  what unlocks the preview. (context.ts authorizeUserStanding) */
  canRead: (userId: string, artifact: ArtifactRecord) => Promise<boolean>
}

/** Resolve one shared URL to a decision.
 *
 *  `viewerId` is the Derive user behind the Slack account that posted the link, or null when
 *  they haven't linked one. The ladder:
 *    no link            → prompt them to connect (the only per-person surface Slack gives us)
 *    not ours / gone    → skip, so a stray URL on our domain doesn't render an empty card
 *    another workspace  → skip (see UnfurlDeps.orgId)
 *    can't read it      → skip; they shouldn't confirm the existence of something they can't open
 *    listed === "none"  → locked card
 *    otherwise          → the full card
 */
export const decideUnfurl = async (
  deps: UnfurlDeps,
  url: string,
  viewerId: string | null,
): Promise<UnfurlDecision> => {
  if (!viewerId) return { kind: "auth" }
  const ref = artifactRefFromUrl(deps.baseUrl, url)
  if (!ref) return { kind: "skip" }
  let artifact: ArtifactRecord | null = null
  for (const id of candidateShortIds(ref)) {
    artifact = await deps.meta.getByShortId(id)
    if (artifact) break
  }
  if (!artifact || artifact.removed_at) return { kind: "skip" }
  if (artifact.org_id !== deps.orgId) return { kind: "skip" }
  if (!(await deps.canRead(viewerId, artifact))) return { kind: "skip" }

  // Build the locked card BEFORE unfurlInfoFor: it needs none of that, and the whole point is
  // to touch as little of the artifact as possible.
  if (artifact.listed === "none")
    return { kind: "card", url, blocks: lockedUnfurlBlocks(deps.baseUrl, artifact.short_id) }

  const info = await unfurlInfoFor(deps.meta, deps.baseUrl, artifact)
  const open = await deps.meta.listProposals(artifact.id, { state: "open" })
  return {
    kind: "card",
    url,
    blocks: unfurlBlocks(info, open.length > 0, artifact.id, open[0]?.id ?? null),
  }
}

/** The `:ref` of an artifact share URL on THIS instance, or null when the URL isn't one.
 *  Host-checked so a link to some other Derive instance (or a lookalike path on a domain we
 *  happen to have registered) never resolves against our own database. */
export const artifactRefFromUrl = (baseUrl: string, url: string): string | null => {
  let u: URL
  let base: URL
  try {
    u = new URL(url)
    base = new URL(baseUrl)
  } catch {
    return null
  }
  // Same host, or a subdomain of it — vanity subdomains serve the same artifacts.
  const sameHost = u.hostname === base.hostname || u.hostname.endsWith(`.${base.hostname}`)
  if (!sameHost) return null
  const raw = u.pathname.match(/^\/artifacts\/([^/]+)\/?$/)?.[1]
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    // A malformed escape (`%zz`) throws URIError. Outside a try that propagated all the way to
    // runAfterAck's blanket catch, so one such URL pasted alongside real ones silently killed
    // EVERY preview in the message. It simply isn't one of our refs.
    return null
  }
}
