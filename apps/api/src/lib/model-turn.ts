import {
  APICallError,
  generateText,
  jsonSchema,
  type LanguageModel,
  streamText,
  type ToolSet,
} from "ai"
import type { AgentLoopInput, LoopTool, ModelTurn } from "./agent-loop"
import { asMessages } from "./model-messages"

/** Shared provider transport. The SDK handles wire formats and streams.
 * Truncation fails the turn. Malformed calls become tool errors. Costs are never guessed.
 * Gateways that reject streaming receive one buffered retry. */

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

/** How long draining a stream may take before this code gives up on it, independent of whether
 *  the SDK's own `abortSignal` (120s, on `req` below) actually fires. 10s past that, so the SDK
 *  gets first right of way — this is the backstop for when it does not. */
const STREAM_DEADLINE_MS = 130_000

/** Not an APICallError, so a caller's `APICallError.isInstance` check correctly says no — a
 *  stalled drain is OUR verdict, never the provider's, and must fall to the same buffered retry a
 *  gateway that cannot stream at all already gets. */
class StreamStalledError extends Error {
  constructor(ms: number) {
    super(`stream produced nothing for ${ms}ms`)
    this.name = "StreamStalledError"
  }
}

/** Race a promise against a hard deadline. The loser keeps running (there is no cancelling a
 *  `for await` from outside it), but nothing here waits on it any longer. */
const withDeadline = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new StreamStalledError(ms)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })

/** Provider calls return tool requests without execution.
 * The shared runtime registers executors and bounds SDK steps.
 * Tool handlers validate arguments and return errors the model can act on. */
const passThrough = (value: unknown) => ({ success: true as const, value })

type JsonSchemaArg = Parameters<typeof jsonSchema>[0]

const schemaOf = (params: Record<string, unknown> | undefined): JsonSchemaArg =>
  (params && typeof params === "object" && "type" in params
    ? params
    : { type: "object", properties: params ?? {} }) as JsonSchemaArg

const asTools = (tools: LoopTool[]): ToolSet =>
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
  return async ({ system, messages, tools, onDelta, abortSignal }): Promise<ModelTurn> => {
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
      abortSignal: abortSignal
        ? AbortSignal.any([abortSignal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
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

    // Stream ONLY when someone is listening, so every non-streaming caller (the loop's tests, a
    // comment or Slack turn) makes the same request it always has, and a gateway that cannot do
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
      const drain = async () => {
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
        // failure and answer, leaving the asker with no reply and no error.
        const handled = <T>(p: PromiseLike<T>): Promise<T> => {
          const q = Promise.resolve(p)
          q.catch(() => {})
          return q
        }
        return Promise.all([
          handled(stream.text),
          handled(stream.toolCalls),
          handled(stream.finishReason),
          handled(stream.finalStep),
        ])
      }
      // A DEADLINE THIS CODE OWNS, independent of the SDK's own `abortSignal` above.
      //
      // Reproduced live (2026-08-03, PR #633, against a real gateway): a turn's `for await` over
      // `stream.textStream` never yielded another chunk and never threw — no error, no `onError`
      // call, nothing — so the abort at req.abortSignal either never fired against this gateway's
      // connection or fired somewhere the async iterator never observed it. Confirmed idle 9+
      // minutes with zero log output. The comment this replaced already suspected this exact
      // shape ("a preview turn hung in exactly that state... never reproduced") and left a
      // mitigation for the case the SDK's OWN promises reject; it did nothing for the case where
      // nothing ever rejects at all. This is the backstop for that: however the gateway or the
      // SDK misbehaves, draining the stream cannot block the turn past STREAM_DEADLINE_MS. A
      // timeout here is not an APICallError, so the catch below falls to the buffered retry —
      // the same recovery already used for a gateway that cannot stream at all.
      const [text, toolCalls, finishReason, finalStep] = await withDeadline(
        drain(),
        STREAM_DEADLINE_MS,
      )
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
