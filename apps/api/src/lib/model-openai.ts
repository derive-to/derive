import type { AgentLoopInput, LoopTool, ModelMessage, ModelTurn } from "./agent-loop"

/**
 * The same one turn, against an OPENAI-COMPATIBLE endpoint (`/chat/completions`).
 *
 * Sibling of model-anthropic.ts, and deliberately the same shape: plain fetch, no SDK, so it runs
 * unchanged on Node and inside a Worker. Both return `AgentLoopInput["callModel"]`, so everything
 * downstream — the loop, the turn, the substrate — takes either without knowing which.
 *
 * This exists because "OpenAI-compatible" is the format almost every non-Anthropic host speaks
 * (Fireworks, OpenRouter, Together, vLLM, and self-hosted gateways), so ONE adapter reaches all of
 * them. The differences from the Anthropic call are not cosmetic and are the whole reason a second
 * file is needed rather than a base-URL switch:
 *
 *   - The system prompt is a MESSAGE with role "system", not a top-level field.
 *   - Tool calls come back as `tool_calls` with a JSON-STRING `arguments`, not a parsed object.
 *   - Auth is `Authorization: Bearer`, not `x-api-key`.
 *   - Assistant tool-call turns and tool RESULTS are shaped differently on the way back in.
 */

export interface OpenAiCompatOptions {
  apiKey: string
  /** Root of the API, e.g. `https://api.example.com/v1`. `/chat/completions` is appended. */
  baseUrl: string
  model: string
  maxTokens?: number
  /** Injected in tests so the turn mapping is exercised without a key or a network. */
  fetchImpl?: typeof fetch
}

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

interface ToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

/** The non-streaming chat-completions response. A streamed response is reassembled into exactly
 *  this shape (see `readStream`) so the two transports share one parser. */
interface CompletionBody {
  choices?: {
    message?: { content?: string | null; tool_calls?: ToolCall[] }
    finish_reason?: string
  }[]
  usage?: { cost?: unknown }
}

/** One `data:` frame of a streamed completion. Tool calls arrive in fragments addressed by
 *  `index`, with `name` on the first fragment and `arguments` split across later ones. */
interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: { cost?: unknown }
}

/**
 * Reassemble a streamed completion into the buffered response shape, calling `onDelta` with
 * assistant text as it arrives.
 *
 * Text is emitted as it comes; TOOL CALLS ARE NOT. A tool call's `arguments` is JSON split
 * across frames at arbitrary boundaries, so a partial fragment is not parseable and is never
 * useful to show — it is accumulated silently and parsed once at the end, exactly as the
 * buffered path does.
 *
 * `onDelta` is caller code running inside our read loop: it is wrapped so a throw there cannot
 * abort the stream and lose a reply that the model has already been paid for.
 */
async function readStream(res: Response, onDelta: (text: string) => void): Promise<CompletionBody> {
  const body = res.body
  // No body at all is a broken response, not an empty answer. Returning a tidy "" here would
  // hand the contract a finished, blank reply; the buffered branch throws on this, and the
  // loop's retry is the right judgement for both.
  if (!body) throw new Error("model stream had no body")
  const reader = body.getReader()
  const decode = new TextDecoder()
  let buffered = ""
  let text = ""
  let finish: string | undefined
  let usage: { cost?: unknown } | undefined
  // Did the provider actually tell us the answer ENDED? See the throw at the bottom.
  let sawTerminal = false
  // Keyed by the frame's `index` so two concurrent tool calls cannot interleave into one.
  const calls = new Map<number, { id?: string; name?: string; args: string }>()
  // The last index we saw. A fragment that omits `index` continues the call it was already
  // building — defaulting to 0 instead would staple its arguments onto an unrelated call.
  let lastIndex = 0

  const emit = (chunk: string) => {
    try {
      onDelta(chunk)
    } catch {
      /* a listener that throws must not cost us the rest of the reply */
    }
  }

  const handle = (frame: string) => {
    // An SSE event is a set of LINES, and only the `data:` ones carry payload. Testing
    // `startsWith` on the whole frame drops any event that leads with `event:`, `id:` or a
    // `:` comment — spec-legal shapes a proxy or self-hosted gateway really does emit — and
    // silently yields an empty answer. Multiple `data:` lines in one event are joined with a
    // newline, which is what the spec says they mean.
    const payload = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim()
    if (!payload) return
    // The terminal sentinel, not JSON.
    if (payload === "[DONE]") {
      sawTerminal = true
      return
    }
    let parsed: StreamChunk
    try {
      parsed = JSON.parse(payload) as StreamChunk
    } catch {
      return // a malformed frame is skipped, not fatal — the rest of the reply still arrives
    }
    if (parsed.usage) usage = parsed.usage
    const choice = parsed.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) {
      finish = choice.finish_reason
      sawTerminal = true
    }
    const piece = choice.delta?.content
    if (piece) {
      text += piece
      emit(piece)
    }
    for (const t of choice.delta?.tool_calls ?? []) {
      const i = t.index ?? lastIndex
      lastIndex = i
      const slot = calls.get(i) ?? { args: "" }
      if (t.id) slot.id = t.id
      if (t.function?.name) slot.name = t.function.name
      if (t.function?.arguments) slot.args += t.function.arguments
      calls.set(i, slot)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decode.decode(value, { stream: true })
      // Frames are separated by a blank line; the trailing partial stays buffered for the
      // next read rather than being parsed half-formed.
      const parts = buffered.split(/\r?\n\r?\n/)
      buffered = parts.pop() ?? ""
      for (const p of parts) handle(p.trim())
    }
    if (buffered.trim()) handle(buffered.trim())
  } finally {
    // CANCEL, not just releaseLock. Releasing the lock leaves the underlying body un-cancelled,
    // so the producer's teardown never runs and the subrequest is left open on workerd — the
    // leak this `finally` was meant to prevent. cancel() releases the lock as part of its
    // contract, so it covers both.
    await reader.cancel().catch(() => {})
  }

  // A STREAM THAT JUST STOPS IS A FAILURE, NOT A SHORT ANSWER. Without a terminal signal
  // (`finish_reason`, or the `[DONE]` sentinel) the reply is simply however much arrived before
  // the gateway died, a proxy timed out, or the final chunk was dropped. The buffered branch
  // could never reach here — `res.json()` throws on a truncated body — and the loop reads that
  // throw as a retryable model failure, which is the right judgement for both transports.
  //
  // Two things go wrong if this is allowed through. The truncation guard below keys on
  // `finish_reason === "length"`, so a lost final frame silently disables the one check that
  // stops a half-written document being treated as a finished reply. And a retryable transport
  // fault gets laundered into a "the model answered" outcome that the contract then rejects as
  // unretryable, killing the run instead of trying again.
  if (!sawTerminal) throw new Error("model stream ended without a terminal frame")

  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, c]) => ({
      id: c.id ?? `call_${i}`,
      type: "function",
      function: { name: c.name, arguments: c.args },
    }))
  return {
    choices: [
      {
        message: { content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: finish,
      },
    ],
    usage,
  }
}

