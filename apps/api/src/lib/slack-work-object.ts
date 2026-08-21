// Derive artifacts as Slack Work Objects.
//
// Work Objects (GA October 2025) replace a block-rendered unfurl with a TYPED entity, and add a
// second surface. That second surface is why this exists at all. The header of slack-unfurl.ts
// records the constraint the old design was built around:
//
//   an unfurl is attached to the MESSAGE, not to a viewer. `chat.unfurl` takes no `user`
//   parameter, so whatever we render is seen by everyone in the channel.
//
// The flexpane — the panel Slack opens when someone clicks the card — carries the clicking
// `user`, and may demand auth or return a restricted view. It is the per-viewer surface that
// parameter never provided. So the broadcast card can stay minimal while each viewer who clicks
// sees exactly what they are entitled to, instead of everyone sharing the most cautious answer.
//
// Two further wins fall out of the typing. Slack renders `status`, `assignee` and dates itself,
// so none of them pass through mrkdwn escaping — the most bug-prone part of this integration
// (fenced language tags, `<!channel>`, entity handling) simply stops applying to those fields.
// And the entity is searchable in Slack, with the flexpane aggregating every conversation that
// referenced it, both keyed on `external_ref.id` — which is why that id must stay the artifact's
// stable short id and never a slug.

import type { ArtifactRecord, CommentRecord, UnfurlInfo } from "@derive/core"
import { unfurlDescription } from "@derive/core"
import { type ArtifactStatus, agoLabel, statusPhrase } from "./artifact-status"
import { commentDeepLink } from "./comments"
import { mrkdwnBody } from "./slack-cards"
import { encodeQuestionReply, SLACK_QUESTION_REPLY_ACTION } from "./slack-question"

/** The interactivity `action_id` a Work Object's button carries. Routed as an ordinary
 *  `block_action`, so it lands beside the thread handlers. */
export const SLACK_REVIEW_ACTION = {
  sendBack: "derive_review_send_back",
} as const

/** The artifact a review button targets, for the Block Kit surfaces.
 *
 *  A Work Object button needs none of this — Slack round-trips the entity and the handler reads
 *  `external_ref`. A button on a DM or a channel card has no entity behind it, so the target
 *  travels in `value`, exactly as the thread buttons already do. It only NAMES the
 *  artifact: runSlackReviewAction re-reads it and re-authorizes the clicker, so a forged value
 *  can at worst point at a doc they still cannot act on. */
export const encodeReviewAction = (artifactId: string): string => JSON.stringify({ a: artifactId })

export const decodeReviewAction = (value: string): string | null => {
  try {
    const { a } = JSON.parse(value) as { a?: string }
    return typeof a === "string" && a ? a : null
  } catch {
    return null
  }
}

/** `external_ref.type` — the namespace half of the key Slack stores. Stable forever: changing it
 *  orphans every previously-unfurled card from its related conversations and search entries. */
export const DERIVE_ENTITY_TYPE = "artifact"
/** A conversation, rather than the whole document.  It is intentionally a separate stable
 * namespace: a Slack DM about one question should aggregate its replies, not every discussion
 * that happens to reference the artifact. */
export const DERIVE_COMMENT_THREAD_ENTITY_TYPE = "comment_thread"

/** Work Object metadata for one open Derive conversation. Used on the first personal mention
 * DM and for a pasted deep link to an exact question. Subsequent activity is a normal Slack
 * thread reply, so recipients get one durable object rather than a fresh rich card per ping. */
