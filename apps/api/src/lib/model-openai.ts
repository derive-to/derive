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

interface ToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

/** Same stance as the Anthropic client: usage is reported, cost is not, and a hardcoded rate
 *  table drifts silently. Null means UNKNOWN, which the budget skips. */
const costOf = (): number | null => null

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
      // A tool RESULT block carries the payload the model needs to keep going; losing it would
      // silently truncate the conversation rather than fail loudly.
      if (o.type === "tool_result") return typeof o.content === "string" ? o.content : ""
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

export const openAiCompatModel = (opts: OpenAiCompatOptions): AgentLoopInput["callModel"] => {
  const doFetch = opts.fetchImpl ?? fetch
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`
  return async ({ system, messages, tools }): Promise<ModelTurn> => {
    const res = await doFetch(url, {
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
          ...(messages as ModelMessage[]).map((m) => ({
            role: m.role,
            content: flatten(m.content),
          })),
        ],
        ...(tools.length ? { tools: asTools(tools), tool_choice: "auto" } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      // Thrown, not returned — the loop treats a failed model CALL as retryable, which is the
      // right judgement for a 429 or a 5xx. Same contract as the Anthropic client.
      throw new Error(`model call failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
    }
    const body = (await res.json()) as {
      choices?: {
        message?: { content?: string | null; tool_calls?: ToolCall[] }
        finish_reason?: string
      }[]
    }
    const choice = body.choices?.[0]
    const calls = choice?.message?.tool_calls ?? []
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
      costUsd: costOf(),
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
