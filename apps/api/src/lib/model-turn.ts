import {
  APICallError,
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage as SdkMessage,
  streamText,
  type ToolSet,
} from "ai"
import type { AgentLoopInput, LoopTool, ModelMessage, ModelTurn } from "./agent-loop"

/**
 * ONE TURN, for every provider.
 *
 * There are two ways to reach a model from here — an operator's OpenAI-compatible gateway
 * (model-openai.ts) and a workspace's own Claude plan (model-anthropic.ts) — and they used to be
 * two hand-written HTTP clients with two SSE readers, two message mappings and two ideas about
 * what a truncated reply meant. The wire formats genuinely differ, so the duplication looked
 * forced; what actually differed was only ever the wire, and the AI SDK already owns that.
 *
 * So this file is everything that is NOT the wire: how the loop's vocabulary maps onto a model
 * call, and what our contract says about the answer. The provider files below it now say only
 * which endpoint, which credential, and how a turn is priced.
 *
 * WHAT THIS FILE IS NOT is an HTTP client, an SSE parser or a tool-call reassembler. Those were
 * ~600 lines across the two adapters, every one of them a place a production bug had already
 * lived: frames split at arbitrary boundaries, `data:` lines that are not the first line of an
 * event, tool-call fragments addressed by an index some gateways omit, readers left uncancelled
 * on workerd. None of it is ours to be right about. The SDK runs unchanged on Node and inside a
 * Worker — proved in test/worker/model-openai-workerd.test.ts, because Derive ships both.
 *
 * WHAT WE STILL DECIDE, because it is judgement about OUR contract rather than about the wire:
 * truncation is a failure and not a short answer; a malformed tool call costs one tool call and
 * not the run; cost is reported when it is known and never guessed; and a gateway that rejects
 * streaming still gets to answer.
 */

/** The reply hit the token ceiling. Its own type because the CALLER has to tell it apart from a
 *  network failure: one is "try again", the other is "this will never fit", and telling a person
 *  to retry something that cannot succeed is worse than saying nothing. */
export class TruncatedReplyError extends Error {
  readonly truncated = true
  constructor() {
    super("model reply hit the token ceiling before it finished")
    this.name = "TruncatedReplyError"
  }
}

/**
 * The tools this turn may call, as the SDK's tool set.
 *
 * NO `execute`. That is the load-bearing detail: a tool with no executor makes the SDK return the
 * call and stop, which is precisely the loop we already have — `agent-loop.ts` owns the turn
 * budget, the tool-output ceiling, the nudge, the announced last turn and tool withdrawal.
 * Handing that to the SDK's own multi-step loop would trade a policy we test for one we configure.
 *
 * VALIDATION IS A PASS-THROUGH, for the same reason neither adapter ever validated: the model's
 * arguments are the TOOL's problem, and a tool that receives nonsense fails with a message the
 * model can act on, whereas a rejected call fails the turn with a message only we can read.
 */
const passThrough = (value: unknown) => ({ success: true as const, value })

type JsonSchemaArg = Parameters<typeof jsonSchema>[0]

const schemaOf = (params: Record<string, unknown> | undefined): JsonSchemaArg =>
  (params && typeof params === "object" && "type" in params
    ? params
    : { type: "object", properties: params ?? {} }) as JsonSchemaArg

export const asTools = (tools: LoopTool[]): ToolSet =>
  Object.fromEntries(
    tools.map((t) => [
      t.name,
      {
        description: t.description,
        inputSchema: jsonSchema(schemaOf(t.params), { validate: passThrough }),
      },
    ]),
  )

/**
 * One turn of tool use, translated for the SDK.
 *
 * THE LOOP SPEAKS ANTHROPIC. After a tool call it appends the assistant's `toolUses`
 * (`{id, name, input}`) as one message, then the results (`{tool_use_id, content}`) as the next.
 * Both need naming and re-shaping here, and the failure when they are not is not loud: an earlier
 * version flattened both to the empty string, so the model's own tool call vanished from the
 * history along with its answer. It asked again, saw nothing, asked again, and the run died of
 * turn exhaustion — reading as a confused model, and really a conversation with its middle
 * deleted. It broke every tool-using run on a gateway, and no loop test caught it because those
 * inject `callModel` and never reach an adapter.
 *
 * A tool RESULT must also carry the tool's NAME, which the loop's result block does not have, so
 * the assistant turn that requested it is what supplies it — hence one pass with a running map
 * rather than a per-message translation.
 */
