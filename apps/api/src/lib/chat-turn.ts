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

import { type Role, type SessionMessageRecord, type SessionRecord, toMicroUsd } from "@derive/core"
import { log } from "../log"
import type { AgentLoopInput } from "./agent-loop"
import type { ChatToolSurface } from "./chat-tools"
import type { ResolvedChatModel } from "./model-catalog"
import { asTurns, proseContract, runTurn } from "./turn-core"

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
  /** WHICH TOOLS THIS TURN ACTUALLY RAN, in order, first use only.
   *
   * The surface promises "Derive searches and reads with your own permissions, and links what it
   * used" and had no way to show it: the turn reported a reply, a cost and a model, so the one
   * claim the product makes about HOW an answer was reached was the one thing the transcript did
   * not record. Names only — arguments can carry the content of a private document, and this is
   * persisted on the message. */
  tools: string[]
}

export interface ChatTurnInput {
  session: SessionRecord
  transcript: SessionMessageRecord[]
  tools: ChatToolSurface
  /** The workspace's name, so the model can say where it is rather than printing an id. */
  workspaceName: string
  /**
   * Who is asking, and what they may do here.
   *
   * The ROLE is not decoration and it is not a gate — the gates are inside the tools, and they
   * hold whether or not this text exists. It is here because the agent is now asked questions
   * about Derive itself (derive://skills/helping), and "only an Admin can invite people" is a
   * useless sentence when the agent cannot tell whether it is talking to one. Without it the
   * answer is either a hedge or a guess, and a guess about someone's own permissions is the kind
   * of wrong that sends a person hunting for a button that was never going to be there.
   */
  asker: { name: string | null; role: Role }
  /** The skill index for the tools this turn holds — one line each in the prompt, bodies read
   *  on demand. Empty when the turn has no tools with separate procedure. */
  skills: { name: string; summary: string }[]
}

/** The transcript as plain chat turns, oldest first. */
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

/**
 * THE SYSTEM PROMPT, and why it is short.
 *
 * The same discipline the MCP surface already runs on (see buildServer's `instructions`): the
 * always-loaded text carries IDENTITY, the CONSEQUENCE lines that must hold on every single
 * turn, and an INDEX — and the procedure lives in skills the agent reads when it needs them.
 *
 * The split is not stylistic. A rule the agent must obey on every reply (cite what you used,
 * never invent) is worthless if it is one lazy read away; a procedure it needs on the turns it
 * actually searches (how the literal search behaves, which find mode, how to read a section) is
 * waste on every turn that does not. Chat gets this for free because it holds the REAL `read`
 * tool: `read("derive://skills/finding")` serves the same body the MCP resource does, so there
 * is one copy of the procedure and both surfaces read it.
 *
 * Anything longer than this belongs in a skill. If a lesson keeps having to be repeated here,
 * that is the signal the skill index needs a better line, not that the prompt needs a paragraph.
 */
/** The role in the words the app itself uses (Settings › Members shows these three). Saying
 *  "owner" or "commenter" to a person would name our storage vocabulary, not their seat. */
const roleWord = (role: Role): string =>
  role === "owner" ? "an Admin" : role === "editor" ? "a Creator" : "a Viewer"

const systemPrompt = (input: ChatTurnInput): string => {
  const names = input.tools.tools.map((t) => t.name)
  // Only the skills whose tools this turn actually holds: an index that points at procedure for
  // a tool the agent cannot call is a way to waste its one lazy read.
  const skills = input.skills.map(
    (s) => `- ${s.name} — ${s.summary} — read derive://skills/${s.name}`,
  )
  return `You are Derive, the agent built into Derive — a place teams keep living documents (called artifacts, or "derives") with full version history, review comments, and published web pages.

You are talking with ${input.asker.name ?? "someone"} in the workspace "${input.workspaceName}". They are ${roleWord(input.asker.role)} here. They are watching this reply as you write it.

TOOLS: ${names.length ? names.join(", ") : "none on this turn"}. Use them rather than guessing — you are answering about THIS workspace, and you cannot know its contents from memory.

Four things hold on every answer:
- SEARCH BEFORE YOU ANSWER anything about what the workspace contains, and answer from what came back rather than from what sounds right.
- LINK WHAT YOU USED: every document you name is a markdown link, [Q3 Roadmap](/artifacts/ab12cd34), using the short_id the tool returned. Never a bare short_id, never an invented one. Write the link PLAIN, never wrapped in bold or italics: emphasising the name produces a link whose bold closes inside it, which renders as literal asterisks around broken text. That is what a list of documents turns into when every name is emphasised.
- SAY SO WHEN THERE IS NOTHING. An empty workspace is a fact; plausible invented content is the one failure the person cannot detect by reading your answer.
- YOU SEE EXACTLY WHAT THEY SEE, no more: your tools run with this person's own permissions. So an empty result means nothing THEY can reach matched it, which is not the same as the workspace not having it — a teammate's invite-only document is invisible to you both. Say "I could not find" rather than "there is no", and when it matters, that a colleague may have it somewhere you cannot look.

HOW TO WRITE. Short, and human with it — a helpful colleague at their desk, not a reference manual. Warmth costs a word or two, not a paragraph. A one-line question gets a one-line answer. No preamble, no restating the question, no summarising what you just said, and no filler enthusiasm. When you are reporting more than two things, use bullets rather than a paragraph that lists them — a bullet per fact, one line each. Markdown renders, so bullets, bold and links are fine; headings in a chat reply are not. Say the answer first; add caveats only if they change what someone would do. Offering an obvious next step is welcome when there is one; inventing one is not. A broad question still gets a full answer, it is just written tightly. Never emit a revision or edits block: this conversation is not about one document, and nothing here would apply it.
${
  skills.length
    ? `\nSKILLS carry the procedure. Read the matching one with the read tool when you need it:\n${skills.join("\n")}`
    : ""
}`
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
  const used: string[] = []
  const out = await runTurn({
    system: systemPrompt(input),
    messages: asTurns(input.transcript, (m) => ({
      fromAgent: m.author_kind !== "asker",
      body: m.body_md,
    })),
    contract: proseContract,
    callModel: deps.model.callModel as AgentLoopInput["callModel"],
    tools: input.tools.tools,
    executeTool: async (name, args) => {
      if (!used.includes(name)) used.push(name)
      return input.tools.execute(name, args)
    },
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
      tools: used,
    }
  }
  return {
    reply: out.reply || "(no reply)",
    outcome: "answered",
    costMicroUsd: toMicroUsd(out.costUsd),
    model,
    tools: used,
  }
}
