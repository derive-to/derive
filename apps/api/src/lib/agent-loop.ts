import { type AskFields, addCostUsd, NUDGE_LIMIT, type Revision } from "@derive/core"
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage as SdkMessage,
  stepCountIs,
} from "ai"

import { asMessages, type ModelMessage } from "./model-messages"

export type { ModelMessage } from "./model-messages"

/** The SDK owns tool orchestration. Derive owns permissions, budgets, and landing. */

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

/** What one finished turn PRODUCED. The single shape every lane's landing port reads, so the
 *  gate and the write path never have to know which contract asked for it. */
export interface TurnProduct {
  /** What the model wants written, or null when it deliberately wrote nothing. Only a contract
   *  that ALLOWS an answer (the ask) ever yields null. */
  revision: Revision | null
  /** The prose outside the block: what the waiting person reads. */
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
  /** The conversation so far, oldest first. */
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
     *  `callModel` is implemented by two adapters and consumed by the loop and turn-core, plus
     *  every test that injects a fake. A callback on
     *  the INPUT leaves all of them untouched: an adapter that ignores it behaves exactly as
     *  before, and `ModelTurn` stays the single source of truth for the final text, tool calls,
     *  truncation and cost. Nothing downstream reads deltas to make a decision.
     *
     *  Deltas are BEST EFFORT and non-authoritative: they may be coalesced, and an adapter or
     *  provider without streaming simply never calls this. NEVER accumulate them into the answer
     *  you persist — use the returned `ModelTurn.text`, which is always the complete reply. */
    onDelta?: (text: string) => void
    abortSignal?: AbortSignal
  }) => Promise<ModelTurn>
  /** Execute one tool server-side. Errors are RETURNED as text, never thrown — a failing tool
   *  is information the model should react to, not a reason to lose the whole run. */
  executeTool: (name: string, input: unknown) => Promise<unknown>
  /** Hard ceiling on model turns. Bounds spend and wall-clock on a model that loops calling
   *  tools forever; without it a stuck run costs money until the lease expires. */
  maxTurns?: number
  abortSignal?: AbortSignal
  /** A durable question stops the run before another model call or effect. */
  shouldStop?: () => boolean
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

/**
 * How much tool output ONE RUN may put in front of the model, across every turn.
 *
 * The broker caps a single result, which stops one call from blowing the window. It does not stop
 * TWELVE calls from doing it together, and a run that reads a corpus per turn will do exactly
 * that. Watched on a real cloud MCP: one `read_wiki_contents` produced a 1,040,577-token prompt
 * against a 1,048,576-token limit, and every later turn failed identically until the turn budget
 * ran out — so the run paid twelve times to learn nothing.
 *
 * 240k characters is roughly 60k tokens: room for several substantial reads, and far enough below
 * any current context window that the remaining turns still have somewhere to live.
 */
export const TOOL_OUTPUT_BUDGET_CHARS = 240_000

/**
 * Clip one tool result to what the run can still afford, and SAY what is left.
 *
 * The number matters more than the truncation. A model told only "truncated" reasonably tries the
 * same call again with different arguments — which is how a run spends its remaining turns
 * re-reading things it cannot keep. A model told it has 12,000 characters left asks a smaller
 * question, or writes with what it has.
 */
const clipToBudget = (text: string, remaining: number): { text: string; used: number } => {
  if (text.length <= remaining) return { text, used: text.length }
  if (remaining <= 0)
    return {
      text: "[no tool-output budget left for this run — answer with what you already have, and do not call another tool]",
      used: 0,
    }
  return {
    text: `${text.slice(0, remaining)}\n\n…[truncated ${text.length - remaining} characters: this run's tool-output budget is spent. Answer with what you have rather than calling again.]`,
    used: remaining,
  }
}

/** A truncated reply, duck-typed. TruncatedReplyError (lib/model-openai) carries `truncated`;
 *  matching on the property rather than importing the class keeps this file free of the
 *  provider adapters that depend on IT. */
const wasTruncated = (e: unknown): boolean =>
  !!e && typeof e === "object" && (e as { truncated?: unknown }).truncated === true

