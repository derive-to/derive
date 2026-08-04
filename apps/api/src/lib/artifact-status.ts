// What an artifact's card should LEAD with: is it waiting on someone, is there open
// feedback, and is it still current.
//
// Every peer integration answers "what is this thing?" — Linear's unfurl leads with status and
// assignee, GitHub's with title and description. Derive can answer something sharper, because a
// review round names the person it is blocked on: `getPendingRound` returns `requested_for`, and
// with agents as first-class authors the common shape is "an agent published this and nobody has
// looked yet". That is the fact worth the top line, not the file type.
//
// Returns STRUCTURED data, deliberately, not a rendered string. The Work Object maps it onto
// Slack's typed fields (which Slack renders itself, so it never passes through our mrkdwn
// escaping), while the Block Kit surfaces render and escape it their own way. One resolver, three
// presentations — the consistency rule GitLab's unfurl design settled on: notifications, slash
// commands and unfurls should describe a thing the same way.
//
// NOT folded into `UnfurlInfo`. That feeds /v1/og, the most-trafficked anonymous surface, and was
// deliberately collapsed into one round trip (`meta.unfurlInfo`); adding queries there would tax
// every crawler fetch to serve a panel only Slack shows. This resolves on the Slack path alone,
// which is also the only place the result is both authorized and actionable.

import type { ArtifactRecord, MetaStore, ReviewRoundState } from "@derive/core"

export interface ArtifactStatus {
  /** The pending round, when the artifact is waiting on a human. Null when nothing is pending —
   *  including after it settles, since a settled round is history rather than status. */
  review: {
    state: ReviewRoundState
    /** The person asked to answer. Compare against the viewer to say "your review". */
    reviewerId: string
    /** Their display name, or null when the directory has no row for them. Untrusted: escape at
     *  render on any surface that interpolates it into markup. */
    reviewerName: string | null
  } | null
  /** Distinct OPEN threads. More actionable than a total comment count: "7 comments" is inert,
   *  "2 open threads" is an invitation. */
  openThreads: number
  updatedAt: string | null
  /** Who published the current version, as a display name — the author string the version
   *  carries, which is a person for a hand publish and an agent's name for a generated one.
   *  Null when the artifact has no version row yet.
   *
   *  `content_item` has a TYPED `last_modified_by` field, so Slack renders this itself rather
   *  than us formatting a sentence. Verified against the API: the shape takes a display name
   *  only — a slack_user_id, an avatar url, or either alongside the name are all rejected with
   *  "failed to match exactly one allowed schema" — so there is no @-link or avatar to be had. */
  lastModifiedBy: string | null
}

export const artifactStatus = async (
  meta: MetaStore,
  artifact: ArtifactRecord,
): Promise<ArtifactStatus> => {
  // Any pending round, not one scoped to a viewer: the card is answering "is this blocked", and
  // on a single-reviewer round the asker is whoever was named. routes/review.ts resolves it the
  // same way when no specific person is in hand.
  const round = await meta.getPendingRound(artifact.id)
  const signals = await meta.commentSignals([artifact.id], null)
  const [reviewer] = round ? await meta.getUsers([round.requested_for]) : []
  const current = await meta.getVersion(artifact.id, artifact.current_version)
  return {
    review: round
      ? {
          state: round.state,
          reviewerId: round.requested_for,
          reviewerName: reviewer?.name ?? reviewer?.username ?? null,
        }
      : null,
    openThreads: signals[artifact.id]?.open_threads ?? 0,
    updatedAt: artifact.updated_at,
    lastModifiedBy: current?.author ?? null,
  }
}

/** How long ago, in the coarse terms a card wants. Exact timestamps are noise when the question
 *  is only "is this still current" — a doc touched an hour ago and one touched in February are
 *  different in kind, and the reader does not need the minute. */
export const agoLabel = (iso: string | null, now = Date.now()): string | null => {
  if (!iso) return null
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return null
  const mins = Math.floor((now - then) / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`
}

/** The status as a short human phrase, for the surfaces that render text rather than typed
 *  fields. `viewerId` is what turns "Awaiting review from Mert" into "Awaiting your review" —
 *  the difference between information and a prompt. Null when there is nothing worth leading
 *  with, so callers fall back to the existing description. */
export const statusPhrase = (
  s: ArtifactStatus,
  viewerId?: string | null,
): { text: string; reviewerName: string | null } | null => {
  if (!s.review) return null
  const mine = !!viewerId && viewerId === s.review.reviewerId
  if (s.review.state === "pending")
    return mine
      ? { text: "Awaiting your review", reviewerName: null }
      : { text: "Awaiting review from", reviewerName: s.review.reviewerName }
  if (s.review.state === "sent_back") return { text: "Answers sent back", reviewerName: null }
  return { text: "Approved", reviewerName: null }
}