interface ToolUseBlock {
  id: string
  name: string
  input?: unknown
}
interface ToolResultBlock {
  tool_use_id: string
  content?: unknown
}

const isToolUse = (b: unknown): b is ToolUseBlock =>
  !!b && typeof b === "object" && "id" in b && "name" in b
const isToolResult = (b: unknown): b is ToolResultBlock =>
  !!b && typeof b === "object" && "tool_use_id" in b

export const asMessages = (system: string, messages: ModelMessage[]): SdkMessage[] => {
  // THE SYSTEM PROMPT RIDES IN THE ARRAY rather than in the SDK's `system` option, for two
  // reasons that both matter. Each provider then puts it where its own API wants it (a
  // `role: "system"` message for chat-completions, a top-level field for Anthropic) without this
  // file knowing which. And it means the array is NEVER empty — the SDK rejects an empty prompt
  // outright, while a system-only call is an ordinary thing for a caller to make.
  const out: SdkMessage[] = [{ role: "system", content: system }]
  const nameById = new Map<string, string>()
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? (m.content as unknown[]) : null
    const results = blocks?.filter(isToolResult) ?? []
    if (results.length) {
      out.push({
        role: "tool",
        content: results.map((r) => ({
          type: "tool-result",
          toolCallId: r.tool_use_id,
          // Falls back rather than throwing: a result whose call we never saw is still the
          // model's own answer coming back, and dropping it is the failure described above.
          toolName: nameById.get(r.tool_use_id) ?? "tool",
          output: {
            type: "text",
            value: typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? ""),
          },
        })),
      })
      continue
    }
    const uses = blocks?.filter(isToolUse) ?? []
    if (uses.length && blocks) {
      for (const u of uses) nameById.set(u.id, u.name)
      // Any prose the same turn produced rides along, which is how a model that narrates before
      // calling a tool keeps its narration.
      const prose = flatten(blocks.filter((b) => !isToolUse(b)))
      out.push({
        role: "assistant",
        content: [
          ...(prose ? [{ type: "text" as const, text: prose }] : []),
          ...uses.map((u) => ({
            type: "tool-call" as const,
            toolCallId: u.id,
            toolName: u.name,
            input: u.input ?? {},
          })),
        ],
      })
      continue
    }
    out.push({ role: m.role, content: flatten(m.content) })
  }
  return out
}

/** Anthropic accepts a bare string OR an array of content blocks; a plain turn wants a string.
 *  Flatten text blocks and drop the rest, so a conversation built for one provider does not
 *  arrive at the other as "[object Object]". */