export const commentThreadEntity = (args: {
  baseUrl: string
  artifact: Pick<ArtifactRecord, "id" | "short_id" | "title">
  comment: Pick<CommentRecord, "thread_id" | "body_md" | "author" | "state">
  /** Already rendered by the notification builder when its durable payload must not retain raw
   * user prose. `comment.body_md` remains the normal path for a live DB comment / unfurl. */
  bodyMrkdwn?: string
  iconUrl: string
  /** `chat.unfurl` must name the exact source URL. A DM's Work Object is already the source,
   * so it deliberately omits this field. */
  pastedUrl?: string
}): Record<string, unknown> => {
  const { artifact, comment } = args
  const link = commentDeepLink(args.baseUrl, artifact, comment.thread_id)
  return {
    ...(args.pastedUrl ? { app_unfurl_url: args.pastedUrl } : {}),
    url: link,
    external_ref: { id: comment.thread_id, type: DERIVE_COMMENT_THREAD_ENTITY_TYPE },
    entity_type: "slack#/entities/content_item",
    entity_payload: {
      actions: {
        primary_actions: [
          {
            text: "Reply",
            action_id: SLACK_QUESTION_REPLY_ACTION,
            // Work Object interactions usually round-trip `external_ref`, but value is a
            // documented action field and gives the reply path a safe fallback when Slack
            // omits entity context (for example from a future notification surface).
            value: encodeQuestionReply({ artifactId: artifact.id, threadId: comment.thread_id }),
            style: "primary",
          },
        ],
      },
      attributes: {
        title: { text: `${artifact.title ?? artifact.short_id} · Question` },
        display_type: "Derive question",
        product_name: "Derive",
        product_icon: { url: args.iconUrl, alt_text: "Derive" },
      },
      fields: {
        description: {
          value: args.bodyMrkdwn ?? mrkdwnBody(comment.body_md, 700),
          format: "markdown",
        },
      },
      custom_fields: [
        // The rich card is sent once, while Resolve/Reopen currently updates only mirrored
        // channel cards. Do not show a status that can become stale in a personal DM; the
        // exact Derive link remains the canonical live state.
        { key: "asked_by", label: "Asked by", value: comment.author, type: "string" },
      ],
    },
  }
}

/** The review state as a short label.
 *
 *  It rides `custom_fields`, not `fields`. `slack#/entities/content_item` accepts exactly five
 *  typed fields — description, created_by, last_modified_by, date_created, date_updated — and
 *  SILENTLY DROPS anything else with "The field X will be omitted due to an invalid type".
 *  `status` (with its colour tag) and `assignee` belong to `task` and `incident`. Measured
 *  against the live API, not inferred: sending all ten plausible names and reading back which
 *  survived is the only way to learn this, since the schema is not published per type.
 *
 *  A custom field loses the coloured tag a `task` status would render. That is the price of the
 *  type being honest — a Derive artifact is a document with review state, not a ticket — and the
 *  information itself is unchanged. */
const reviewLabel = (s: ArtifactStatus): string | null => {
  if (!s.review) return null
  return {
    pending: "Awaiting review",
    sent_back: "Answers sent back",
  }[s.review.state]
}

/** The review buttons.
 *
 *  Shared by the card and the flexpane ON PURPOSE. Opening a flexpane updates the unfurl from
 *  the metadata the app answers with — Slack's words: "the unfurl will also be updated given the
 *  entity metadata that has changed" — so a details payload that omitted these would silently
 *  STRIP Send back from a card that had it. The two surfaces have to agree on the
 *  actions for the same reason a PATCH has to send the fields it does not mean to clear. */
const reviewActions = (artifactId: string) => ({
  primary_actions: [
    {
      text: "Send back",
      action_id: SLACK_REVIEW_ACTION.sendBack,
      style: "primary",
      // Carried even though a Work Object click also echoes `external_ref`: one target
      // mechanism for all three surfaces is one thing to get right, and it means the handler
      // never depends on Slack round-tripping the entity to know what was clicked.
      value: encodeReviewAction(artifactId),
    },
  ],
})

export interface WorkObjectArgs {
  /** The URL exactly as pasted — Slack matches the unfurl back to the message by this, so it is
   *  NOT interchangeable with the canonical url below. */
  pastedUrl: string
  artifact: ArtifactRecord
  info: UnfurlInfo
  status: ArtifactStatus
  /** Only for a world-readable artifact. Slack fetches preview images ANONYMOUSLY, and /v1/og
   *  answers an anonymous fetch by link role — a workspace-only artifact would return the
   *  title-less padlock, so a card that people paste most would carry a padlock graphic. */
  previewUrl?: string | null
  /** Buttons ride the broadcast card, so they are offered only when a round is pending. A click
   *  is re-authorized as the clicker's own linked account, so showing them is safe. */
  withActions?: boolean
  /** Absolute icon URL. Slack requires `alt_text` alongside it; omitting that is a documented
   *  SILENT failure — the API answers 200 with a `warning` rather than an error. */
  iconUrl: string
}

