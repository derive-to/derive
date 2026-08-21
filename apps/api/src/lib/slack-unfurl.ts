// Rich previews for Derive links pasted into Slack (the `link_shared` → `chat.unfurl` path).
//
// The whole design turns on one property of Slack's API: an unfurl is attached to the MESSAGE,
// not to a viewer. `chat.unfurl` takes no `user` parameter, so whatever we render is seen by
// everyone in the channel. The question is therefore never "may this viewer read it" but "may
// this be broadcast" — and the field that answers it is ACCESS, not discovery: an artifact with
// `workspace_access === "member"` is readable by every member of the workspace this Slack team
// is connected to, so a channel in that workspace's own Slack is substantially its audience.
// That includes the default "team draft" (workspace_access=member, link_role=none, listed=none),
// which is the shape people paste most. `listed` is discovery-only and carries no access
// (schema.ts), so it gates nothing here beyond the one case access can't cover: a
// publicly-LISTED artifact is world-discoverable, so it broadcasts too. What stays locked is
// an artifact granting the workspace nothing — a link-only draft or a doc shared with named
// people — because every grant it has is personal to its holder, and a personal grant must
// never unlock a broadcast.
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
import { type ArtifactStatus, artifactStatus } from "./artifact-status"
import { context, mrkdwnLabel, section } from "./slack-cards"
import { unfurlInfoFor } from "./unfurl-info"

/** The card for an artifact the channel may see: title, one-line description, the screenshot
 *  when one is ready.
 *
 *  `imageUrl` is the caller's decision, not `info.imageUrl` verbatim: Slack fetches an unfurl's
 *  image ANONYMOUSLY, and `/v1/og/:ref` answers an anonymous fetch by the artifact's link role —
 *  for anything short of world-readable it returns the title-less LOCKED card, a padlock
 *  placeholder next to a title we are already showing. The caller therefore passes either a URL
 *  it KNOWS answers anonymously with the rendered PNG (a signed OG token for a workspace doc,
 *  the bare URL for a public one — see routes/slack.ts previewUrlFor), or null, and null means
 *  no image at all. A broken-looking card is worse than none. */
export const unfurlBlocks = (info: UnfurlInfo, imageUrl: string | null): unknown[] => {
  const blocks: unknown[] = [
    section(
      `*<${info.pageUrl}|${mrkdwnLabel(info.title)}>*\n${mrkdwnLabel(unfurlDescription(info), 120)}`,
    ),
  ]
  // alt_text is required on an image block, and it is plain text, not mrkdwn — no escaping.
  // Same phrasing as the Work Object thumbnail. The title is safe to use: only broadcast-safe
  // artifacts reach this builder at all.
  if (imageUrl)
    blocks.push({
      type: "image",
      image_url: imageUrl,
      alt_text: `Preview of ${info.title}`.slice(0, 200),
    })
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

/** What the caller should do with one shared link.
 *
 *  `card` and `locked` both carry the artifact so the caller can build a Work Object entity from
 *  it; `blocks` remains on both as the fallback for a workspace where Work Objects are not
 *  available (see lib/slack.ts unfurlSlackEntities, which throws on the warning that signals it).
 *
 *  `locked` is split out from `card` rather than folded into it because the two differ in what
 *  the FLEXPANE may then show. The broadcast half of a locked artifact must stay title-less, as
 *  before — but the flexpane is per-viewer, so a reader entitled to the artifact can be shown the
 *  real thing there. Keeping the distinction in the type is what lets the caller honour both. */
export type UnfurlDecision =
  /** Nothing to show, and WHICH rung decided that. The reason is not decoration: five different
   *  states all end here and look identical from the channel, and from outside the server they
   *  are indistinguishable — a workspace-listed artifact answers an anonymous probe exactly as a
   *  non-existent one does, so "I pasted a link and got no card" cannot be diagnosed by trying
   *  the URL. The caller logs this. */
  | { kind: "skip"; why: string }
  | { kind: "auth" }
  | {
      kind: "card"
      url: string
      blocks: unknown[]
      artifact: ArtifactRecord
      info: UnfurlInfo
      /** Resolved once here, carried so the Work Object builder doesn't re-read the same rows. */
      status: ArtifactStatus
      /** The image URL both card shapes share (block `image` and Work Object preview), or null
       *  when there is nothing safe to promise — see UnfurlDeps.previewUrl. */
      previewUrl: string | null
    }
  | { kind: "locked"; url: string; blocks: unknown[]; artifact: ArtifactRecord }

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
  /** The screenshot URL a card may promise for this artifact, or null for none. Must be a URL
   *  that answers an ANONYMOUS fetch with the rendered PNG — Slack fetches preview images with
   *  no credential — which for a workspace doc means a signed OG token (routes/slack.ts
   *  previewUrlFor, lib/og-token.ts). Absent means cards carry no image. */
  previewUrl?: (
    artifact: ArtifactRecord,
    info: UnfurlInfo,
    status: ArtifactStatus,
  ) => Promise<string | null>
}

