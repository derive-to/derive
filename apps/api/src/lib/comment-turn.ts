// @derive IN A COMMENT.
//
// A comment thread is where questions about a document already live, so this lane adds no new
// place to ask: someone @mentions Derive in a thread, and the answer lands in that thread as a
// reply. What it is NOT is a new conversation surface — there is no session, because the THREAD
// is the transcript and the record.
//
// The document is the ground (`documentContract`), the thread is the conversation, and the
// settle is a comment. This lane NEVER writes the document — a
// drafted change becomes part of the reply — so there is no landing decision to make here.
// Everything else — the model call, the tool loop, the nudge — is turn-core's, exactly as it
// is for every other lane.

import {
  type ArtifactRecord,
  type BlobStore,
  type CommentRecord,
  DERIVE_AGENT_ID,
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
  TURN_TOO_LONG,
} from "./turn-core"

/** Exactly what this lane needs: the comment fan-out's deps (its settle IS a comment) plus a
 *  model. Deliberately NOT AfterPublishDeps — this turn never publishes, so it never reaches
 *  the post-publish path, and claiming those deps would be a lie about what it does. */
export interface CommentTurnDeps extends CommentActionDeps {
  blobs: BlobStore
  model: ResolvedChatModel
  /** How long the turn may take before it gives up and says so in the thread
   *  (attendedTurnBudgetMs). This lane runs after the response, and on Workers that work is
   *  cut off about 30s later with nothing written; giving up first keeps a reply in the
   *  thread. Absent = no limit. */
  budgetMs?: number
}

/** What a comment turn spent and how it ended, for the job that carries its cost. */
export interface CommentTurnResult {
  outcome: "answered" | "failed"
  costMicroUsd: number | null
  /** What was posted in the thread. */
  reply: string
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
      "The change I drafted is too large to paste into this thread. Ask me for a smaller part of it, or ask an agent to make the change.",
  })

/**
 * Serve one comment mention. Never throws: this runs detached from the request that created the
 * comment, and a failure has to land where the person is looking (the thread) rather than
 * nowhere.
 */
export const runCommentTurn = async (
  deps: CommentTurnDeps,
  input: CommentTurnInput,
): Promise<CommentTurnResult> => {
  const { meta, blobs } = deps
  const { artifact, comment, thread, asker } = input

  const reply = async (body: string): Promise<string> => {
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
    // Signal-only, like the comment route's own: open pages refetch and the answer appears
    // in the thread without a reload. This runs after that route's response, so its signal
    // went out before this reply existed.
    deps.bus.publish(artifact.id, { type: "comment.created" })
    // The SAME fan-out any other comment runs — which is what puts this answer in the Slack
    // channel, the bells and the webhooks for free. Recursion is not a risk:
    // this comment mentions nobody, and the branch that calls us skips a Derive-authored one.
    await commentCreatedAction(deps, artifact, created, {
      mentions: [],
      actorId: DERIVE_AUTHOR_ID,
      onBehalfOf: asker.id,
    })
    return visible
  }

  const version = await meta.getVersion(artifact.id, artifact.current_version)
  const bytes = version ? await blobs.get(version.blob_key) : null
  if (!bytes) {
    const said = await reply(
      "I could not read this document's current contents, so I have not answered.",
    )
    return { outcome: "failed", costMicroUsd: null, reply: said }
  }
  const source = new TextDecoder().decode(bytes).slice(0, MAX_ARTIFACT_CHARS)

  const names = new Map<string, string>()
  const humanIds = [...new Set(thread.map((c) => c.author_id).filter((id): id is string => !!id))]
  for (const u of await meta.getUsers(humanIds).catch(() => []))
    names.set(u.id, u.name ?? "someone")

  const contract = documentContract(source)
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

  // The budget: what the calls that came back cost is charged either way, and once time is
  // up the abandoned turn may not call the model again.
  let spentUsd = 0
  let expired = false
  const callModel = deps.model.callModel as AgentLoopInput["callModel"]
  const turn = runTurn({
    system,
    messages: asTurns(thread, (c) => ({
      fromAgent: c.author_id === DERIVE_AUTHOR_ID,
      body: c.body_md,
      // A thread can have several people in it, so every human turn is attributed. Without this
      // the model reads five voices as one and answers the wrong person.
      speaker: names.get(c.author_id ?? "") ?? c.author,
    })),
    contract,
    callModel: async (call) => {
      if (expired) throw new Error("turn budget spent")
      const res = await callModel(call)
      spentUsd += res.costUsd ?? 0
      return res
    },
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

  let timer: ReturnType<typeof setTimeout> | undefined
  const out = deps.budgetMs
    ? await Promise.race([
        turn,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), deps.budgetMs)
        }),
      ]).finally(() => clearTimeout(timer))
    : await turn
  if (!out) {
    expired = true
    turn.catch(() => {})
    log.warn("comment turn ran out of time", { artifact: artifact.id, thread: comment.thread_id })
    return {
      outcome: "failed",
      costMicroUsd: toMicroUsd(spentUsd),
      reply: await reply(TURN_TOO_LONG),
    }
  }

  if (out.failure) {
    log.warn("comment turn produced nothing", {
      artifact: artifact.id,
      thread: comment.thread_id,
      reason: out.failure.reason,
      error: out.failure.error,
    })
    const said = await reply(
      out.failure.reply ??
        (out.failure.reason === "model"
          ? "I could not reach the model just now — mention me again and I will retry."
          : "I could not answer that, and I have not changed anything."),
    )
    return { outcome: "failed", costMicroUsd: toMicroUsd(out.costUsd), reply: said }
  }
  log.info("comment_turn", {
    artifact: artifact.id,
    org: artifact.org_id,
    outcome: out.outcome,
    cost_micro_usd: toMicroUsd(out.costUsd),
    model: deps.model.id,
  })
  const said = await reply(out.reply || "(no reply)")
  return { outcome: "answered", costMicroUsd: toMicroUsd(out.costUsd), reply: said }
}