/** The entity for one artifact, as `chat.unfurl`'s `metadata.entities[]` wants it. */
export const artifactEntity = (a: WorkObjectArgs): Record<string, unknown> => {
  const { artifact, info, status } = a
  // `fields` is REQUIRED — omitting it fails the whole payload with "missing required field:
  // fields", which surfaces as a format error that looks like a wrapper problem. Only the five
  // names content_item knows may go here; everything else belongs in custom_fields below.
  //
  // THE HEADLINE, and it deliberately REPEATS what the chips below say.
  //
  // I removed that repetition once, on the reasoning that `Review` and `Waiting on` already
  // carry it and a card has room for one rendering, not three. That was wrong, and the payload
  // it produced showed why: the description fell back to "Markdown · 3 versions · 7 comments ·
  // on Derive" — the inventory line this whole feature exists to stop leading with. It answers
  // "what is this?" when the question a shared link needs answered is "does this want something
  // from me?".
  //
  // The two slots are not peers. `description` is the prominent line; `custom_fields` are
  // secondary labelled pairs. They serve skimming and scanning respectively, so the same fact
  // in both is not waste — and de-duplicating cost the headline its meaning to buy tidiness
  // nobody asked for. (The duplication is not even removable in principle: `display_type`
  // repeats the kind, and `Version` repeats the version count, in the very same line.)
  const fields: Record<string, unknown> = {
    description: {
      value: statusPhrase(status)?.text
        ? `${statusPhrase(status)?.text}${status.review?.reviewerName ? ` — ${status.review.reviewerName}` : ""}`
        : unfurlDescription(info),
      // "markdown", never "plain_text": the latter is not in the enum and rejects the payload.
      format: "markdown",
    },
  }
  // The THUMBNAIL on the card itself — the picture people see without clicking, as distinct from
  // `full_size_preview`, which is the expanded view. `alt_text` is required: omitting it fails
  // the payload with a pointer straight at this field.
  //
  // Both surfaces take the same URL. It is one already-rendered, already-cached image, and
  // Slack scales it.
  if (a.previewUrl)
    fields.preview = {
      type: "slack#/types/image",
      alt_text: `Preview of ${info.title}`.slice(0, 200),
      image_url: a.previewUrl,
    }
  // A typed field Slack renders itself, and the question a document card most owes an answer to.
  if (status.lastModifiedBy)
    fields.last_modified_by = {
      type: "slack#/types/user",
      user: { text: status.lastModifiedBy },
    }
  if (status.updatedAt) {
    const ms = Date.parse(status.updatedAt)
    // A typed date, so Slack renders it in the reader's own locale and timezone.
    if (!Number.isNaN(ms)) fields.date_updated = { value: Math.floor(ms / 1000) }
  }

  const custom: Record<string, unknown>[] = []
  const label = reviewLabel(status)
  if (label) custom.push({ key: "review", label: "Review", value: label, type: "string" })
  if (status.review?.reviewerName)
    custom.push({
      key: "reviewer",
      label: "Waiting on",
      value: status.review.reviewerName,
      type: "string",
    })
  if (status.openThreads > 0)
    custom.push({
      key: "open_threads",
      label: "Open threads",
      value: status.openThreads,
      type: "integer",
    })
  custom.push({
    key: "version",
    label: "Version",
    value: `v${artifact.current_version}`,
    type: "string",
  })
  if (info.dataSummary)
    custom.push({ key: "data", label: "Data", value: info.dataSummary, type: "string" })

  const attributes: Record<string, unknown> = {
    title: { text: info.title },
    display_type: info.kindLabel,
    product_name: "Derive",
    // alt_text is REQUIRED. Its absence is the documented silent failure for this API.
    product_icon: { url: a.iconUrl, alt_text: "Derive" },
  }
  if (status.updatedAt) {
    const ms = Date.parse(status.updatedAt)
    if (!Number.isNaN(ms)) attributes.metadata_last_modified = Math.floor(ms / 1000)
  }
  if (a.previewUrl)
    attributes.full_size_preview = {
      is_supported: true,
      preview_url: a.previewUrl,
      mime_type: "image/png",
    }

  const payload: Record<string, unknown> = { attributes, fields, custom_fields: custom }
  if (a.withActions) payload.actions = reviewActions(artifact.id)

  return {
    app_unfurl_url: a.pastedUrl,
    url: info.pageUrl,
    external_ref: { id: artifact.short_id, type: DERIVE_ENTITY_TYPE },
    // `content_item` over `file`: an artifact is a living page with versions and review state,
    // not a static attachment. Slack's own examples put articles and pages here.
    entity_type: "slack#/entities/content_item",
    entity_payload: payload,
  }
}