/** Adapt the existing provider seam to the SDK. No transport or tool loop lives here. */
export const runAgentLoop = async (input: AgentLoopInput): Promise<AgentLoopResult> => {
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS
  let costUsd: number | null = null
  let turns = 0
  let toolChars = 0
  let serial = Promise.resolve()
  const model: LanguageModel = {
    specificationVersion: "v3",
    provider: "derive",
    modelId: "resolved",
    supportedUrls: {},
    async doGenerate(request) {
      input.abortSignal?.throwIfAborted()
      const messages: ModelMessage[] = []
      let system = ""
      for (const m of request.prompt) {
        if (m.role === "system") {
          system += `${m.content}\n`
          continue
        }
        if (m.role === "tool") {
          messages.push({
            role: "user",
            content: m.content
              .filter((p) => p.type === "tool-result")
              .map((p) => ({
                tool_use_id: p.toolCallId,
                content: "value" in p.output ? p.output.value : JSON.stringify(p.output),
              })),
          })
        } else {
          const calls = m.content.filter((p) => p.type === "tool-call")
          messages.push({
            role: m.role,
            content: calls.length
              ? [
                  ...m.content
                    .filter((p) => p.type === "text")
                    .map((p) => ({ type: "text", text: p.text })),
                  ...calls.map((p) => ({ id: p.toolCallId, name: p.toolName, input: p.input })),
                ]
              : m.content
                  .filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join("\n"),
          })
        }
      }
      turns += 1
      const r = await input.callModel({
        system,
        messages,
        abortSignal: input.abortSignal,
        tools: (request.tools ?? [])
          .filter((t) => t.type === "function")
          .map((t) => ({
            name: t.name,
            description: t.description ?? "",
            params: t.inputSchema,
          })),
      })
      costUsd = addCostUsd(costUsd, r.costUsd)
      return {
        content: [
          ...(r.text ? [{ type: "text" as const, text: r.text }] : []),
          ...r.toolUses.map((t) => ({
            type: "tool-call" as const,
            toolCallId: t.id,
            toolName: t.name,
            input: JSON.stringify(t.input ?? {}),
          })),
        ],
        finishReason: { unified: r.toolUses.length ? "tool-calls" : "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: undefined,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }
    },
    async doStream() {
      throw new Error("Derive uses buffered model steps")
    },
  }
  const tools = Object.fromEntries(
    input.tools.map((t) => [
      t.name,
      {
        description: t.description,
        inputSchema: jsonSchema(t.params as Parameters<typeof jsonSchema>[0], {
          validate: (value: unknown) => ({ success: true as const, value }),
        }),
        execute: async (args: unknown) => {
          const prior = serial
          let release: () => void = () => {}
          serial = new Promise<void>((resolve) => {
            release = resolve
          })
          await prior
          try {
            input.abortSignal?.throwIfAborted()
            if (input.shouldStop?.())
              return { error: "The run is paused for your answer. No further tools ran." }
            let text: string
            try {
              text = resultText(await input.executeTool(t.name, args))
            } catch (e) {
              return resultText(e)
            }
            const clipped = clipToBudget(text, TOOL_OUTPUT_BUDGET_CHARS - toolChars)
            toolChars += clipped.used
            return clipped.text
          } finally {
            release()
          }
        },
      },
    ]),
  )
  let messages: SdkMessage[] = asMessages("", input.messages).slice(1)
  try {
    for (let nudge = 0; nudge <= NUDGE_LIMIT && turns < maxTurns; nudge += 1) {
      const r = await generateText({
        model,
        system: input.system,
        messages,
        tools,
        maxRetries: 0,
        abortSignal: input.abortSignal,
        stopWhen: [stepCountIs(maxTurns - turns), () => input.shouldStop?.() === true],
        prepareStep: () => (turns >= maxTurns - 1 ? { activeTools: [], toolChoice: "none" } : {}),
      })
      const read = input.contract.read(r.text)
      if (read.product) return { ok: true, product: read.product, costUsd, turns }
      if (turns >= maxTurns && r.steps.some((step) => step.toolCalls.length > 0))
        return {
          ok: false,
          reason: "turns",
          error: `agent did not finish within ${maxTurns} turns`,
          retryable: false,
          costUsd,
          turns,
        }
      if (nudge === NUDGE_LIMIT || turns >= maxTurns)
        return {
          ok: false,
          reason: "contract",
          error: read.miss.detail,
          ...(read.miss.reply ? { reply: read.miss.reply } : {}),
          retryable: false,
          costUsd,
          turns,
        }
      messages = [...messages, ...r.response.messages, { role: "user", content: read.miss.nudge }]
    }
    return {
      ok: false,
      reason: "turns",
      error: `agent exceeded ${maxTurns} steps`,
      retryable: false,
      costUsd,
      turns,
    }
  } catch (e) {
    return {
      ok: false,
      reason: wasTruncated(e) ? "truncated" : "model",
      error: e instanceof Error ? e.message : String(e),
      retryable: !wasTruncated(e),
      costUsd,
      turns,
    }
  }
}