/**
 * THE COMMENT LANE'S ARRIVAL: every gate a chat arrival walks, then the turn.
 *
 * The gates are lib/chat-gate.ts's, the same ones the Slack lane walks: a mention is a way to
 * spend the operator's model key. This arrival has no Hono context, so there is no request to
 * refuse, and a refusal here is SILENCE (logged), not a status code.
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
    /** The page ask's limiter, keyed the way that route keys a signed-in person, so asking
     *  Derive in a comment and in the Ask panel draw on one rate. Absent = no limit. */
    askLimiter?: ((key: string) => Promise<{ ok: boolean; retryAfter?: number }>) | null
    /** The turn's time budget (attendedTurnBudgetMs). */
    budgetMs?: number
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

    // EVERY RUNG, ONCE (lib/chat-gate.ts). The comment route's limiter counted the comment;
    // this one counts the model turn, on the same key a page ask uses, because a mention
    // spends what an ask spends.
    const gate = await liveChatArrival(
      {
        meta,
        models: deps.models,
        chatAllowlist: deps.chatAllowlist,
        askLimiter: deps.askLimiter,
      },
      { org: artifact.org_id, userId: asker.id, rateKey: `id:${asker.id}` },
    )
    // Silence (logged), not a message: unlike Slack, nobody is waiting on a reply that never
    // existed — the comment they wrote posted fine.
    if (!gate.ok) return quiet(gate.reason)
    const { model } = gate

    // The whole thread, oldest first — the conversation this answer joins.
    const thread = await meta
      .listComments(artifact.id, { threadId: comment.thread_id })
      .catch(() => [comment])

    // THE LEDGER. The monthly budget is read from job costs, so a turn with no job would
    // spend without counting. One attended job per mention on the built-in Derive, private to
    // its asker like every other Derive job. No subject: the thread is the conversation, and
    // a page subject would make it a page ask that the Ask panel continues.
    const job = await meta
      .createJob({
        id: newId("job"),
        org_id: artifact.org_id,
        agent_id: DERIVE_AGENT_ID,
        kind: "ask",
        instruction: comment.body_md,
        asked_by: asker.id,
        payer_id: asker.id,
        attended: 1,
        subject_json: null,
        meta_json: JSON.stringify({
          via: "comment",
          artifact: artifact.short_id,
          thread: comment.thread_id,
        }),
      })
      .catch((e) => {
        log.warn("derive mention job not opened", { comment: comment.id, error: String(e) })
        return null
      })
    if (!job) return quiet("job not opened")
    const startedAt = new Date().toISOString()
    await meta
      .addJobMessage({
        id: newId("jm"),
        job_id: job.id,
        author_kind: "asker",
        author_id: asker.id,
        body_md: comment.body_md,
      })
      .catch(() => null)
    await meta
      .updateJob(job.id, {
        status: "running",
        started_at: startedAt,
        // Past the budget where there is one, so only a turn whose isolate died lapses.
        lease_until: new Date(
          Date.now() + (deps.budgetMs ? 2 * 60_000 : 10 * 60_000),
        ).toISOString(),
      })
      .catch(() => null)

    const result = await runCommentTurn(
      {
        meta,
        blobs: deps.blobs,
        bus: deps.bus,
        baseUrl: deps.baseUrl,
        notify: deps.notify,
        pokeWebhooks: deps.pokeWebhooks,
        model,
        budgetMs: deps.budgetMs,
      },
      {
        artifact,
        comment,
        thread: thread.length ? thread : [comment],
        asker,
      },
    ).catch((e) => {
      log.error("comment turn failed", { comment: comment.id, error: String(e) })
      return null
    })
    // Settle best effort: the reply in the thread matters more than the row.
    if (result?.costMicroUsd) await meta.addJobCost(job.id, result.costMicroUsd).catch(() => null)
    if (result)
      await meta
        .addJobMessage({
          id: newId("jm"),
          job_id: job.id,
          author_kind: "agent",
          author_id: DERIVE_AGENT_ID,
          body_md: result.reply,
          meta_json: JSON.stringify({ via: "comment", outcome: result.outcome }),
        })
        .catch(() => null)
    await meta
      .updateJob(
        job.id,
        {
          status: result?.outcome === "answered" ? "succeeded" : "failed",
          finished_at: new Date().toISOString(),
          lease_until: null,
        },
        { status: "running", started_at: startedAt },
      )
      .catch((e) => log.warn("derive mention job settle failed", { job: job.id, error: String(e) }))
  }
