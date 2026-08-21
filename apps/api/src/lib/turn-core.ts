import {
  ASK_CONTRACT,
  ASK_NUDGE,
  type AskFields,
  applyEdits,
  docMap,
  EDITS_CONTRACT,
  EDITS_THRESHOLD_CHARS,
  EditError,
  editsNudge,
  isHtmlLike,
  mapJson,
  NO_EDITS_BLOCK,
  parseAsk,
  parseEdits,
  parseRevision,
  proseOf,
  REVISION_CONTRACT,
  REVISION_NUDGE,
  type Revision,
} from "@derive/core"
import {
  type AgentLoopInput,
  type LoopFailure,
  type LoopTool,
  type ModelMessage,
  type ReplyContract,
  runAgentLoop,
} from "./agent-loop"
import { BillingBlockedError } from "./billing"

/**
 * ONE TURN, for every lane that runs one.
 *
 * Four paths in this repo run the same shape: call the model, hold it to a contract with one
 * nudge, land what came back, and record the outcome. They are attended chat (in-request,
 * in-process), an automation run on the loop substrate (claimed over HTTP, settled over HTTP),
 * an ask on the loop substrate, and the CLI runner. Written four times, the four quietly stop
 * agreeing about what a reply means — which is the one contract nobody may re-implement.
 *
 * So the middle is here, and it is genuinely the middle: the model call, the nudge, the parse.
 * Not the ends.
 *
 * THE LANDING PORT is the seam, and the reason this is not just an extracted function. Attended
 * chat writes IN-PROCESS — it is the API, it has the store and the blob store in hand. The loop
 * substrate writes OVER HTTP against this same API, on purpose: a runner is an HTTP CLIENT of
 * Derive, not a privileged insider, so it goes through the same authorization the container
 * executor does and runs unchanged on Node and on Workers. Neither is a worse version of the
 * other, and faking one shared write path would have to pick a loser. Above the port everything
 * is shared; below it each lane keeps its own.
 *
 * WORK ARRIVAL and SETTLE stay below the port too, and stay explicit. In-request versus
 * `GET /v1/agent/runs/claim` versus `POST /v1/agent/sessions/claim` are three different things,
 * and the third returns ONE session where the second returns a list. A "unified" arrival would
 * have to paper over that, and papering over exactly that is what made handing a session id to
 * the runs claim a silent no-op.
 */

// ---- contracts ------------------------------------------------------------------------------
//
// Which output a lane asks for, and how it reads the reply. Every one of them is @derive/core's,
// so the container executor and the loop ask for the same thing in the same words.

/**
 * The PROSE contract: the reply IS the answer, and there is nothing to parse.
 *
 * Every other contract here exists because a turn has to produce a WRITE, and the block carrying
 * it can be malformed — which is what a nudge is for. A turn whose writes all happen through
 * TOOLS has no block: by the time the model is writing prose it has already done whatever it was
 * going to do, so there is no failure mode to re-ask about. Reading is therefore total, this
 * contract can never miss, and the nudge path is dead for this lane rather than something it
 * opted out of.
 *
 * The contract TEXT is empty on purpose: the lane composes its own system prompt, and a
 * "reply with a block" instruction here would ask for exactly the thing that must not appear.
 */
export const proseContract: ReplyContract = {
  text: "",
  read: (text) => ({ product: { revision: null, prose: text, ask: null } }),
}

/** The AUTOMATION contract: a <revision> block, or nothing happened. No prose channel, because
 *  nobody is reading — a run that "explained itself" instead of writing produced nothing. */
export const revisionContract: ReplyContract = {
  text: REVISION_CONTRACT,
  read: (text) => {
    const p = parseRevision(text)
    return p.revision
      ? { product: { revision: p.revision, prose: proseOf(text), ask: null } }
      : { miss: { detail: p.error, nudge: REVISION_NUDGE } }
  },
}

/**
 * A turn where an ANSWER is a legitimate outcome — the same block, now optional.
 *
 * This is the whole of "an ask": not a third contract, but the revision contract on a turn where
 * the model was allowed to decide it had nothing to write. A reply with no block is therefore an
 * answer and is NEVER nudged; only a block that was present and unreadable is a miss, because
 * that is the model trying and failing rather than choosing.
 *
 * The contract TEXT is a parameter because the two answerable lanes legitimately ask in
 * different words — attended chat is talking to someone about a document in front of them, the
 * unattended ask lane is a packaged agent answering a question — while the READING is shared,
 * which is the half that must not fork.
 */
