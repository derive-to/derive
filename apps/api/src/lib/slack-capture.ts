// "Save to Derive": turn a Slack message into a comment on a Derive artifact.
//
// The fourth job a product integration does, after notify / act / preview. GitHub and Linear
// both spend it on "create an issue from this message"; Derive's equivalent is not a new
// artifact but a comment on an existing one, because that is where a decision made in Slack
// actually belongs — next to the paragraph it changes, in the thread the doc's readers already
// watch. A message saved as a fresh artifact would be a document nobody asked for.
//
// It is the same write the reply-back path performs (a comment authored by the linked Derive
// account, tagged with its Slack origin), reached from any message in any channel rather than
// only from a reply under a mirrored card. The origin tag also stops the mirror echoing it
// straight back out to the channels — it came from Slack.
//
// Authorization is the linked account's, resolved live: the picker only lists what that account
// can see, and the submission re-checks `comment` standing on the artifact it was given, because
// a modal's state is client-supplied and the seconds between opening and submitting are enough
// for access to change.

import { type ArtifactRecord, type MetaStore, newId } from "@derive/core"
import { mrkdwnLabel } from "./slack-cards"

/** The modal's callback_id, and the shortcut's. Slack routes a view_submission by the former. */
export const SLACK_CAPTURE_CALLBACK = "derive_capture"
/** The block + action ids the modal's artifact picker carries. `block_suggestion` echoes both
 *  back, and view_submission reads the chosen option out of `state.values[block][action]`. */
export const SLACK_CAPTURE_BLOCK = "derive_capture_artifact"
export const SLACK_CAPTURE_ACTION = "derive_capture_pick"
export const SLACK_CAPTURE_NOTE_BLOCK = "derive_capture_note_block"
export const SLACK_CAPTURE_NOTE_ACTION = "derive_capture_note"

/** What the shortcut carries through the modal and back, as the view's private_metadata.
 *  Round-tripping it beats re-deriving: `view_submission` arrives with no channel and no
 *  message, so without this there would be nothing left to quote. */
export interface CapturePrivateMeta {
  channel: string
  channelName: string | null
  ts: string
  /** The message's author, for attribution. A Slack display name, not a Derive one. */
  author: string
  text: string
  permalink: string | null
}

/** A modal asking which artifact to attach the message to.
 *
 *  The artifact picker is an `external_select`: Slack calls back with each keystroke, and the
 *  handler answers from the same workspace search the slash command uses. A static list would
 *  have to guess — a workspace with 400 artifacts has no useful 100-entry prefix — and Slack
 *  caps static options at 100 regardless. */
export const captureModal = (m: CapturePrivateMeta): unknown => ({
  type: "modal",
  callback_id: SLACK_CAPTURE_CALLBACK,
  private_metadata: JSON.stringify(m),
  title: { type: "plain_text", text: "Save to Derive" },
  submit: { type: "plain_text", text: "Save" },
  close: { type: "plain_text", text: "Cancel" },
  blocks: [
    {
      type: "section",
      // The message is untrusted text landing in a mrkdwn section, same as every card field.
      text: { type: "mrkdwn", text: `*${mrkdwnLabel(m.author)}*\n${mrkdwnLabel(m.text, 600)}` },
    },
    {
      type: "input",
      block_id: SLACK_CAPTURE_BLOCK,
      label: { type: "plain_text", text: "Comment on" },
      element: {
        type: "external_select",
        action_id: SLACK_CAPTURE_ACTION,
        placeholder: { type: "plain_text", text: "Search your workspace…" },
        min_query_length: 0,
      },
    },
    {
      type: "input",
      block_id: SLACK_CAPTURE_NOTE_BLOCK,
      optional: true,
      label: { type: "plain_text", text: "Add a note" },
      element: {
        type: "plain_text_input",
        action_id: SLACK_CAPTURE_NOTE_ACTION,
        multiline: true,
        placeholder: { type: "plain_text", text: "Why this matters (optional)" },
      },
    },
  ],
})