const flatten = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content)
  return content
    .map((b) => {
      if (typeof b === "string") return b
      const o = b as { type?: string; text?: string; content?: unknown }
      if (o.type === "text" && typeof o.text === "string") return o.text
      // A properly-typed tool RESULT carrying no `tool_use_id` never reaches the fan-out above,
      // so it would otherwise be dropped here — losing the payload the model needs to keep
      // going, silently, rather than failing loudly.
      if (o.type === "tool_result") return typeof o.content === "string" ? o.content : ""
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

/**
 * A tool call's input, as the TOOL will receive it.
 *
 * The SDK hands back whatever survived parsing, which for a model that emitted broken JSON is the
 * raw string it sent. A tool expecting an object would then see a string and fail in a way that
 * reads like OUR bug, so an unparseable input becomes an empty one — the tool reports the missing
 * argument back to the model in its own words, and the run continues. Losing one tool call to a
 * bad emission is cheap; losing the run to it is not.
 */
const inputOf = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw ?? {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * A tool call as the repair hook sees it. Declared structurally rather than imported from
 * `@ai-sdk/provider`, which is a TRANSITIVE dependency: reaching into one is the import that
 * breaks on a minor bump nobody in this repo chose. Fewer fields than the SDK's own type, which
 * is what makes it accept the SDK's.
 */
interface RepairableToolCall {
  type: "tool-call"
  toolCallId: string
  toolName: string
  input: string
}

/** A model that emits unparseable arguments must not crash the run: hand the tool an empty input
 *  and let it fail on its own terms, which the loop already reports back to the model. */
const emptyInput = async ({
  toolCall,
}: {
  toolCall: RepairableToolCall
}): Promise<RepairableToolCall> => ({ ...toolCall, input: "{}" })

/** A 4xx is the provider refusing what we ASKED FOR; a 5xx or a transport fault is it failing at
 *  what it accepted. Only the first is worth re-asking differently. */
const isRefusal = (err: unknown): boolean =>
  APICallError.isInstance(err) &&
  typeof err.statusCode === "number" &&
  err.statusCode >= 400 &&
  err.statusCode < 500

/**
 * The status and the body, in the message.
 *
 * The SDK's own error carries both as fields and renders a message from the provider's error
 * SCHEMA — which is empty whenever a host words its errors differently, and "OpenAI-compatible"
 * is exactly the population that does. An operator reading "429" and the first line of the body
 * in a log can act; an empty string sends them to a dashboard. Thrown, not returned: the loop
 * treats a failed model call as retryable, which is the right judgement for a 429 or a 5xx.
 */
const wrap = (err: unknown): unknown => {
  if (!APICallError.isInstance(err)) return err
  const body = (err.responseBody ?? err.message ?? "").slice(0, 300)
  return new Error(`model call failed (${err.statusCode ?? "?"}): ${body}`)
}

/** What a turn cost, from what the provider reported. Every provider answers this differently —
 *  some state a price, some state tokens and leave the arithmetic to us — and none of them should
 *  guess. Null means UNKNOWN, which the budget skips. */
export type PriceTurn = (r: {
  usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined
  providerMetadata: Record<string, Record<string, unknown>> | undefined
}) => number | null

export interface TurnOptions {
  model: LanguageModel
  maxTokens?: number
  price: PriceTurn
  /** Anthropic's Messages API has a different SSE shape and no watcher on the lanes it serves, so
   *  that provider opts out and answers whole — which the `callModel` contract explicitly allows. */
  stream?: boolean
}

export const turnFor = (opts: TurnOptions): AgentLoopInput["callModel"] => {
  return async ({ system, messages, tools, onDelta }): Promise<ModelTurn> => {
    const req = {
      model: opts.model,
      messages: asMessages(system, messages),
      allowSystemInMessages: true,
      maxOutputTokens: opts.maxTokens ?? 8_000,
      ...(tools.length ? { tools: asTools(tools) } : {}),
      repairToolCall: emptyInput,
      // The loop owns retries and failure classification, so the SDK must not silently re-ask
      // and turn one 429 into three.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(120_000),
    }

    const settle = (r: {
      text: string
      toolCalls: { toolCallId: string; toolName: string; input: unknown }[]
      finishReason: string
      usage: TurnUsage
      providerMetadata: Record<string, Record<string, unknown>> | undefined
    }): ModelTurn => {
      // TRUNCATION IS NOT A REPLY. The revision contract asks for the COMPLETE document back, so
      // a long doc can hit the ceiling mid-`<revision>`. Unchecked, the caller sees a reply with
      // no closing tag, treats it as prose, and pastes tens of kilobytes of raw JSON into the
      // conversation as the "answer". Thrown, so it reads as retryable like any other bad
      // response from the provider.
      if (r.finishReason === "length") throw new TruncatedReplyError()
      return {
        text: r.text,
        toolUses: r.toolCalls.map((c, i) => ({
          id: c.toolCallId || `call_${i}`,
          name: c.toolName,
          input: inputOf(c.input),
        })),
        costUsd: opts.price({ usage: r.usage, providerMetadata: r.providerMetadata }),
        done: r.finishReason !== "tool-calls" && r.toolCalls.length === 0,
      }
    }

    const buffered = async (): Promise<ModelTurn> => {
      const r = await generateText(req).catch((e) => {
        throw wrap(e)
      })
      return settle({
        text: r.text,
        toolCalls: r.toolCalls,
        finishReason: r.finishReason,
        usage: r.usage,
        providerMetadata: r.finalStep.providerMetadata,
      })
    }

    // Stream ONLY when someone is listening, so every non-streaming caller (the loop's tests, the
    // substrate, automations) makes the same request it always has — and a gateway that cannot do
    // SSE is only asked for it when a person is actually watching.
    if (opts.stream === false || typeof onDelta !== "function") return buffered()

    // The fault the SDK reports through `onError`, kept because the exception that then reaches
    // the catch below is a generic "no output" — the STATUS lives only here, and the status is
    // what decides whether re-asking is sensible.
    let fault: unknown
    try {
      const stream = streamText({
        ...req,
        onError: ({ error }) => {
          fault = error
        },
      })
      for await (const piece of stream.textStream) {
        try {
          onDelta(piece)
        } catch {
          /* a listener that throws must not cost us the rest of the reply */
        }
      }
      // EVERY ONE OF THESE IS MARKED HANDLED, even though only the first rejection is read.
      //
      // `Promise.all` rejects as soon as one does and abandons the rest — and a stream fault
      // rejects ALL of them, so three rejected promises would be left with no handler. Node
      // prints a warning and carries on, which is why no test here would ever notice (vitest
      // swallows the process event outright). workerd is stricter: an unhandled rejection can
      // tear down the request context, and an attended turn runs DETACHED inside one
      // (ctx.background → waitUntil), so the turn would die before the loop could classify the
      // failure and settle the session — leaving a transcript stuck in "working" with no error
      // and no retry.
      //
      // Written after a preview turn hung in exactly that state. That turn was never reproduced,
      // so this is the mechanism that FITS rather than one proven to have caused it; it is kept
      // because it is free and the hazard is real either way. `Promise.all` still rejects with
      // the first fault, and the catch below still decides what to do about it.
      const handled = <T>(p: PromiseLike<T>): Promise<T> => {
        const q = Promise.resolve(p)
        q.catch(() => {})
        return q
      }
      const [text, toolCalls, finishReason, finalStep] = await Promise.all([
        handled(stream.text),
        handled(stream.toolCalls),
        handled(stream.finishReason),
        handled(stream.finalStep),
      ])
      // NOTHING AT ALL is not an empty answer, it is a gateway that did not stream: it honoured
      // `stream: true` with ordinary JSON, which read as SSE yields no frames and no finish.
      // Asking again without the flag is the difference between an answer and a silent blank.
      if (!text && toolCalls.length === 0 && finishReason === "other") return buffered()
      return settle({
        text,
        toolCalls,
        finishReason,
        usage: finalStep.usage,
        providerMetadata: finalStep.providerMetadata,
      })
    } catch (err) {
      // STREAMING MUST NEVER MAKE A REQUEST FAIL THAT WOULD OTHERWISE HAVE SUCCEEDED. Plenty of
      // gateways this reaches (older vLLM, some Azure api-versions, hand-rolled proxies) reject
      // `stream_options` or SSE itself with a 4xx. Without this fallback the ONE lane that
      // streams, attended chat, breaks on those deployments while every other lane keeps working:
      // a baffling thing to debug, and a regression against what shipped before. One buffered
      // retry costs a round trip on a request that already failed, and the person just loses the
      // animation.
      //
      // A truncated reply is a real ANSWER and must escape; so must a 5xx, where re-asking a
      // struggling host immediately is the wrong instinct and the loop's retry is better placed.
      if (err instanceof TruncatedReplyError) throw err
      const cause = fault ?? err
      if (APICallError.isInstance(cause) && !isRefusal(cause)) throw wrap(cause)
      return buffered()
    }
  }
}

type TurnUsage = Parameters<PriceTurn>[0]["usage"]
