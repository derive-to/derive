import type { AgentLoopInput, ModelTurn } from "./agent-loop"

/**
 * The model call, as plain fetch against the Messages API.
 *
 * No SDK on purpose. This has to run on Node AND inside a Cloudflare Worker, and `fetch` is the
 * only thing both have — pulling in a provider SDK is exactly what would make the Worker path a
 * separate implementation (and a bundle problem). One file, both runtimes.
 *
 * The loop owns the conversation; this owns one turn: send the messages, read back the text, the
 * tool calls, and what it cost.
 */

const API = "https://api.anthropic.com/v1/messages"
const VERSION = "2023-06-01"

export interface AnthropicOptions {
  apiKey: string
  model?: string
  maxTokens?: number
  /** Injected in tests so the turn mapping can be exercised without a key or a network. */
  fetchImpl?: typeof fetch
}

interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}

/** Per-token prices are not modelled: the API reports usage, not cost, and guessing a rate that
 *  drifts is worse than reporting nothing. Null means UNKNOWN, which the budget skips. */
const costOf = (): number | null => null

export const anthropicModel = (opts: AnthropicOptions): AgentLoopInput["callModel"] => {
  const doFetch = opts.fetchImpl ?? fetch
  return async ({ system, messages, tools }): Promise<ModelTurn> => {
    const res = await doFetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": VERSION,
      },
      body: JSON.stringify({
        model: opts.model ?? "claude-sonnet-5",
        max_tokens: opts.maxTokens ?? 8_000,
        system,
        messages,
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema:
                  t.params && typeof t.params === "object" && "type" in t.params
                    ? t.params
                    : { type: "object", properties: t.params ?? {} },
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      // Thrown, not returned: the loop treats a failed model CALL as retryable (the expensive
      // part has not happened yet), which is the right judgement for a 429 or a 5xx.
      throw new Error(`model call failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
    }
    const body = (await res.json()) as {
      content?: ContentBlock[]
      stop_reason?: string
    }
    const blocks = body.content ?? []
    return {
      // Concatenated: a turn can interleave several text blocks, and the revision block may be
      // split across them.
      text: blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join(""),
      toolUses: blocks
        .filter((b) => b.type === "tool_use" && b.id && b.name)
        .map((b) => ({ id: b.id as string, name: b.name as string, input: b.input })),
      costUsd: costOf(),
      done: body.stop_reason !== "tool_use",
    }
  }
}
