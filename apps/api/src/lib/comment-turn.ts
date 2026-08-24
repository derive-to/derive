// @derive IN A COMMENT — the third arrival on the same turn.
//
// A comment thread is where questions about a document already live, so this lane adds no new
// place to ask: someone @mentions Derive in a thread, and the answer lands in that thread as a
// reply. What it is NOT is a new conversation surface — there is no session, because the THREAD
// is the transcript and the record.
//
// The document is the ground (the same `documentContract` the rail's chat uses), the thread is
// the conversation, and the settle is a comment. This lane NEVER writes the document — a
// drafted change becomes part of the reply — so there is no landing decision to make here.
// Everything else — the model call, the tool loop, the nudge — is turn-core's, exactly as it
// is for every other lane.

import {
  type ArtifactRecord,
  type BlobStore,
  type CommentRecord,
  MAX_ARTIFACT_CHARS,
  type MetaStore,
  NUDGE_LIMIT,
  newId,
  type Revision,
  toMicroUsd,
} from "@derive/core"
import type { Backplane } from "../bus"
import { log } from "../log"
import type { AgentLoopInput } from "./agent-loop"
import { liveChatArrival } from "./chat-gate"
import { type CommentActionDeps, commentCreatedAction } from "./comment-actions"
import { DERIVE_AUTHOR_ID, quoteOf } from "./comments"
import type { ResolvedChatModel } from "./model-catalog"
import type { ModelSource } from "./model-library"
import {
  asTurns,
  documentBlock,
  documentContract,
  documentName,
  runTurn,
  suggestionText,
} from "./turn-core"

/** Exactly what this lane needs: the comment fan-out's deps (its settle IS a comment) plus a
 *  model. Deliberately NOT AfterPublishDeps — this turn never publishes, so it never reaches
 *  the post-publish path, and claiming those deps would be a lie about what it does. */
export interface CommentTurnDeps extends CommentActionDeps {
  blobs: BlobStore
  model: ResolvedChatModel
}

export interface CommentTurnInput {
  artifact: ArtifactRecord
  /** The comment that mentioned Derive. */
  comment: CommentRecord
  /** The whole thread, oldest first, INCLUDING the mention. */
  thread: CommentRecord[]
  /** The human who mentioned Derive: the turn acts for them and writes are attributed to them. */
  asker: { id: string; name: string }
}

/** A drafted revision, surfaced as the thread reply. */
const suggestionComment = (revision: Revision): string =>
  suggestionText(revision, {
    lead: "Here is the change I suggest:",
    tooBig:
      "The change I drafted is too large to paste into this thread. Open the document's chat rail and ask there, and I can apply it.",
  })

/**
 * Serve one comment mention. Never throws: this runs detached from the request that created the
 * comment, and a failure has to land where the person is looking (the thread) rather than
 * nowhere.
 */
