import {
  ASK_CONTRACT,
  ASK_NUDGE,
  type AskFields,
  type AutonomyFlags,
  type AutonomyLevel,
  applyEdits,
  decideWrite,
  EDITS_CONTRACT,
  EDITS_THRESHOLD_CHARS,
  EditError,
  editsNudge,
  type GateDecision,
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
 * nudge, run the autonomy gate over what came back, write, and record the outcome. They are
 * attended chat (in-request, in-process), an automation run on the loop substrate (claimed over
 * HTTP, settled over HTTP), an ask on the loop substrate, and the CLI runner. Written four
 * times, the four quietly stop agreeing about when a write may publish — which is the one
 * decision in this system nobody may re-implement.
 *
 * So the middle is here, and it is genuinely the middle: the model call, the nudge, the parse
 * and decideWrite. Not the ends.
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
    : contentType === "text/html"
      ? `${shortId}.html`
      : shortId

// ---- the landing port -----------------------------------------------------------------------

/** What landed, named so the transcript and the ledger can both point at it. */
export type WroteRef =
  | { kind: "version"; n: number }
  | { kind: "proposal"; id: string }
  | { kind: "artifact"; shortId: string }

export interface Landed {
  outcome: "published" | "proposed"
  wrote: WroteRef | null
  /** The reply, when the port knows something truer than the model's own note — "someone
   *  published while I was working" is a fact only the writer discovers. */
  note?: string
}

/**
 * WHERE a turn's answer lands. The decision is NOT the port's to make: it is computed above,
 * from the gate, so no lane can quietly disagree about when a write may publish. A port that
 * throws has failed the write, and the turn reports that rather than settling successfully —
 * a refused write recorded as a successful run is the worst shape a ledger bug takes.
 *
 * `shadow` never reaches a port: shadow files nothing at all, so there is nothing to land.
 */
export type LandingPort = (
  decision: Exclude<GateDecision, "shadow">,
  revision: Revision,
) => Promise<Landed>

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
  /** The gate's inputs. decideWrite runs HERE, above the port, in every lane. */
  gate: { autonomy: AutonomyLevel; flags: AutonomyFlags }
  land: LandingPort
}

export type TurnFailure = LoopFailure | "write"

export interface TurnOutcome {
  outcome: "published" | "proposed" | "answered" | "shadow" | "failed"
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

/** Run one turn: ask, nudge once, gate, land. Never throws — a lane that cannot report an
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

  // THE GATE, not the model, decides how this lands.
  const decision = decideWrite({
    autonomy: input.gate.autonomy,
    confidence: revision.confidence,
    flags: input.gate.flags,
  })
  if (decision === "shadow")
    return { outcome: "shadow", reply: prose || revision.message || "", wrote: null, ...base }

  try {
    const landed = await input.land(decision, revision)
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
