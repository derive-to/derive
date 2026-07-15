/**
 * Brandprint resolution. A workspace and a profile each declare how they like their
 * stuff built — a conventions collection (docs/skills agents read); the workspace layer
 * additionally carries the generated brand profile. When an agent acts as a user in a
 * workspace, the two layers merge: workspace is the base, the user's profile refines it
 * (profile wins at doc level). Pure (no I/O) so it's unit-tested; the caller loads the
 * actual collection artifacts.
 */
import type { Brandprint } from "./ports"

export interface ResolvedBrandprint {
  /** Conventions collection ids to pull docs from, in precedence order, deduped
   *  (workspace first, the profile's appended). */
  collectionIds: string[]
  /** The workspace's brand-profile artifact short_id, when set. The profile is a
   *  team property, so a personal layer never contributes one. */
  profileId?: string
}

/** Resolve the workspace + profile Brandprint into the collections to read and the
 *  workspace's brand-profile pointer. */
export const resolveBrandprint = (ws?: Brandprint, profile?: Brandprint): ResolvedBrandprint => {
  const ids = [ws?.collectionId, profile?.collectionId].filter((id): id is string => !!id)
  return { collectionIds: [...new Set(ids)], profileId: ws?.profileId }
}

/** The brand profile is live once it has a real version — version 1 is always the
 *  intake's stub. The rule's one home on the server; the web mirrors it (the SPA
 *  doesn't import @derive/core). */
export const profileState = (currentVersion: number): "pending" | "live" =>
  currentVersion >= 2 ? "live" : "pending"

/** Parse a profile's stored Brandprint JSON string; null / malformed → undefined. */
export const parseBrandprint = (json: string | null | undefined): Brandprint | undefined => {
  if (!json) return undefined
  try {
    const v = JSON.parse(json) as unknown
    return v && typeof v === "object" ? (v as Brandprint) : undefined
  } catch {
    return undefined
  }
}

/** The steps that build the profile, stated once: both the MCP nudge (when a human asks)
 *  and the canned build request the generate button fires say the same thing, so they
 *  can't drift into two different definitions of the job. */
const profileBuildSteps = (profileShortId: string): string =>
  `read derive://brandprint/reference and derive://brandprint/template plus the source docs` +
  ` (the other derive://brandprint/* resources), then publish the profile with` +
  ` for_review: true to artifact ${profileShortId}`

/**
 * The pointer appended to the MCP server `instructions`. Progressive disclosure: the
 * agent reads the full docs from the resources. Three states:
 * - live profile: the profile is the headline read, sources back it.
 * - pending profile: the sources line plus a factual note conditioned on the user
 *   asking, so no unrelated session gets pitched (spec: "No solicitation, ever").
 * - no profile: the sources line alone (the pre-Phase-2 behavior).
 */
export const brandprintInstructions = (
  docCount: number,
  profile?: { state: "pending" | "live"; shortId: string },
): string => {
  if (profile?.state === "live")
    return (
      ` This workspace has a Brandprint profile: read derive://brandprint/profile before` +
      ` authoring; your personal Brandprint takes precedence.` +
      (docCount > 0
        ? ` ${docCount} source doc${docCount === 1 ? "" : "s"} back it (derive://brandprint/*).`
        : "")
    )
  const docs =
    docCount > 0
      ? ` This workspace has a Brandprint: ${docCount} convention ${docCount === 1 ? "doc" : "docs"} on how to build things here. Read the derive://brandprint/* resources before authoring; your personal Brandprint takes precedence.`
      : ""
  if (profile?.state === "pending")
    return (
      docs +
      ` Its brand profile has not been generated yet. If the user asks to build or finish` +
      ` their Brandprint, ${profileBuildSteps(profile.shortId)}.`
    )
  return docs
}

/**
 * The canned Rework instruction — kept server-side as the single source of truth
 * (the client fires the endpoint; it never carries the prompt). With a live brand
 * profile, the profile is named as the first read.
 */
export const reworkInstruction = (profileLive: boolean): string =>
  (profileLive
    ? "Rework this artifact to match our Brandprint. Read derive://brandprint/profile first, then the rest of the derive://brandprint/* resources, "
    : "Rework this artifact to match our Brandprint. Read the derive://brandprint/* resources first, ") +
  "then revise the whole document so its voice, structure, and formatting match. " +
  "Preserve the meaning and the facts; change how it reads, not what it says. " +
  "Publish the result as a new version."

/**
 * The canned build-the-profile instruction the generate button hands an agent —
 * server-side single source of truth, the inbox-delivered sibling of the copyable
 * hand-off brief (which keeps its "connect over MCP" first step; an agent reading its
 * inbox is already connected). Unlike the MCP nudge, this one was asked for, so it
 * instructs rather than offers.
 */
export const buildProfileInstruction = (profileShortId: string): string =>
  `Build this workspace's brand profile: ${profileBuildSteps(profileShortId)}.` +
  " Build it as ONE self-contained HTML file following the reference. It must land as a" +
  " proposal a human approves; never publish it live."

/** How many inbox rows a request-queue read pulls at a time. The queue is a working
 *  set, not an archive — an agent that lets it grow past this has stopped acking. */
export const AGENT_INBOX_PAGE = 50

/**
 * The pointer appended to an agent connection's MCP `instructions` when work is
 * waiting. The inbox is a PULL queue: a connected session may be the only runtime
 * that ever reads it, so the queue goes in front of the agent at connect rather than
 * waiting to be asked for.
 */
export const pendingRequestsPointer = (count: number): string =>
  count === 0
    ? ""
    : ` You have ${count} pending request${count === 1 ? "" : "s"}: teammates @mentioned you` +
      ` with work to do. Call check_requests FIRST — read each request, do what it asks on the` +
      ` named artifact, then pass the handled ids back via check_requests({ack:[…]}) so they` +
      ` leave the queue.`
