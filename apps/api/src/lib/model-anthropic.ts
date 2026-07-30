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

/** OAuth (a `claude setup-token` plan token) is a BEARER credential, and the Messages API only
 *  accepts one with this beta opt-in. Without it a perfectly valid plan token 401s. */
const OAUTH_BETA = "oauth-2025-04-20"

/**
 * The model this executor talks to when nothing names one.
 *
 * It is an ANTHROPIC model id, and that is the whole point of the constant. The deploy-level
 * `DERIVE_MODEL_NAME` is the GATEWAY's model id (a Fireworks path, an OpenRouter slug), and it
 * used to be handed to this client, which 404s `model_not_found` on every hosted run of every
 * deployment that had set it — which DEPLOY.md tells operators to do, for chat.
 *
 * Sonnet for the reason the CLI runner defaults to it: an automation is latency- and
 * tool-call-bound, so depth buys less than turnaround. `DERIVE_LOOP_MODEL` overrides it.
 */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5"

/**
 * A connected Claude plan, as the payer chain hands it over.
 *
 * The KIND is load-bearing, and used to be dropped on the floor: a plan token (`oauth`, the
 * DEFAULT option in the connect UI) was sent as `x-api-key`, which 401s. The CLI runner has
 * always got this right by mapping kind → env var (CLAUDE_CODE_OAUTH_TOKEN vs
 * ANTHROPIC_API_KEY — packages/cli/src/providers/claude-code.js). This is the same mapping
 * expressed as HEADERS, because there is no CLI here to read an environment.
 */
export type AnthropicCredential =
  | { kind: "api_key"; value: string }
  | { kind: "oauth"; value: string }

export interface AnthropicOptions {
  credential: AnthropicCredential
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

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/**
 * USD per MILLION tokens, by EXACT model id.
 *
 * Small and explicit on purpose. The API reports usage, not cost, so something has to hold the
 * rates — and the alternative to a short reviewed table is what was here before: `() => null`,
 * unconditionally, which made `sumRunCostSince` sum zero and `overBudget` return false for
 * every workspace on every check. A ceiling that cannot be reached is not a ceiling.
 *
 * Matched EXACTLY rather than by family prefix: a wrong rate silently bills a wrong number, and
 * "we do not know what this model costs" is a fact worth reporting honestly. An unlisted model
 * prices as null — UNKNOWN, which the budget skips — for THAT model only, not for all of them.
 */
const RATES: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
}

/** Cache reads bill at a tenth of input, cache writes at 1.25x (the 5-minute TTL). Folded in
 *  because the fields ride every usage block, not because this executor caches today. */
const CACHE_READ = 0.1
const CACHE_WRITE = 1.25

const costOf = (model: string, usage: Usage | undefined): number | null => {
  const rate = RATES[model]
  if (!rate || !usage) return null
  const usd =
    ((usage.input_tokens ?? 0) * rate.in +
      (usage.cache_creation_input_tokens ?? 0) * rate.in * CACHE_WRITE +
      (usage.cache_read_input_tokens ?? 0) * rate.in * CACHE_READ +
      (usage.output_tokens ?? 0) * rate.out) /
    1_000_000
  return Number.isFinite(usd) ? usd : null
}

/** Kind → wire auth. An API key rides `x-api-key`; a plan/OAuth token rides
 *  `authorization: Bearer` PLUS the oauth beta opt-in. */
const authHeaders = (c: AnthropicCredential): Record<string, string> =>
  c.kind === "oauth"
    ? { authorization: `Bearer ${c.value}`, "anthropic-beta": OAUTH_BETA }
    : { "x-api-key": c.value }

export const anthropicModel = (opts: AnthropicOptions): AgentLoopInput["callModel"] => {
  const doFetch = opts.fetchImpl ?? fetch
  const model = opts.model ?? DEFAULT_ANTHROPIC_MODEL
  return async ({ system, messages, tools }): Promise<ModelTurn> => {
    const res = await doFetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": VERSION,
        ...authHeaders(opts.credential),
      },
      body: JSON.stringify({
        model,
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
      usage?: Usage
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
      costUsd: costOf(model, body.usage),
      done: body.stop_reason !== "tool_use",
    }
  }
}
