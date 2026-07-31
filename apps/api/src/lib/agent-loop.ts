import { type AskFields, addCostUsd, NUDGE_LIMIT, type Revision } from "@derive/core"

/**
 * The MODEL TURN — call the model, let it use its tools, hold it to the output contract, and
 * hand back what it produced. Everything above the landing port (see lib/turn-core.ts).
 *
 * Most of what people automate is "read something, think about it, write an artifact". That
 * needs a model and fetch, both of which a Worker does natively, with millisecond cold starts
 * against container-minutes. The container exists because the other executor is a coding-agent
 * CLI that wants a filesystem, a shell and subprocesses — none of which that work requires.
 *
 * Deliberately dependency-free: plain fetch against the Messages API, no Mastra and no AI SDK.
 * That is what lets it run in a Worker at all (a heavy agent framework is exactly the thing that
 * blows a Worker bundle), and it keeps the loop small enough to read in one sitting.
 *
 * The CONTRACT is injected rather than hardcoded, because the three lanes that run a model turn
 * ask for genuinely different things and must not fork the loop to get them: an automation run
 * wants a revision or nothing happened; an attended edit of a large document wants search and
 * replace; an ask wants a revision OR a prose answer, plus the fields a waiting person can use.
 * Every one of those contracts lives in @derive/core, so the container executor and this loop
 * ask for the same output in the same words.
 *
 * The loop does NOT decide how a write lands. It returns what the model produced; the caller
 * runs decideWrite with the workspace flags, exactly as the container path
 * does.
 */

/** One tool the model may call, as the run's least-privilege list already describes it. */
export interface LoopTool {
  name: string
  description: string
  /** JSON-Schema-ish; passed through to the model as input_schema. */
  params: Record<string, unknown>
}

/** A model turn, reduced to what the loop needs. Injected so the loop is testable with no
 *  network and no key — the tests drive it with scripted turns. */
export interface ModelTurn {
  /** Assistant text, concatenated across content blocks. */
  text: string
  /** Tool calls the model wants executed before it can continue. */
  toolUses: { id: string; name: string; input: unknown }[]
  /** Reported spend for this turn in USD, when the provider tells us. Null = unknown. */
  costUsd: number | null
  /** True when the model finished its turn rather than pausing for tools. */
  done: boolean
}

export interface ModelMessage {
  role: "user" | "assistant"
  content: unknown
}

/** What one finished turn PRODUCED. The single shape every lane's landing port reads, so the
 *  gate and the write path never have to know which contract asked for it. */
export interface TurnProduct {
  /** What the model wants written, or null when it deliberately wrote nothing. Only a contract
   *  that ALLOWS an answer (the ask) ever yields null. */
  revision: Revision | null
  /** The prose outside the block — what a waiting person reads. Empty on the automation lane,
   *  where nobody is reading. */
  prose: string
  /** Session-only fields, when the contract carries them. */
  ask: AskFields | null
}

/** A reply the contract could not read. `nudge` is the ONE re-ask; `reply` is what to tell a
 *  waiting person if that re-ask also fails, when the contract knows something better to say
 *  than "it did not work" (an edit that missed knows WHICH anchor missed). */
export interface ContractMiss {
  detail: string
  nudge: string
  reply?: string
}

export type ContractRead =
  | { product: TurnProduct; miss?: undefined }
  | { product?: undefined; miss: ContractMiss }

/** How a lane asks for its output and reads the reply. The one axis the lanes vary on above the
 *  landing port. */
export interface ReplyContract {
  /** Appended to the system register by the CALLER, not by this loop: attended chat puts the
   *  contract before the document it is about, and moving it would change a prompt that has
   *  been verified against a real model. `system` therefore arrives fully composed. */
  text: string
  /** Read one FINISHED model turn (no tool calls pending). */
  read: (text: string) => ContractRead
}

export interface AgentLoopInput {
  /** The FULLY COMPOSED system prompt, contract text included. */
  system: string
  /** The conversation so far: one instruction for an automation, a transcript for an ask. */
  messages: ModelMessage[]
  tools: LoopTool[]
  contract: ReplyContract
  /** Call the model with the conversation so far. */
  callModel: (input: {
    system: string
    messages: ModelMessage[]
    tools: LoopTool[]
    /** Assistant text as it arrives, so a caller can show a reply being written instead of
     *  waiting for the whole thing.
     *
     *  OPTIONAL AND ADDITIVE ON PURPOSE. Streaming could have been a second return type, but
     *  `callModel` is implemented by two adapters and consumed by the loop, turn-core,
     *  session-turn and the substrate loop — plus every test that injects a fake. A callback on
     *  the INPUT leaves all of them untouched: an adapter that ignores it behaves exactly as
     *  before, and `ModelTurn` stays the single source of truth for the final text, tool calls,
     *  truncation and cost. Nothing downstream reads deltas to make a decision.
     *
     *  Deltas are BEST EFFORT and non-authoritative: they may be coalesced, and an adapter or
     *  provider without streaming simply never calls this. NEVER accumulate them into the answer
     *  you persist — use the returned `ModelTurn.text`, which is always the complete reply. */
    onDelta?: (text: string) => void
  }) => Promise<ModelTurn>
  /** Execute one tool server-side. Errors are RETURNED as text, never thrown — a failing tool
   *  is information the model should react to, not a reason to lose the whole run. */
  executeTool: (name: string, input: unknown) => Promise<unknown>
  /** Hard ceiling on model turns. Bounds spend and wall-clock on a model that loops calling
   *  tools forever; without it a stuck run costs money until the lease expires. */
  maxTurns?: number
}

