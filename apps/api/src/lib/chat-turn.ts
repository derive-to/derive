// ONE TURN of a chat that is about the WORKSPACE rather than one document — the global chat.
//
// Its sibling is session-turn.ts ("chat with a derive"), and the difference is exactly one thing:
// that lane has a document in front of it, so its turn reads the source, asks for a revision and
// lands it through a port. This lane has no document. What it has instead is TOOLS, so everything
// it does — find, read, and later write — happens inside the loop, and the reply is only prose.
//
// That makes the turn itself smaller, not bigger: no landing port, no revision contract, no
// nudge, no race with a human publishing mid-turn. The parts that must never drift (the model
// call, the tool loop, the turn ceiling, cost accounting) are turn-core's, which the unattended
// lanes run too.

import { type SessionMessageRecord, type SessionRecord, toMicroUsd } from "@derive/core"
import { log } from "../log"
import type { AgentLoopInput } from "./agent-loop"
import type { ChatToolSurface } from "./chat-tools"
import type { ResolvedChatModel } from "./model-catalog"
import { proseContract, runTurn } from "./turn-core"

export interface ChatTurnDeps {
  /** The model this turn runs on — resolved from the catalog by the route, so the person's
   *  choice reaches the call rather than the deploy's default always winning. */
  model: ResolvedChatModel
}

/** What a chat turn produced, for the transcript and the ledger. Deliberately the same shape
 *  session-turn returns, minus the write refs it cannot produce. */
export interface ChatTurnResult {
  reply: string
  outcome: "answered" | "failed"
  costMicroUsd: number | null
  /** Which model answered, recorded on the message so a transcript can say so and a picker can
   *  default to it. */
  model: { id: string; label: string }
}

export interface ChatTurnInput {
  session: SessionRecord
  transcript: SessionMessageRecord[]
  tools: ChatToolSurface
  /** The workspace's name, so the model can say where it is rather than printing an id. */
  workspaceName: string
  /** Who is asking, for the model's own reference ("what did I write last week"). */
  asker: { name: string | null }
}

/** The transcript as plain chat turns, oldest first. */
const asTurns = (msgs: SessionMessageRecord[]): { role: "user" | "assistant"; content: string }[] =>
  msgs.map((m) => ({
    role: m.author_kind === "asker" ? ("user" as const) : ("assistant" as const),
    content: m.body_md,
  }))

/** What to tell the person when the turn produced nothing. Classification is turn-core's and
 *  shared; the WORDING is this lane's, because somebody is reading it. */
const apologyFor = (failure: { reason: string; error: string }): string => {
  if (failure.reason === "truncated")
    return "That reply was cut off before it finished. Try asking for less at once."
  if (failure.reason === "model") return "I could not reach the model just now — try again."
  if (failure.reason === "turns")
    return "I spent this turn's budget looking things up without reaching an answer. Try a narrower question."
  return "I could not produce an answer to that."
}

const systemPrompt = (input: ChatTurnInput): string => {
  const names = input.tools.tools.map((t) => t.name)
  return `You are Derive, the agent built into Derive — a place teams keep living documents (called artifacts, or "derives") with full version history, review comments, and published web pages.

You are talking with ${input.asker.name ?? "someone"} in the workspace "${input.workspaceName}". They are watching this reply as you write it.

WHAT YOU CAN DO. You have tools${names.length ? `: ${names.join(", ")}` : " (none on this turn)"}. Use them rather than guessing:
- Search the workspace before answering anything about what it contains. A confident answer from memory about a document you did not read is the single worst thing you can do here.
- Read a document when the answer depends on what it actually says, and cite it: give the title and its URL, which is /artifacts/<short_id>.
- If the workspace genuinely has nothing on the topic, say so plainly. Do not fill the gap with plausible content.

HOW TO WRITE. Answer the question asked, at the length it deserves — a one-line question gets a
one-line answer. Prose, no preamble, no restating the question back. Markdown is rendered, so
short lists and bold are fine; headings in a chat reply are not.

Never emit a revision block, an edits block, or any other machine block: this conversation is not about one document, and there is nothing here that would apply it.`
}

/**
 * Run one workspace chat turn. Never throws: the transcript is what the person is looking at, so
 * a failed turn still owes them a sentence.
 */
export const runChatTurn = async (
  deps: ChatTurnDeps,
  input: ChatTurnInput,
): Promise<ChatTurnResult> => {
  const model = { id: deps.model.id, label: deps.model.label }
  const out = await runTurn({
    system: systemPrompt(input),
    messages: asTurns(input.transcript),
    contract: proseContract,
    callModel: deps.model.callModel as AgentLoopInput["callModel"],
    tools: input.tools.tools,
    executeTool: input.tools.execute,
    // The gate cannot fire: proseContract never yields a revision, so decideWrite is never
    // consulted and `land` is unreachable. Stated with the safest values rather than omitted,
    // so a future contract change fails closed (a proposal) instead of publishing.
    gate: {
      autonomy: "suggest",
      flags: { agentKillswitch: false, agentAutoEnabled: false, credentialed: false },
    },
    land: async () => {
      // Unreachable by construction. Loud rather than silent: reaching here would mean a
      // contract change quietly gave this lane a write path nobody designed.
      throw new Error("chat turn has no landing port: writes ride the tools")
    },
  })

  if (out.failure) {
    log.warn("chat turn produced nothing", {
      session: input.session.id,
      reason: out.failure.reason,
      error: out.failure.error,
      model: model.id,
    })
    return {
      reply: apologyFor(out.failure),
      outcome: "failed",
      costMicroUsd: toMicroUsd(out.costUsd),
      model,
    }
  }
  return {
    reply: out.reply || "(no reply)",
    outcome: "answered",
    costMicroUsd: toMicroUsd(out.costUsd),
    model,
  }
}
