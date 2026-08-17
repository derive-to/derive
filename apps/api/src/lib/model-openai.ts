import { createOpenAICompatible, type MetadataExtractor } from "@ai-sdk/openai-compatible"
import type { AgentLoopInput } from "./agent-loop"
import { type PriceTurn, turnFor } from "./model-turn"

/**
 * The one turn, against an OPENAI-COMPATIBLE endpoint (`/chat/completions`).
 *
 * "OpenAI-compatible" is the format almost every host speaks (Fireworks, OpenRouter, Together,
 * vLLM, self-hosted gateways), so ONE adapter reaches all of them: a base URL, a key, a model
 * name. That is the whole configuration on this deploy, and adding a model is DATA rather than
 * code — see model-catalog.ts.
 *
 * Everything about how a turn is conducted lives in model-turn.ts, shared with the Claude-plan
 * adapter. What is left here is what is genuinely specific to this endpoint: where it is, how it
 * authenticates, and how it reports what a turn cost.
 */

export interface OpenAiCompatOptions {
  apiKey: string
  /** Root of the API, e.g. `https://api.example.com/v1`. `/chat/completions` is appended. */
  baseUrl: string
  model: string
  maxTokens?: number
  /** Extra top-level fields merged into every request body — the seam hosts use for their own
   *  knobs (routing, reasoning). Never overwrites what the adapter sets; see the merge below. */
  extraBody?: Record<string, unknown>
  /** Injected in tests so the turn mapping is exercised without a key or a network. */
  fetchImpl?: typeof fetch
}

export { TruncatedReplyError } from "./model-turn"

const withoutTrailingSlashes = (value: string): string => {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}

/**
 * What the turn cost, when the endpoint says so.
 *
 * Deliberately NOT a rate table, unlike the Claude adapter's. "OpenAI-compatible" is a wire
 * format, not a provider: this one adapter reaches Fireworks, OpenRouter, Together, vLLM and any
 * self-hosted gateway, and the same model id prices differently on each — so a table here would
 * be a guess about somebody else's price list, which is worse than saying nothing.
 *
 * Several of those hosts (OpenRouter among them) DO report `usage.cost` in USD, so read it when
 * it is there. Absent or unparseable, null means UNKNOWN, which the budget skips — and this is
 * the GATEWAY lane, where one ambient key means the operator pays for the whole instance and the
 * payer chain is bypassed by design, so an unpriced turn matters far less here than on the
 * per-run credential path (which is priced — see model-anthropic.ts).
 *
 * `usage.cost` is not part of the OpenAI schema, so the SDK drops it unless it is lifted out by a
 * metadata extractor, which is exactly what one is for.
 */
const PROVIDER_KEY = "gateway"

const readCost = (usage: unknown): number | null => {
  const cost = (usage as { cost?: unknown } | undefined)?.cost
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null
}

const costMetadata: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => {
    const cost = readCost((parsedBody as { usage?: unknown } | undefined)?.usage)
    return cost === null ? undefined : { [PROVIDER_KEY]: { costUsd: cost } }
  },
  // A stream reports usage in a LATE frame (or not at all), so accumulate and answer at the end.
  createStreamExtractor: () => {
    let cost: number | null = null
    return {
      processChunk(chunk) {
        const seen = readCost((chunk as { usage?: unknown } | undefined)?.usage)
        if (seen !== null) cost = seen
      },
      buildMetadata: () => (cost === null ? undefined : { [PROVIDER_KEY]: { costUsd: cost } }),
    }
  },
}

const priceFromGateway: PriceTurn = ({ providerMetadata }) => {
  const cost = providerMetadata?.[PROVIDER_KEY]?.costUsd
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null
}

/**
 * Merge `extraBody` into an outgoing request, at the fetch seam.
 *
 * Done here rather than through the SDK's provider options because this has to reach the WIRE
 * whatever the SDK does with unknown fields, and because the seam already exists for tests. The
 * SDK's own body wins on any key collision: routing is the caller's business, the request shape
 * is the adapter's, and a config typo must never be able to rewrite `messages`.
 */
const withExtraBody = (base: typeof fetch, extra: Record<string, unknown>): typeof fetch =>
  (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!init?.body || typeof init.body !== "string") return base(input, init)
    let merged = init.body
    try {
      merged = JSON.stringify({ ...extra, ...(JSON.parse(init.body) as Record<string, unknown>) })
    } catch {
      /* not JSON — send it exactly as the SDK built it */
    }
    return base(input, { ...init, body: merged })
  }) as typeof fetch

export const openAiCompatModel = (opts: OpenAiCompatOptions): AgentLoopInput["callModel"] => {
  const baseFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const doFetch =
    opts.extraBody && Object.keys(opts.extraBody).length
      ? withExtraBody(baseFetch, opts.extraBody)
      : opts.fetchImpl
  const provider = createOpenAICompatible({
    name: PROVIDER_KEY,
    // Trailing slashes are a configuration mistake nobody should have to debug from a 404.
    baseURL: withoutTrailingSlashes(opts.baseUrl),
    apiKey: opts.apiKey,
    ...(doFetch ? { fetch: doFetch } : {}),
    // Ask for the final usage frame a stream otherwise omits; without it every streamed turn
    // would report cost as unknown.
    includeUsage: true,
    metadataExtractor: costMetadata,
  })
  return turnFor({
    model: provider.chatModel(opts.model),
    maxTokens: opts.maxTokens,
    price: priceFromGateway,
  })
}
