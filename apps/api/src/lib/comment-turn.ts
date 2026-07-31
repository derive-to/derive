// @derive IN A COMMENT — the third arrival on the same turn.
//
// A comment thread is where questions about a document already live, so this lane adds no new
// place to ask: someone @mentions Derive in a thread, and the answer lands in that thread as a
// reply. What it is NOT is a new conversation surface — there is no session, because the THREAD
// is the transcript and the record.
//
// The document is the ground (the same `documentContract` the rail's chat uses), the thread is
// the conversation, and the settle is a comment. Everything else — the model call, the tool
// loop, the nudge, the gate — is turn-core's, exactly as it is for every other lane.

import {
  type ArtifactRecord,
  type BlobStore,
  type CommentRecord,
  MAX_ARTIFACT_CHARS,
  type MetaStore,
  NUDGE_LIMIT,
  newId,
  type Revision,
  roleAllows,
  toMicroUsd,
} from "@derive/core"
import type { Backplane } from "../bus"
import { log } from "../log"
import type { AgentLoopInput } from "./agent-loop"
import { overBudget } from "./budget"
import { type CommentActionDeps, commentCreatedAction } from "./comment-actions"
import { quoteOf } from "./comments"
import type { ModelCatalog, ResolvedChatModel } from "./model-catalog"
import { documentBlock, documentContract, documentName, runTurn } from "./turn-core"

/** The author id every Derive-written comment carries. Not an agent record: the same synthetic
 *  principal the chat lanes use, which is what keeps this from needing a seat, an owner, or a
 *  provisioning step. It is also the recursion guard — a comment authored by this id never
 *  triggers another turn. */
export const DERIVE_AUTHOR_ID = "derive"

/** The mention id the composer offers for Derive. Deliberately the same string as the author id,
 *  so "who was mentioned" and "who answered" are the one identity in both directions. */
export const DERIVE_MENTION_ID = DERIVE_AUTHOR_ID

/** Exactly what this lane needs: the comment fan-out's deps (its settle IS a comment) plus a
 *  model. Deliberately NOT AfterPublishDeps — this turn only ever files a proposal, so it never
 *  reaches the post-publish path, and claiming those deps would be a lie about what it does. */
export interface CommentTurnDeps extends CommentActionDeps {
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
  /** Their effective role on this artifact, re-derived by the caller for THIS turn. */
  canWrite: boolean
  flags: { agentKillswitch: boolean; agentAutoEnabled: boolean }
}

/** Who wrote each line, so a multi-party thread reads as a conversation rather than one voice. */
const asTurns = (
  thread: CommentRecord[],
  names: Map<string, string>,
): { role: "user" | "assistant"; content: string }[] =>
  thread.map((c) =>
    c.author_id === DERIVE_AUTHOR_ID
      ? { role: "assistant" as const, content: c.body_md }
      : {
          role: "user" as const,
          content: `${names.get(c.author_id ?? "") ?? c.author}: ${c.body_md}`,
        },
  )

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
    const created = await meta.createComment({
      id: newId("c"),
      artifact_id: artifact.id,
      thread_id: comment.thread_id,
      base_version: artifact.current_version,
      path: comment.path,
      // The REPLY carries no anchor of its own: it belongs to the thread, and a second
      // highlight over the same span would double-underline the document.
      anchor: null,
      body_md: body,
      author: "Derive",
      author_id: DERIVE_AUTHOR_ID,
    })
    // The SAME fan-out any other comment runs — which is what puts this answer in the Slack
    // mirror, the GitHub mirror, the bells and the webhooks for free. Recursion is not a risk:
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
the document, reply with the revision block described below; ${
    input.canWrite
      ? "it will be filed as a proposal for a human to approve."
      : "you may not write to this document, so explain rather than attempting a revision."
  }

${contract.text}

${documentBlock(source, documentName(artifact.short_id, artifact.current_content_type))}`

  const out = await runTurn({
    system,
    messages: asTurns(thread, names),
    contract,
    callModel: deps.model.callModel as AgentLoopInput["callModel"],
    // No tools on this lane yet: the document IS the ground, and the thread is about it.
    maxTurns: NUDGE_LIMIT + 1,
    gate: {
      // SUGGEST ALWAYS. A comment mention never live-publishes, whatever the workspace's
      // autonomy opt-in says: the person asked a question in a thread, and a document that
      // rewrote itself out of a conversation nobody was watching for a write is the surprise
      // this lane must never produce. The proposal is one click from the same thread.
      autonomy: "suggest",
      flags: { ...input.flags, credentialed: false },
    },
    land: async (_decision, revision: Revision) => {
      if (!input.canWrite) throw new Error("asker cannot propose to this artifact")
      const blob = new TextEncoder().encode(revision.content)
      const blobKey = await deps.blobs.put(blob)
      const proposal = await meta.createProposal({
        id: newId("p"),
        artifact_id: artifact.id,
        blob_key: blobKey,
        // The DOCUMENT's format, never the model's filename — the same rule the attended lane
        // learned the hard way (a Markdown doc silently became HTML).
        content_type:
          artifact.current_content_type ??
          (revision.filename.endsWith(".md") ? "text/markdown" : "text/html"),
        kind: artifact.kind,
        message: revision.message ?? null,
        author: "Derive",
        author_id: DERIVE_AUTHOR_ID,
        on_behalf_of: asker.id,
        base_version: artifact.current_version,
      })
      return {
        outcome: "proposed",
        wrote: { kind: "proposal", id: proposal.id },
        note: `${revision.message || "Done."}\n\nI filed that as a proposal for review rather than editing the document from a comment.`,
      }
    },
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

/** Does this comment ask Derive to answer? A mention of the reserved id, and not from Derive
 *  itself — the recursion guard, stated where the branch is taken rather than inside the turn. */
export const mentionsDerive = (comment: CommentRecord, mentions: { id: string }[]): boolean =>
  comment.author_id !== DERIVE_AUTHOR_ID && mentions.some((m) => m.id === DERIVE_MENTION_ID)

/** Whether an asker may have a revision filed on their behalf here. Kept beside the turn so the
 *  branch and the land port cannot disagree about it. */
export const askerCanPropose = (role: string | null | undefined): boolean =>
  !!role && roleAllows(role as Parameters<typeof roleAllows>[0], "propose")

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
    models: ModelCatalog
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
    const settings = await meta.getOrgSettings(artifact.org_id).catch(() => null)
    if (!settings?.chatBeta) return quiet("chat not enabled")
    if (deps.chatAllowlist?.length && !deps.chatAllowlist.includes(artifact.org_id))
      return quiet("workspace not allowlisted")
    // MEMBERSHIP, not merely the ability to comment: a signed-in holder of a commenter LINK can
    // leave a comment, and that is not standing to spend the workspace's model budget.
    const seat = await meta.getMembership(artifact.org_id, asker.id).catch(() => null)
    if (!seat) return quiet("asker is not a member")
    if (await overBudget(meta, artifact.org_id, asker.id).catch(() => false))
      return quiet("monthly model budget reached")

    const model = deps.models.resolve(null)
    if (!model) return quiet("no model configured")

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
        canWrite: askerCanPropose(seat.role),
        flags: {
          agentKillswitch: settings.agentKillswitch,
          agentAutoEnabled: settings.agentAutoEnabled,
        },
      },
    )
  }