/** The flexpane body — the per-viewer half, shown only to someone who passed the read check.
 *  Richer than the broadcast card precisely because it is not broadcast: the description, the
 *  open-thread count and the review state are safe here for a reader who could open the doc
 *  anyway. */
export const artifactDetails = (
  artifact: Pick<ArtifactRecord, "id" | "short_id">,
  info: UnfurlInfo,
  status: ArtifactStatus,
  viewerId: string | null,
  iconUrl: string,
  /** The screenshot, when this artifact may carry one at all. Per-viewer though this panel is,
   *  the IMAGE is still fetched anonymously by Slack and cached by its proxy — so the same line
   *  applies here as on the broadcast card, and a `listed: "none"` doc passes null. Being
   *  entitled to read something is not the same as consenting to a copy of it living in another
   *  company's cache. */
  previewUrl?: string | null,
): Record<string, unknown> => {
  const phrase = statusPhrase(status, viewerId)
  // Both surfaces lead with the status, but this sentence is not the card's: `statusPhrase`
  // takes the viewer here, so the panel says "Awaiting YOUR review" to the person actually being
  // waited on. No chip can say that — a chip is the same for everybody, and this surface is not.
  // It also keeps the description BELOW the status rather than replacing it, because a panel
  // opened deliberately has the room a broadcast card does not.
  const fields: Record<string, unknown> = {
    description: {
      value: phrase
        ? `*${phrase.text}${phrase.reviewerName ? ` ${phrase.reviewerName}` : ""}*\n${unfurlDescription(info)}`
        : unfurlDescription(info),
      format: "markdown",
    },
  }
  if (previewUrl)
    fields.preview = {
      type: "slack#/types/image",
      alt_text: `Preview of ${info.title}`.slice(0, 200),
      image_url: previewUrl,
    }
  if (status.lastModifiedBy)
    fields.last_modified_by = {
      type: "slack#/types/user",
      user: { text: status.lastModifiedBy },
    }
  const ago = agoLabel(status.updatedAt)
  return {
    // `url` and `external_ref` are REQUIRED here, not optional identity decoration:
    // entity.presentDetails answers `invalid_arguments` without them, with
    // "missing required field: external_ref [json-pointer:/metadata]". The flexpane has to say
    // WHICH entity it is describing — Slack does not infer it from the trigger — and the pair
    // must match the unfurl's exactly, since it is the key behind search and the Conversations
    // tab's aggregation.
    url: info.pageUrl,
    external_ref: { id: artifact.short_id, type: DERIVE_ENTITY_TYPE },
    entity_type: "slack#/entities/content_item",
    entity_payload: {
      // Mirrors the card's actions whenever a round is pending — see reviewActions.
      ...(status.review?.state === "pending" ? { actions: reviewActions(artifact.id) } : {}),
      attributes: {
        title: { text: info.title },
        display_type: info.kindLabel,
        product_name: "Derive",
        product_icon: { url: iconUrl, alt_text: "Derive" },
        ...(previewUrl
          ? {
              full_size_preview: {
                is_supported: true,
                preview_url: previewUrl,
                mime_type: "image/png",
              },
            }
          : {}),
      },
      fields,
      custom_fields: [
        ...(reviewLabel(status)
          ? [{ key: "review", label: "Review", value: reviewLabel(status), type: "string" }]
          : []),
        ...(status.openThreads > 0
          ? [
              {
                key: "open_threads",
                label: "Open threads",
                value: status.openThreads,
                type: "integer",
              },
            ]
          : []),
        ...(ago ? [{ key: "updated", label: "Updated", value: ago, type: "string" }] : []),
      ],
    },
  }
}