export const answerContract = (text: string = ASK_CONTRACT): ReplyContract => ({
  text,
  read: (reply) => {
    const p = parseAsk(reply)
    if (!p.reply) return { miss: { detail: p.error, nudge: ASK_NUDGE } }
    const { body_md, revision, ...ask } = p.reply
    return { product: { revision, prose: body_md, ask } }
  },
})

/** The unattended ask lane's contract: answerable, and it asks in ASK_CONTRACT's words. */
export const askContract: ReplyContract = answerContract()

/** The EDITS contract: the same job as a revision, sized for a document that cannot be returned
 *  whole. Closes over the source because APPLYING the edits is the parse — an anchor that does
 *  not match is a contract miss, and the diagnostic saying which anchor is what makes the one
 *  retry likely to work. All-or-nothing, so a document is never half-written. */
export const editsContract = (source: string): ReplyContract => ({
  text: EDITS_CONTRACT,
  read: (text) => {
    const ed = parseEdits(text)
    if (ed.edits) {
      try {
        return {
          product: {
            revision: {
              content: applyEdits(source, ed.edits),
              // The caller keeps the document's OWN content type; this is only a fallback for a
              // document that somehow has none recorded.
              filename: "index.html",
              confidence: ed.confidence,
              ...(ed.message ? { message: ed.message } : {}),
            },
            prose: proseOf(text),
            ask: null,
          },
        }
      } catch (e) {
        const detail = e instanceof EditError ? e.message : "the edits could not be applied"
        return {
          miss: {
            detail,
            nudge: editsNudge(detail),
            reply: `I could not apply that change: ${detail}`,
          },
        }
      }
    }
    // No block at all is a plain answer here, exactly as with a revision: the attended caller
    // reads a missing block as "they asked a question". Handing it back as a product with no
    // revision lets that caller answer, and an unattended caller treat it as producing nothing.
    if (ed.error === NO_EDITS_BLOCK)
      return { product: { revision: null, prose: proseOf(text), ask: null } }
    return { miss: { detail: ed.error, nudge: editsNudge(ed.error) } }
  },
})

// ---- revising an EXISTING document -------------------------------------------------------------

/**
 * WHICH CONTRACT to ask for when the turn revises a document that already exists.
 *
 * A revision's reply is bounded by the DOCUMENT; an edit's by the CHANGE. Below the threshold,
 * whole-document is the better ask — it cannot miss on an exact match. Above it a whole-document
 * reply cannot fit in the model's output budget at all, so search/replace is not a preference but
 * the only thing that works.
 *
 * `answerable` is the attended/unattended difference, and the only one. A person may be asking a
 * QUESTION about the document, so a reply with no block is a perfectly good answer. An automation
 * that "answered" instead of writing produced nothing, so its contract does not offer the option.
 */
export const documentContract = (source: string, answerable: boolean): ReplyContract =>
  source.length > EDITS_THRESHOLD_CHARS
    ? editsContract(source)
    : answerable
      ? answerContract(REVISION_CONTRACT)
      : revisionContract

/**
 * THE DOCUMENT ITSELF, as a delimited block for the system prompt.
 *
 * Every lane that revises an existing artifact must include this, and the reason is not
 * ergonomics. Asked for "the complete new source" of a document it was never shown, a model
 * cannot comply and cannot tell you so — it writes a plausible document from nothing. An
 * instruction like "keep every existing section unchanged" is then unsatisfiable by construction,
 * and at `publish` the invented document replaces the real one.
 *
 * Kept separate from the transcript and from the instruction, so text that happens to contain
 * markup can never be mistaken for the document.
 */
export const documentBlock = (source: string, filename: string): string =>
  `The document's current source follows, and its filename is ${filename}.

--- BEGIN DOCUMENT ---
${source}
--- END DOCUMENT ---`

/** Above this many characters, a lane that can READ PARTS is given the document's map
 *  instead of the document.
 *
 *  The paste is not free: it is re-sent on every model call of the turn (up to twelve), so
 *  a 300KB deck costs 75-100k input tokens PER CALL and reliably exceeds the hosted turn
 *  budget before it can answer. The map is a few hundred tokens and names every part, and
 *  the lane then reads the one part it is changing at its exact source. Below the
 *  threshold the paste is cheaper than the round trip, so it stays. */
export const MAP_INSTEAD_OF_SOURCE_CHARS = 32_000

/** The document's STRUCTURE, for a document too big to paste. Same refs `read` takes. */
const documentMapBlock = (source: string, filename: string, contentType: string): string => {
  const json = JSON.stringify(mapJson(docMap(source, contentType), 0).nodes)
  return `This document is ${source.length} characters — too large to include whole, so here is its MAP instead. Its filename is ${filename}.

--- BEGIN DOCUMENT MAP ---
${json}
--- END DOCUMENT MAP ---

Each entry's \`ref\` names one part. Read the part you need with read(short_id, node:"<ref>"), and pass format:"html" to get the exact source an edit must match. Do not guess at text you have not read.`
}

