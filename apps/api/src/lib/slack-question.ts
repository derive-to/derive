// The reply affordance for a pasted link to one exact Derive conversation. A channel has no
// canonical Slack thread for an arbitrary pasted URL, so the answer is collected in a modal and
// written to the known Derive thread. Mention DMs use a real Slack thread instead (slack-dm.ts).

import type { ArtifactRecord, CommentRecord } from "@derive/core"
import { commentDeepLink } from "./comments"
import { mrkdwnBody, mrkdwnLabel } from "./slack-cards"

export const SLACK_QUESTION_REPLY_ACTION = "derive_question_reply"
export const SLACK_QUESTION_REPLY_CALLBACK = "derive_question_reply"
export const SLACK_QUESTION_REPLY_BLOCK = "derive_question_reply_body"
export const SLACK_QUESTION_REPLY_INPUT = "derive_question_reply_input"

/** The stable target encoded in a public Block Kit action. It only names a thread; the route
 * re-resolves and authorizes it before opening a modal. */
export interface QuestionReplyTarget {
  artifactId: string
  threadId: string
}

/** One modal opening gets one submission id. Slack can retry an interaction after a lost
 * response, so the id becomes the durable origin marker that makes that retry a no-op. */
export interface QuestionReplyMeta extends QuestionReplyTarget {
  submissionId: string
}

export const encodeQuestionReply = (m: QuestionReplyTarget): string => JSON.stringify(m)
export const decodeQuestionReply = (value: string): QuestionReplyTarget | null => {
  try {
    const x = JSON.parse(value) as Partial<QuestionReplyMeta>
    return typeof x.artifactId === "string" &&
      x.artifactId &&
      typeof x.threadId === "string" &&
      x.threadId
      ? { artifactId: x.artifactId, threadId: x.threadId }
      : null
  } catch {
    return null
  }
}

export const questionUnfurlBlocks = (
  baseUrl: string,
  artifact: ArtifactRecord,
  root: CommentRecord,
): unknown[] => {
  const link = commentDeepLink(baseUrl, artifact, root.thread_id)
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:speech_balloon: *Question in <${link}|${mrkdwnLabel(artifact.title ?? artifact.short_id)}>*\n${mrkdwnBody(root.body_md, 700)}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SLACK_QUESTION_REPLY_ACTION,
          text: { type: "plain_text", text: "Reply" },
          value: encodeQuestionReply({ artifactId: artifact.id, threadId: root.thread_id }),
          style: "primary",
        },
        { type: "button", text: { type: "plain_text", text: "Open in Derive" }, url: link },
      ],
    },
    { type: "context", elements: [{ type: "mrkdwn", text: "Derive" }] },
  ]
}

export const questionReplyModal = (m: QuestionReplyMeta, title: string): unknown => ({
  type: "modal",
  callback_id: SLACK_QUESTION_REPLY_CALLBACK,
  private_metadata: JSON.stringify(m),
  title: { type: "plain_text", text: "Reply in Derive" },
  submit: { type: "plain_text", text: "Reply" },
  close: { type: "plain_text", text: "Cancel" },
  blocks: [
    {
      type: "input",
      block_id: SLACK_QUESTION_REPLY_BLOCK,
      label: { type: "plain_text", text: `Reply to ${title.slice(0, 65)}` },
      element: {
        type: "plain_text_input",
        action_id: SLACK_QUESTION_REPLY_INPUT,
        multiline: true,
        min_length: 1,
        max_length: 10_000,
        placeholder: { type: "plain_text", text: "Write a reply…" },
      },
    },
  ],
})

/** A modal is the only reliable acknowledgement surface for a Work Object action in a DM.
 * Keep access and account-link failures specific instead of making the button appear inert. */
export const questionReplyNoticeModal = (body: string): unknown => ({
  type: "modal",
  title: { type: "plain_text", text: "Reply in Derive" },
  close: { type: "plain_text", text: "Close" },
  blocks: [{ type: "section", text: { type: "mrkdwn", text: body } }],
})

export const questionReplyResultModal = (body: string): unknown => ({
  response_action: "update",
  view: {
    type: "modal",
    title: { type: "plain_text", text: "Reply in Derive" },
    close: { type: "plain_text", text: "Done" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: body } }],
  },
})