/**
 * What the turn cost, when the endpoint says so.
 *
 * Deliberately NOT a rate table, unlike the Anthropic client's. "OpenAI-compatible" is a wire
 * format, not a provider: this one adapter reaches Fireworks, OpenRouter, Together, vLLM and any
 * self-hosted gateway, and the same model id prices differently on each — so a table here would
 * be a guess about somebody else's price list, which is worse than saying nothing.
 *
 * Several of those hosts (OpenRouter among them) DO report `usage.cost` in USD, so read it when
 * it is there. Absent or unparseable, null means UNKNOWN, which the budget skips — and this is
 * the GATEWAY lane, where one ambient key means the operator pays for the whole instance and the
 * payer chain is bypassed by design, so an unpriced turn matters far less here than on the
 * per-run credential path (which is priced — see model-anthropic.ts).
 */
const costOf = (usage: { cost?: unknown } | undefined): number | null => {
  const cost = usage?.cost
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null
}

const asTools = (tools: LoopTool[]) =>
  tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters:
        t.params && typeof t.params === "object" && "type" in t.params
          ? t.params
          : { type: "object", properties: t.params ?? {} },
    },
  }))

/**
 * One turn of tool use, translated into the chat-completions shape.
 *
 * THE LOOP SPEAKS ANTHROPIC. After a tool call it appends the assistant's `toolUses`
 * (`{id, name, input}`) as one message, then the results (`{tool_use_id, content}`) as the next.
 * Chat-completions wants neither: an assistant turn carries `tool_calls` with a JSON-STRING
 * `arguments`, and every result is its OWN `role: "tool"` message keyed by `tool_call_id`.
 *
 * Until this existed, both were run through `flatten`, which matches on `type` — and neither
 * block carries one. So both became the empty string: the model's own tool call disappeared from
 * the history, and so did the answer. Every turn it asked again, saw nothing, and asked again,
 * until the loop ran out of turns and reported "the agent did not produce a revision" — which
 * reads as a confused model and is really a conversation with its middle deleted. It broke EVERY
 * tool-using hosted run on a gateway deployment, for every kind of source, and no test caught it
 * because the loop's own tests inject `callModel` and never go through an adapter.
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

/** Chat-completions messages for one loop message — usually one, but a results block fans out to
 *  one `role: "tool"` message per result. */
const asMessages = (m: ModelMessage): Record<string, unknown>[] => {
  const blocks = Array.isArray(m.content) ? (m.content as unknown[]) : null
  if (blocks) {
    const results = blocks.filter(isToolResult)
    if (results.length)
      return results.map((r) => ({
        role: "tool",
        tool_call_id: r.tool_use_id,
        content: typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? ""),
      }))
    const uses = blocks.filter(isToolUse)
    if (uses.length)
      return [
        {
          role: "assistant",
          // Any prose the same turn produced rides along; null when there was none, which is
          // what the API expects for a pure tool-call turn.
          content: flatten(blocks.filter((b) => !isToolUse(b))) || null,
          tool_calls: uses.map((u) => ({
            id: u.id,
            type: "function",
            function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
          })),
        },
      ]
  }
  return [{ role: m.role, content: flatten(m.content) }]
}