/** WHY a turn produced nothing. The lanes word their apologies differently — a person in chat
 *  needs a sentence, a run's ledger needs a reason — so the classification is shared and the
 *  wording is not. */
export type LoopFailure =
  /** The model call itself did not complete (network, 429, 5xx). */
  | "model"
  /** The reply hit the token ceiling mid-sentence. Retrying produces the same truncation. */
  | "truncated"
  /** It replied, and the reply did not satisfy the contract even after the nudge. */
  | "contract"
  /** It never stopped calling tools. */
  | "turns"

export type AgentLoopResult =
  | { ok: true; product: TurnProduct; costUsd: number | null; turns: number }
  | {
      ok: false
      reason: LoopFailure
      error: string
      /** Contract-shaped advice for a waiting person, when the contract had some. */
      reply?: string
      retryable: boolean
      costUsd: number | null
      turns: number
    }

/** Bounded by default. Deep enough for pull-several-sources-then-write, shallow enough that a
 *  runaway loop is caught in seconds rather than at the lease timeout. */
export const DEFAULT_MAX_TURNS = 12

/** Serialize a tool result for the model. Objects go as JSON; an Error becomes its message, so a
 *  failing tool reads as a fact the model can respond to ("that source is down, note it") rather
 *  than terminating the run. */
const resultText = (value: unknown): string => {
  if (value instanceof Error) return `ERROR: ${value.message}`
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? "null"
  } catch {
    return String(value)
  }
}

/** A truncated reply, duck-typed. TruncatedReplyError (lib/model-openai) carries `truncated`;
 *  matching on the property rather than importing the class keeps this file free of the
 *  provider adapters that depend on IT. */
const wasTruncated = (e: unknown): boolean =>
  !!e && typeof e === "object" && (e as { truncated?: unknown }).truncated === true

export const runAgentLoop = async (input: AgentLoopInput): Promise<AgentLoopResult> => {
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS
  const messages: ModelMessage[] = [...input.messages]
  // Accumulated across EVERY turn, including the ones that end in failure — a run that burned
  // eight turns and produced nothing still cost money, and the budget sums what is reported.
  // Shared with the container executor via @derive/core/run-policy: null means UNKNOWN, never
  // zero, and attempts ACCUMULATE — a run that burned three turns for nothing still cost money.
  let costUsd: number | null = null
  const spend = (c: number | null) => {
    costUsd = addCostUsd(costUsd, c)
  }
  let turns = 0
  // NUDGE_LIMIT is the shared policy (one re-ask), not a local choice.
  let nudges = 0

  while (turns < maxTurns) {
    turns += 1
    let turn: ModelTurn
    try {
      turn = await input.callModel({ system: input.system, messages, tools: input.tools })
    } catch (e) {
      // The model call itself failed (429, 5xx, a network blip). Retryable: the expensive part
      // has not happened yet and a second attempt may well succeed — the same judgement the
      // container executor makes, with the server owning the retry policy either way.
      //
      // Except truncation, which is not a connectivity problem and where "try again" is advice
      // that cannot work: the reply did not fit and will not fit next time either.
      const truncated = wasTruncated(e)
      return {
        ok: false,
        reason: truncated ? "truncated" : "model",
        error: (e as Error).message,
        retryable: !truncated,
        costUsd,
        turns,
      }
    }
    spend(turn.costUsd)

    if (turn.toolUses.length > 0) {
      messages.push({ role: "assistant", content: turn.toolUses })
      // Sequential, not parallel: tools here are brokered calls into other people's systems, and
      // a model that asks for six at once should not become six concurrent writes to someone's
      // Gmail. Latency is the right thing to trade for that.
      const results: { tool_use_id: string; content: string }[] = []
      for (const use of turn.toolUses) {
        try {
          results.push({
            tool_use_id: use.id,
            content: resultText(await input.executeTool(use.name, use.input)),
          })
        } catch (e) {
          results.push({ tool_use_id: use.id, content: resultText(e) })
        }
      }
      messages.push({ role: "user", content: results })
      continue
    }

    const read = input.contract.read(turn.text)
    if (read.product) return { ok: true, product: read.product, costUsd, turns }

    // A finished turn the contract could not use. Nudge ONCE — models routinely describe the
    // change instead of emitting it, or miss an anchor by a space, and one reminder recovers the
    // work rather than discarding a completed run. Twice would just pay again for the same
    // failure. The nudge is the CONTRACT'S, so an edit that missed carries the diagnostic
    // explaining WHY, which is what makes the second attempt likely to work.
    if (nudges < NUDGE_LIMIT) {
      nudges += 1
      messages.push({ role: "assistant", content: turn.text })
      messages.push({ role: "user", content: read.miss.nudge })
      continue
    }
    // Deterministic: a model that ignored the contract twice will ignore it a third time, so
    // this must not look retryable or the run pays for the same answer again.
    return {
      ok: false,
      reason: "contract",
      error: read.miss.detail,
      ...(read.miss.reply ? { reply: read.miss.reply } : {}),
      retryable: false,
      costUsd,
      turns,
    }
  }

  // Ran out of turns still calling tools. Not retryable for the same reason: a loop that could
  // not converge in maxTurns will not converge in another maxTurns.
  return {
    ok: false,
    reason: "turns",
    error: `agent did not produce a revision within ${maxTurns} turns`,
    retryable: false,
    costUsd,
    turns,
  }
}