/** The modal shown instead when the clicker has no linked Derive account. A shortcut is often
 *  someone's FIRST contact with the app, so this is a prompt rather than an error. */
export const captureLinkPromptModal = (baseUrl: string): unknown => ({
  type: "modal",
  title: { type: "plain_text", text: "Save to Derive" },
  close: { type: "plain_text", text: "Close" },
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Connect your Derive account first, so the comment is saved as *you*.\n\n<${baseUrl}/settings/integrations|Connect Derive and Slack>`,
      },
    },
  ],
})

/** The terminal state of a submission, swapped in over the form. Slack replaces the modal when
 *  a view_submission answers with `response_action: "update"`, which keeps the whole flow in one
 *  surface — no ephemeral message, so no dependency on the bot being a member of the channel the
 *  shortcut was fired in. */
export const captureResultModal = (body: string): unknown => ({
  response_action: "update",
  view: {
    type: "modal",
    title: { type: "plain_text", text: "Save to Derive" },
    close: { type: "plain_text", text: "Done" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: body } }],
  },
})

/** The comment a captured message becomes.
 *
 *  Quotes the message rather than passing it off as the saver's own words, names who said it and
 *  where, and links back when a permalink was resolvable. `>` is mrkdwn's blockquote in Derive's
 *  markdown too, so the shape survives the round trip.
 *
 *  Every interpolated field is Slack-authored and lands in Derive markdown, but NOT in mrkdwn —
 *  escaping here would render literal `&amp;` in the app. The comment body is rendered by
 *  Derive's own sanitizer like any other comment; what this must not do is let the quote break
 *  OUT of its blockquote, hence the per-line prefix. */
export const captureCommentBody = (m: CapturePrivateMeta, note: string): string => {
  const where = m.channelName ? `#${m.channelName}` : "Slack"
  const quoted = m.text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n")
  const cite = m.permalink ? `[${m.author} in ${where}](${m.permalink})` : `${m.author} in ${where}`
  return [note.trim(), quoted, `— ${cite}`].filter(Boolean).join("\n\n")
}

/** Options for the artifact picker: the same visibility-scoped list the slash command answers
 *  with, shaped as Slack options. Slack caps an external_select response at 100. */
export const captureOptions = (
  artifacts: ArtifactRecord[],
): { options: Array<{ text: { type: "plain_text"; text: string }; value: string }> } => ({
  options: artifacts.slice(0, 100).map((a) => ({
    // plain_text is NOT mrkdwn — Slack renders it literally, so a title needs no escaping, only
    // truncating to the 75 chars an option label allows.
    text: { type: "plain_text" as const, text: (a.title ?? a.short_id).slice(0, 75) || a.short_id },
    value: a.id,
  })),
})

/** Write the captured comment. Returns the created comment, or null when the artifact is gone —
 *  the caller owns the authorization check and the fan-out. */
export const writeCaptureComment = async (
  meta: MetaStore,
  artifact: ArtifactRecord,
  m: CapturePrivateMeta,
  note: string,
  author: { id: string; name: string },
) => {
  const id = newId("c")
  return meta.createComment({
    id,
    artifact_id: artifact.id,
    // A capture opens its own thread — it is a new remark about the doc, not a reply to one.
    thread_id: id,
    base_version: artifact.current_version,
    path: null,
    anchor: null,
    body_md: captureCommentBody(m, note),
    author: author.name,
    author_id: author.id,
    // The Slack origin marker, exactly as an ingested reply carries it: it makes the mirror
    // skip this comment (enqueueSlackComment) so saving a message from #random doesn't post it
    // straight back into every subscribed channel, and it dedupes a double-submit on ts.
    meta: JSON.stringify({ slack: { ts: m.ts, channel: m.channel } }),
  })
}