/** Anthropic accepts a bare string OR an array of content blocks; the chat-completions shape wants
 *  a string. Flatten text blocks and drop the rest, so a conversation built for one provider does
 *  not arrive at the other as "[object Object]". */
const flatten = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content)
  return content
    .map((b) => {
      if (typeof b === "string") return b
      const o = b as { type?: string; text?: string; content?: unknown }
      if (o.type === "text" && typeof o.text === "string") return o.text
      // A properly-typed tool RESULT that carries no `tool_use_id` never reaches `asMessages`'
      // fan-out, so it would otherwise be dropped here — losing the payload the model needs to
      // keep going, silently, rather than failing loudly.
      if (o.type === "tool_result") return typeof o.content === "string" ? o.content : ""
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

export const openAiCompatModel = (opts: OpenAiCompatOptions): AgentLoopInput["callModel"] => {
  const doFetch = opts.fetchImpl ?? fetch
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`
  return async ({ system, messages, tools, onDelta }): Promise<ModelTurn> => {
    // Stream ONLY when someone is listening. Without `onDelta` this is byte-for-byte the
    // request it has always sent, so every non-streaming caller (the loop's own tests, the
    // substrate, automations) keeps the exact behaviour — and a gateway that does not support
    // SSE is only ever asked for one when a caller actually wants deltas.
    const wantStream = typeof onDelta === "function"
    const send = (stream: boolean) =>
      doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: opts.maxTokens ?? 8_000,
          messages: [
            { role: "system", content: system },
            ...(messages as ModelMessage[]).flatMap(asMessages),
          ],
          ...(tools.length ? { tools: asTools(tools), tool_choice: "auto" } : {}),
          // `stream_options` asks the gateway to send a final usage frame, which a stream
          // otherwise omits — without it every streamed turn would report cost as unknown.
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
        signal: AbortSignal.timeout(120_000),
      })

    let res = await send(wantStream)
    // STREAMING MUST NEVER MAKE A REQUEST FAIL THAT WOULD OTHERWISE HAVE SUCCEEDED.
    //
    // "OpenAI-compatible" is a wire format, not a guarantee: plenty of gateways this adapter
    // exists to reach (older vLLM, some Azure api-versions, hand-rolled proxies) reject the
    // unknown `stream_options` field, or SSE itself, with a 4xx. Without this retry the ONLY
    // lane that asks for a stream — attended chat — would break on those deployments while
    // every other lane kept working, which is a baffling thing to debug and a regression
    // against behaviour that shipped fine before. One buffered retry costs a round trip on a
    // request that already failed, and the person just loses the animation.
    let streamed = wantStream
    if (wantStream && !res.ok && res.status >= 400 && res.status < 500) {
      res = await send(false)
      streamed = false
    }
    if (!res.ok) {
      // Thrown, not returned — the loop treats a failed model CALL as retryable, which is the
      // right judgement for a 429 or a 5xx. Same contract as the Anthropic client.
      throw new Error(`model call failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
    }
    // A gateway may also honour the request and answer with ordinary JSON anyway. Trust the
    // content type over what we asked for: parsing a JSON body as SSE finds no `data:` frames
    // and would yield a silent empty reply.
    if (streamed && !(res.headers.get("content-type") ?? "").includes("text/event-stream"))
      streamed = false
    // A streamed response is reassembled into the SAME shape the buffered branch parses below,
    // so everything after this point — truncation, tool calls, cost, `done` — is one code path
    // and cannot drift between streaming and non-streaming callers.
    const body = streamed
      ? await readStream(res, onDelta as (t: string) => void)
      : ((await res.json()) as CompletionBody)
    const choice = body.choices?.[0]
    const calls = choice?.message?.tool_calls ?? []
    // TRUNCATION IS NOT A REPLY. The revision contract asks for the COMPLETE document back, so
    // a long doc can hit the token ceiling mid-`<revision>`. Unchecked, the caller sees a reply
    // with no closing tag, treats it as prose, and pastes tens of kilobytes of raw JSON into the
    // conversation as the "answer". Thrown (not returned) so it reads as a retryable failure,
    // the same as any other bad response from the provider.
    if (choice?.finish_reason === "length") throw new TruncatedReplyError()
    return {
      text: choice?.message?.content ?? "",
      toolUses: calls
        .filter((t) => t.function?.name)
        .map((t, i) => ({
          // `arguments` is a JSON STRING here, unlike Anthropic's parsed object. A model that
          // emits malformed JSON must not crash the whole run: hand the tool an empty input and
          // let it fail on its own terms, which the loop already reports back to the model.
          id: t.id ?? `call_${i}`,
          name: t.function?.name as string,
          input: parseArgs(t.function?.arguments),
        })),
      costUsd: costOf(body.usage),
      done: choice?.finish_reason !== "tool_calls" && calls.length === 0,
    }
  }
}

const parseArgs = (raw: string | undefined): unknown => {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
