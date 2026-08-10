import { createAnthropic } from "@ai-sdk/anthropic"
import type { AgentLoopInput } from "./agent-loop"
import { type PriceTurn, turnFor } from "./model-turn"

/**
 * The one turn, against the Messages API, on a WORKSPACE's own Claude plan.
 *
 * Sibling of model-openai.ts and, since both moved onto the AI SDK, genuinely the same turn: how
 * a turn is conducted lives once in model-turn.ts. What is specific to this path is the credential
 * (a connected plan, not an operator key), the default model, and the fact that this is the lane
 * where cost is REAL money on somebody's account, so it is priced rather than left unknown.
 *
 * It used to be plain fetch on the argument that a provider SDK would make the Worker path a
 * separate implementation. That argument was right about the risk and wrong about the SDK: the
 * same bundle runs in both runtimes, which test/worker/model-openai-workerd.test.ts proves rather
 * than assumes.
 */

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

const asCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

const priceFor =
  (model: string): PriceTurn =>
  ({ usage, providerMetadata }) => {
    const rate = RATES[model]
    if (!rate || !usage) return null
    // Cache WRITES are Anthropic-specific and arrive as provider metadata rather than as one of
    // the SDK's unified counts; cache READS are unified (`cachedInputTokens`). Both bill, so both
    // are read — from wherever each actually is.
    const writes = asCount(providerMetadata?.anthropic?.cacheCreationInputTokens)
    const reads = asCount(usage.cachedInputTokens)
    const usd =
      (asCount(usage.inputTokens) * rate.in +
        writes * rate.in * CACHE_WRITE +
        reads * rate.in * CACHE_READ +
        asCount(usage.outputTokens) * rate.out) /
      1_000_000
    return Number.isFinite(usd) ? usd : null
  }

/**
 * Kind → wire auth. An API key rides `x-api-key`; a plan/OAuth token rides `authorization: Bearer`
 * PLUS the oauth beta opt-in — and, critically, WITHOUT the `x-api-key` the provider sets by
 * default, because sending a plan token in that header is the exact 401 this mapping exists to
 * prevent. An explicit undefined removes it.
 */
const authHeaders = (c: AnthropicCredential): Record<string, string | undefined> =>
  c.kind === "oauth"
    ? {
        authorization: `Bearer ${c.value}`,
        "anthropic-beta": OAUTH_BETA,
        "x-api-key": undefined,
      }
    : {}

/** The Messages API origin this lane always hits. Pinned rather than inherited from
 *  `ANTHROPIC_BASE_URL`: that env is the Claude Code CLI's local proxy escape hatch, and a
 *  developer laptop with it set would otherwise bill a WORKSPACE plan against 127.0.0.1 — the
 *  credential path below is real customer money and must reach Anthropic, not a shell proxy. */
const ANTHROPIC_API = "https://api.anthropic.com/v1"

export const anthropicModel = (opts: AnthropicOptions): AgentLoopInput["callModel"] => {
  const model = opts.model ?? DEFAULT_ANTHROPIC_MODEL
  const provider = createAnthropic({
    // The provider requires a key to construct even when the credential rides another header, and
    // reads ANTHROPIC_API_KEY from the environment when given none — which on a self-host box is
    // how one workspace's run quietly bills the operator's key. Always pass the connected value.
    apiKey: opts.credential.value,
    baseURL: ANTHROPIC_API,
    headers: authHeaders(opts.credential) as Record<string, string>,
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
  })
  return turnFor({
    model: provider.languageModel(model),
    maxTokens: opts.maxTokens,
    price: priceFor(model),
    // NO STREAMING HERE, deliberately. `onDelta` is part of the callModel contract and this
    // adapter simply never calls it, which the contract explicitly allows — the caller sees a
    // reply that arrives whole, exactly as before streaming existed. It buys nothing today: the
    // lanes this serves, the payer chain and unattended runs, have no watcher to stream to.
    stream: false,
  })
}