/**
 * The document for the system prompt: the whole source, or its map when the source is too
 * big AND the lane can read parts back. A lane with no tools always gets the source, because
 * a map it cannot follow is strictly worse than a document it can at least see.
 */
export const documentContext = (
  source: string,
  filename: string,
  contentType: string,
  canReadParts: boolean,
): string => {
  if (canReadParts && source.length > MAP_INSTEAD_OF_SOURCE_CHARS) {
    try {
      return documentMapBlock(source, filename, contentType)
    } catch {
      // An unmappable document (ambiguous deck structure) falls back to the paste rather
      // than losing the document: a big prompt beats a blind model.
    }
  }
  return documentBlock(source, filename)
}

/**
 * The name to SHOW the model for a document it is about to revise.
 *
 * Both lanes passed a bare short_id ("wa68nr6q"), which carries no format signal at all. Asked
 * to name its output the model then guessed, and the edits contract's fallback turned that guess
 * into `index.html` — which is how a Markdown document intermittently came back as HTML.
 *
 * The landing port no longer trusts the model's filename either (it keeps the document's
 * recorded type), and the two fixes are not redundant: this one stops the model being misled,
 * that one stops a misled model doing damage. A model told "this file is called wa68nr6q" can
 * also write HTML into a Markdown document's BODY, which no amount of correcting the content
 * type afterwards would undo.
 */
export const documentName = (shortId: string, contentType: string | null | undefined): string =>
  contentType === "text/markdown"
    ? `${shortId}.md`
    : isHtmlLike(contentType ?? "")
      ? `${shortId}.html`
      : shortId

// ---- the landing port -----------------------------------------------------------------------

/** How much drafted source a surfaced suggestion pastes — a message, not a document dump. */
const SUGGESTION_CHARS = 6_000

/** How much of the model's version note rides above it. Bounded separately because the total
 *  must clear the comment route's 10k body cap with room to spare — an over-cap suggestion
 *  would fail the very reply meant to keep the draft from being lost. */
const SUGGESTION_MESSAGE_CHARS = 2_000

/** A drafted revision surfaced as text — the body of every suggestion a lane pastes into
 *  prose (the mention thread's reply, and a chat reply when the write could not land), so
 *  the lanes cannot drift on how. Fenced with four backticks so a draft that itself contains
 *  a code fence stays intact. The WORDING is the lane's: who is reading, and what to do when
 *  the draft is too big to paste, genuinely differ. */
export const suggestionText = (
  revision: Revision,
  wording: { lead: string; tooBig: string },
): string => {
  const body =
    revision.content.length <= SUGGESTION_CHARS
      ? `${wording.lead}\n\n\`\`\`\`\n${revision.content}\n\`\`\`\``
      : wording.tooBig
  return `${revision.message ? `${revision.message.slice(0, SUGGESTION_MESSAGE_CHARS)}\n\n` : ""}${body}`
}

/** What landed, named so the transcript and the ledger can both point at it. */
export type WroteRef = { kind: "version"; n: number } | { kind: "artifact"; shortId: string }

export interface Landed {
  /** `commented`: the drafted change was surfaced (a reply, a thread comment, an
   *  artifact comment) and the document was not written. */
  outcome: "published" | "commented"
  wrote: WroteRef | null
  /** The reply, when the port knows something truer than the model's own note — "someone
   *  published while I was working" is a fact only the writer discovers. */
  note?: string
}

/**
 * WHERE a turn's revision lands. Reached only when the model actually wrote one. The port
 * publishes — every agent write lands live, the same as a person's — except where something
 * the port itself discovers or was told stands in the way (a mid-turn race, a lane whose
 * asker cannot publish, the workspace switch), in which case the drafted change surfaces as
 * `commented` instead of being silently dropped. A port that throws has failed the write, and
 * the turn reports that rather than settling successfully — a refused write recorded as a
 * successful run is the worst shape a ledger bug takes.
 */
export type LandingPort = (revision: Revision) => Promise<Landed>

export interface TurnInput {
  /** The FULLY COMPOSED system prompt. The caller places `contract.text` itself, because
   *  attended chat puts the contract before the document it is about. */
  system: string
  messages: ModelMessage[]
  tools?: LoopTool[]
  contract: ReplyContract
  callModel: AgentLoopInput["callModel"]
  executeTool?: AgentLoopInput["executeTool"]
  maxTurns?: number
  land: LandingPort
}