/** Resolve one shared URL to a decision.
 *
 *  `viewerId` is the Derive user behind the Slack account that posted the link, or null when
 *  they haven't linked one. The ladder:
 *    no link            → prompt them to connect (the only per-person surface Slack gives us)
 *    not ours / gone    → skip, so a stray URL on our domain doesn't render an empty card
 *    another workspace  → skip (see UnfurlDeps.orgId)
 *    can't read it      → skip; they shouldn't confirm the existence of something they can't open
 *    grants the workspace nothing and is unlisted → locked card
 *    otherwise          → the full card (workspace-readable or listed; see the module header)
 */
export const decideUnfurl = async (
  deps: UnfurlDeps,
  url: string,
  viewerId: string | null,
): Promise<UnfurlDecision> => {
  if (!viewerId) return { kind: "auth" }
  const ref = artifactRefFromUrl(deps.baseUrl, url)
  if (!ref) return { kind: "skip", why: "url is not an artifact link on this instance" }
  let artifact: ArtifactRecord | null = null
  for (const id of candidateShortIds(ref)) {
    artifact = await deps.meta.getByShortId(id)
    if (artifact) break
  }
  if (!artifact) return { kind: "skip", why: "no artifact with that short id" }
  if (artifact.removed_at) return { kind: "skip", why: "artifact is removed" }
  // The likeliest cause of a silent miss in a team with more than one Derive workspace, and
  // the one hardest to guess at: the link works for the sharer and the channel shows nothing.
  if (artifact.org_id !== deps.orgId)
    return { kind: "skip", why: "artifact belongs to a different Derive workspace" }
  if (!(await deps.canRead(viewerId, artifact)))
    return { kind: "skip", why: "sharer has no read standing on it" }

  // Build the locked card BEFORE unfurlInfoFor: it needs none of that, and the whole point is
  // to touch as little of the artifact as possible. Locked means the workspace gets no access
  // AND it is unlisted — the module header carries the reasoning; a link role alone never
  // counts toward a broadcast.
  if (artifact.workspace_access === "none" && artifact.listed === "none")
    return {
      kind: "locked",
      url,
      blocks: lockedUnfurlBlocks(deps.baseUrl, artifact.short_id),
      artifact,
    }

  const info = await unfurlInfoFor(deps.meta, deps.baseUrl, artifact)
  const status = await artifactStatus(deps.meta, artifact)
  const previewUrl = (await deps.previewUrl?.(artifact, info, status)) ?? null
  return {
    kind: "card",
    url,
    blocks: unfurlBlocks(info, previewUrl),
    artifact,
    info,
    status,
    previewUrl,
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

/** Resolve the exact comment thread named by a Derive deep link. The artifact decision has
 * already proved workspace/read standing; this only ensures a forged `?comment=` cannot point
 * at a thread on some other document. */
export const questionThreadFromUrl = async (
  meta: MetaStore,
  artifact: ArtifactRecord,
  url: string,
): Promise<import("@derive/core").CommentRecord | null> => {
  try {
    const threadId = new URL(url).searchParams.get("comment")
    if (!threadId) return null
    const root = await meta.getComment(threadId)
    return root && root.artifact_id === artifact.id && root.thread_id === threadId ? root : null
  } catch {
    return null
  }
}