export const runCommentTurn = async (
  deps: CommentTurnDeps,
  input: CommentTurnInput,
): Promise<void> => {
  const { meta, blobs } = deps
  const { artifact, comment, thread, asker } = input

  const reply = async (body: string) => {
    // This is a model protocol, not a heuristic: a normal question mark must never turn every
    // later thread reply into an expensive model call. The marker is stripped before anyone sees
    // the comment, leaving a natural question in the thread.
    const awaiting = /^\[awaiting-input\]\s*/i.test(body)
    const visible = awaiting ? body.replace(/^\[awaiting-input\]\s*/i, "") : body
    const created = await meta.createComment({
      id: newId("c"),
      artifact_id: artifact.id,
      thread_id: comment.thread_id,
      base_version: artifact.current_version,
      path: comment.path,
      // The REPLY carries no anchor of its own: it belongs to the thread, and a second
      // highlight over the same span would double-underline the document.
      anchor: null,
      body_md: visible,
      author: "Derive",
      author_id: DERIVE_AUTHOR_ID,
      ...(awaiting ? { meta: JSON.stringify({ awaiting_reply: true }) } : {}),
    })
    // The SAME fan-out any other comment runs — which is what puts this answer in the Slack
    // channel, the bells and the webhooks for free. Recursion is not a risk:
    // this comment mentions nobody, and the branch that calls us skips a Derive-authored one.
    await commentCreatedAction(deps, artifact, created, {
      mentions: [],
      actorId: DERIVE_AUTHOR_ID,
      onBehalfOf: asker.id,
    })
  }

  const version = await meta.getVersion(artifact.id, artifact.current_version)
  const bytes = version ? await blobs.get(version.blob_key) : null
  if (!bytes) {
    await reply("I could not read this document's current contents, so I have not answered.")
    return
  }
  const source = new TextDecoder().decode(bytes).slice(0, MAX_ARTIFACT_CHARS)

  const names = new Map<string, string>()
  const humanIds = [...new Set(thread.map((c) => c.author_id).filter((id): id is string => !!id))]
  for (const u of await meta.getUsers(humanIds).catch(() => []))
    names.set(u.id, u.name ?? "someone")

  const contract = documentContract(source, true)
  const quote = quoteOf(comment.anchor)
  const system = `You are Derive, answering an @mention in a comment thread on a document.

${quote ? `This thread is anchored to a quoted span of the document:\n"""\n${quote}\n"""\n` : ""}
Answer the question asked, in the thread, in prose. Be brief — this is a comment, not a report,
and the people reading it are looking at the document already. If the thread asks you to CHANGE
the document, reply with the revision block described below; it will be posted into this thread
as a suggested change for a person to apply — the document itself is not edited from a comment.

If you need a human answer before you can continue, begin the reply with the exact marker
"[awaiting-input]" followed by your single, concrete question. Use that marker only when you
are actually blocked on their answer; do not use it for rhetorical questions or ordinary advice.

${contract.text}

${documentBlock(source, documentName(artifact.short_id, artifact.current_content_type))}`

  const out = await runTurn({
    system,
    messages: asTurns(thread, (c) => ({
      fromAgent: c.author_id === DERIVE_AUTHOR_ID,
      body: c.body_md,
      // A thread can have several people in it, so every human turn is attributed. Without this
      // the model reads five voices as one and answers the wrong person.
      speaker: names.get(c.author_id ?? "") ?? c.author,
    })),
    contract,
    callModel: deps.model.callModel as AgentLoopInput["callModel"],
    // No tools on this lane yet: the document IS the ground, and the thread is about it.
    maxTurns: NUDGE_LIMIT + 1,
    // A COMMENT MENTION NEVER WRITES THE DOCUMENT, whatever the model drafted: the person
    // asked a question in a thread, and a document that rewrote itself out of a conversation
    // nobody was watching for a write is the surprise this lane must never produce. The
    // drafted change becomes the thread reply (posted by the shared `reply` below) instead —
    // this landing IS the lane's settle.
    land: async (revision: Revision) => ({
      outcome: "commented",
      wrote: null,
      note: suggestionComment(revision),
    }),
  })

  if (out.failure) {
    log.warn("comment turn produced nothing", {
      artifact: artifact.id,
      thread: comment.thread_id,
      reason: out.failure.reason,
      error: out.failure.error,
    })
    await reply(
      out.failure.reply ??
        (out.failure.reason === "model"
          ? "I could not reach the model just now — mention me again and I will retry."
          : "I could not answer that, and I have not changed anything."),
    )
    return
  }
  log.info("comment_turn", {
    artifact: artifact.id,
    org: artifact.org_id,
    outcome: out.outcome,
    cost_micro_usd: toMicroUsd(out.costUsd),
    model: deps.model.id,
  })
  await reply(out.reply || "(no reply)")
}

/**
 * THE COMMENT LANE'S ARRIVAL: every gate a chat arrival walks, then the turn.
 *
 * The gates are the same five the HTTP lanes walk (see `chatGates` in routes/contexts.ts), in
 * the same order and for the same reasons — a mention is a way to spend the operator's model
 * key, and a lane that inherited four of the five would be the whole point of collecting them.
 * They are re-stated rather than shared because this arrival has no Hono context: there is no
 * request to refuse, so a refusal here is SILENCE (logged), not a status code.
 */
export const answerDeriveMention =
  (deps: {
    meta: MetaStore
    blobs: BlobStore
    bus: Backplane
    baseUrl: string
    /** Read PER TURN (lib/model-library.ts), not held. This lane is constructed once at boot,
     *  so a held catalog would answer with the model the process started with — which is the
     *  exact failure the live library exists to prevent. */
    models: ModelSource
    notify: CommentActionDeps["notify"]
    /** The operator allowlist, when the deploy pays. Same meaning as DERIVE_CHAT_ALLOWLIST. */
    chatAllowlist?: string[]
    pokeWebhooks?: () => void
  }) =>
  async (
    artifact: ArtifactRecord,
    comment: CommentRecord,
    asker: { id: string; name: string } | null,
  ): Promise<void> => {
    const { meta } = deps
    const quiet = (why: string) =>
      log.info("derive mention not answered", { artifact: artifact.id, comment: comment.id, why })

    // An anonymous or agent author has no seat to act through, and this lane acts AS the asker.
    if (!asker) return quiet("no human asker")

    // EVERY RUNG, ONCE (lib/chat-gate.ts). No rate key: this arrival rides the comment route's
    // own limiter, so a second one here would charge the same person twice for one action.
    const gate = await liveChatArrival(
      {
        meta,
        models: deps.models,
        chatAllowlist: deps.chatAllowlist,
      },
      { org: artifact.org_id, userId: asker.id },
    )
    // Silence (logged), not a message: unlike Slack, nobody is waiting on a reply that never
    // existed — the comment they wrote posted fine.
    if (!gate.ok) return quiet(gate.reason)
    const { model } = gate

    // The whole thread, oldest first — the conversation this answer joins.
    const thread = await meta
      .listComments(artifact.id, { threadId: comment.thread_id })
      .catch(() => [comment])

    await runCommentTurn(
      {
        meta,
        blobs: deps.blobs,
        bus: deps.bus,
        baseUrl: deps.baseUrl,
        notify: deps.notify,
        pokeWebhooks: deps.pokeWebhooks,
        model,
      },
      {
        artifact,
        comment,
        thread: thread.length ? thread : [comment],
        asker,
      },
    )
  }