export type TurnFailure = LoopFailure | "write"

export interface TurnOutcome {
  outcome: "published" | "commented" | "answered" | "failed"
  /** The model's own words: its prose, or the port's note. Empty on a failure — the apology is
   *  the lane's to word, because a person in chat needs a sentence and a ledger needs a reason. */
  reply: string
  wrote: WroteRef | null
  costUsd: number | null
  /** The model's stated confidence in what it wrote, or null (unstated, or it wrote nothing). */
  confidence: number | null
  /** Session-only fields, when the contract carried them. */
  ask: AskFields | null
  turns: number
  failure?: {
    reason: TurnFailure
    error: string
    retryable: boolean
    reply?: string
    /** True when this "write" failure is actually the billing gate refusing the write (see
     *  BillingBlockedError) — never set for any other reason. Lets a lane's apology surface
     *  the copy verbatim without re-deriving it from the error string. */
    billingBlocked?: boolean
  }
}

/** Run one turn: ask, nudge once, land. Never throws — a lane that cannot report an
 *  outcome cannot settle its work, and unsettled work is worse than a failed one. */
export const runTurn = async (input: TurnInput): Promise<TurnOutcome> => {
  const res = await runAgentLoop({
    system: input.system,
    messages: input.messages,
    tools: input.tools ?? [],
    contract: input.contract,
    callModel: input.callModel,
    executeTool: input.executeTool ?? (async () => ({ error: "this turn has no tools" })),
    maxTurns: input.maxTurns,
  })
  if (!res.ok)
    return {
      outcome: "failed",
      reply: "",
      wrote: null,
      costUsd: res.costUsd,
      confidence: null,
      ask: null,
      turns: res.turns,
      failure: {
        reason: res.reason,
        error: res.error,
        retryable: res.retryable,
        ...(res.reply ? { reply: res.reply } : {}),
      },
    }

  const { revision, prose, ask } = res.product
  const base = {
    costUsd: res.costUsd,
    confidence: revision?.confidence ?? null,
    ask,
    turns: res.turns,
  }
  // The model chose not to write. On an ask that is the answer; on an automation run the
  // contract never produces this, so the lane above decides what "nothing" means.
  if (!revision) return { outcome: "answered", reply: prose, wrote: null, ...base }

  try {
    const landed = await input.land(revision)
    return {
      outcome: landed.outcome,
      // The port's note wins (only the writer discovers "someone published while I was
      // working"). Otherwise the model's PROSE, which on an ask is the answer itself and must
      // not be replaced by a one-line version note meant for the history sidebar.
      reply: landed.note ?? (prose || revision.message || ""),
      wrote: landed.wrote,
      ...base,
    }
  } catch (e) {
    // A failed WRITE is worth retrying: the expensive part (the model turn) already succeeded,
    // and a 5xx on publish is exactly the transient case. A billing block is the one exception:
    // the model turn still succeeded, but retrying cannot land the write until the plan changes,
    // so it is NOT retryable and gets tagged so the lane can surface the copy verbatim.
    return {
      outcome: "failed",
      reply: "",
      wrote: null,
      ...base,
      failure: {
        reason: "write",
        error: e instanceof Error ? e.message : String(e),
        retryable: !(e instanceof BillingBlockedError),
        ...(e instanceof BillingBlockedError ? { billingBlocked: true } : {}),
      },
    }
  }
}

/**
 * A TRANSCRIPT, as the model reads it.
 *
 * Every lane keeps its history in its own row type — session messages for chat, comments for a
 * mention thread — and every lane has to answer the same two questions about each row: was this
 * US, and what was said. The mapping is trivial and was written per lane, which is exactly the
 * kind of duplication that rots quietly: a row wrongly labelled `assistant` makes the model
 * believe it said something it never said, and it will then defend it. There is no error, no
 * failed test, just a confidently wrong conversation.
 *
 * So the SHAPE lives here once and the PREDICATES stay per-lane, because they genuinely differ:
 * chat decides by `author_kind`, a comment thread by whether the author is Derive.
 *
 * The speaker's name is prefixed only where one is given. A chat session has two participants
 * and needs no labels; a comment thread can have five, and an unattributed transcript there
 * turns a conversation into one voice arguing with itself.
 */
export const asTurns = <T>(
  rows: T[],
  read: (row: T) => { fromAgent: boolean; body: string; speaker?: string | null },
): { role: "user" | "assistant"; content: string }[] =>
  rows.map((row) => {
    const { fromAgent, body, speaker } = read(row)
    return fromAgent
      ? { role: "assistant" as const, content: body }
      : { role: "user" as const, content: speaker ? `${speaker}: ${body}` : body }
  })
