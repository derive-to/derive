import type { AgentLoopInput } from "./agent-loop"
import { openAiCompatModel } from "./model-openai"

/**
 * WHICH MODEL answers an attended turn.
 *
 * The deploy has always had exactly one: three env vars (base URL, key, model name) became one
 * `callModel`, and every lane used it. That is still the default and still the whole
 * configuration on most deploys — but "which model" is a CHOICE a person makes mid-conversation
 * ("that answer was thin, try the bigger one"), not a property of the process, and the shape of
 * the code decides whether that is a feature or a refactor.
 *
 * So the catalog is the seam. Everything above it is model-aware from day one: the route takes a
 * model id, the turn is handed a resolved model, the transcript records which one answered, the
 * picker renders whatever the catalog offers. Everything below it is one function per entry.
 * Adding models is then DATA — another name in `DERIVE_MODEL_NAMES` today, another provider
 * adapter later — and never a change to a route, a turn, a stored shape or a component.
 *
 * WHY THE ENTRIES ARE MODEL NAMES ON ONE GATEWAY, and not a list of providers. Every host this
 * adapter reaches (Fireworks, OpenRouter, Together, vLLM, a self-hosted proxy) serves MANY models
 * behind ONE base URL and ONE key, so a second model needs no second credential, no second
 * secret to rotate and no new failure mode. A genuinely different provider is a different
 * `callModel` factory, which this interface already accommodates (`entry.build`) — it just has
 * nothing to configure yet, so nothing is invented for it.
 *
 * IDs ARE STABLE AND PUBLIC. A stored transcript and a client's picker both carry them, so an id
 * is the provider's own model name, not an index or a label — a catalog reordered or extended
 * never re-points an old session at a different model.
 */

/** What a picker shows, and what a client sends back. */
export interface ChatModelOption {
  /** The provider's model id, exactly as it names it. Stable across catalog changes. */
  id: string
  /** What to show a person. Today the id's readable tail; a provider with real display names
   *  would supply them here. */
  label: string
  /** True for the one a turn uses when nobody chose. Exactly one entry has it. */
  isDefault: boolean
}

export interface ResolvedChatModel extends ChatModelOption {
  callModel: AgentLoopInput["callModel"]
}

export interface ModelCatalog {
  /** Every model this deploy can answer with, default first. Never empty. */
  options: ChatModelOption[]
  /**
   * The model for an id, or null when the id is unknown — never a silent fallback to the
   * default. A person who picked a model and got a different one's answer has been lied to, and
   * an id that stopped existing is exactly when they need to be told.
   *
   * No id (undefined/null/"") is not a miss: it means "whatever the deploy uses", which is the
   * default, and is what every caller predating the picker sends.
   */
  resolve(id?: string | null): ResolvedChatModel | null
}

/** One configured model: how to reach it, built lazily and once. */
interface CatalogEntry extends ChatModelOption {
  build: () => AgentLoopInput["callModel"]
}

/** The operator's OpenAI-compatible endpoint, exactly as node.ts/worker.ts already read it. */
export interface GatewayConfig {
  baseUrl: string
  apiKey: string
  /** The default model id. */
  model: string
  /**
   * Additional model ids the SAME gateway serves, comma-separated (`DERIVE_MODEL_NAMES`).
   * The default is always included whether or not it is repeated here, so an operator cannot
   * accidentally configure a catalog whose default is unreachable.
   */
  alsoModels?: string
  /** Preferred upstream backends, best first, comma-separated. Only meaningful on a gateway that
   *  routes; unset sends nothing. */
  providers?: string
  /** Upstream backends eligible for automatic routing, comma-separated. When present this wins
   *  over `providers`: the gateway chooses among this set from live performance rather than
   *  walking a fixed order. */
  autoProviders?: string
}

/**
 * NO THINKING BEFORE AN ANSWER.
 *
 * A reasoning model spends most of a short answer's budget thinking, and an attended turn makes
 * several model calls — so it is the difference between a reply that arrives and one that is
 * waited for. Measured locally across both the SDK and a raw request: roughly 1.7x faster with
 * it off, and a capped thinking budget was slower than off while an effort level was slower than
 * the default.
 *
 * A constant rather than configuration: chat is interactive, and there is no deployment that
 * wants its interactive turns slower. Hosts that do not understand the field ignore it.
 */
const NO_THINKING = { reasoning: { enabled: false } } as const

/** Keep interactive replies from winning on time-to-first-token only to then dribble output.
 *  This is a PREFERENCE, not a gate: OpenRouter moves slower endpoints behind the preferred
 *  group and can still use them if the fast group is unavailable. Fifty tokens/sec is enough
 *  that generation no longer dominates an ordinary chat reply while leaving a broad fallback
 *  pool for a large model. */
const AUTO_MIN_THROUGHPUT = { p50: 50 } as const

const providerList = (raw: string | undefined): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const provider of (raw ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    if (seen.has(provider)) continue
    seen.add(provider)
    out.push(provider)
  }
  return out
}

/** The one construction path for a model on the configured gateway. Configured entries,
 * operator-added entries, and add-time probes must share every routing/body knob. */
export const callModelFromGateway = (
  gw: GatewayConfig,
  id: string,
): AgentLoopInput["callModel"] => {
  const automatic = providerList(gw.autoProviders)
  const order = providerList(gw.providers)
  // A fixed `order` disables the gateway's live routing and keeps leaning on the first backend
  // until it fails. The automatic mode instead limits WHO may receive a request while leaving
  // WHICH eligible backend goes first to the gateway's rolling latency/throughput observations.
  // Low latency is what an attended turn feels; the throughput floor prevents a quick first
  // token from masking a slow completion. Fallbacks stay on so a provider 429 becomes another
  // route attempt, not a failed Derive turn.
  const provider = automatic.length
    ? {
        only: automatic,
        sort: "latency",
        preferred_min_throughput: AUTO_MIN_THROUGHPUT,
        allow_fallbacks: true,
      }
    : order.length
      ? { order, allow_fallbacks: true }
      : undefined
  const extraBody = {
    ...(provider ? { provider } : {}),
    ...NO_THINKING,
  }
  return openAiCompatModel({
    baseUrl: gw.baseUrl,
    apiKey: gw.apiKey,
    model: id,
    extraBody,
  })
}

/**
 * A model id's display label: the part after the last `/`, which is what distinguishes
 * `accounts/fireworks/models/deepseek-v4-flash` from its neighbours. Kept dumb on purpose — a
 * mapping table of pretty names would be one more thing to keep in step with a provider's
 * catalog, and would be wrong the first time a model was renamed upstream.
 */
export const labelFor = (id: string): string => id.split("/").filter(Boolean).pop() ?? id

const parseAlso = (raw: string | undefined, defaultModel: string): string[] => {
  const seen = new Set([defaultModel])
  const out: string[] = []
  for (const name of (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * Build the catalog from an operator gateway. Null in, null out: a deploy with no model
 * configured has no catalog, which is the same "chat cannot answer here" state the single
 * `callModel` already expressed.
 */
export const catalogFromGateway = (gw: GatewayConfig | null | undefined): ModelCatalog | null => {
  if (!gw) return null
  const ids = [gw.model, ...parseAlso(gw.alsoModels, gw.model)]
  return catalogOf(
    ids.map((id, i) => ({
      id,
      label: labelFor(id),
      isDefault: i === 0,
      build: () => callModelFromGateway(gw, id),
    })),
  )
}

/** The catalog over a ready list of entries — the seam a second provider plugs into, and what
 *  tests construct to drive a multi-model surface without a network. */
export const catalogOf = (entries: CatalogEntry[]): ModelCatalog => {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const fallback = entries.find((e) => e.isDefault) ?? entries[0]
  // Built on FIRST USE and then kept, HERE rather than inside any one entry source: a catalog
  // with five models must not open five clients at boot for the four nobody asked for, and a
  // second provider plugged in later must inherit that without knowing to implement it. (It
  // was implemented in the gateway constructor first, which meant exactly this seam did not
  // have it — every resolve through a hand-built catalog opened a fresh client.)
  const made = new Map<string, AgentLoopInput["callModel"]>()
  return {
    options: entries.map(({ id, label, isDefault }) => ({ id, label, isDefault })),
    resolve(id) {
      const e = id ? byId.get(id) : fallback
      if (!e) return null
      let call = made.get(e.id)
      if (!call) {
        call = e.build()
        made.set(e.id, call)
      }
      return { id: e.id, label: e.label, isDefault: e.isDefault, callModel: call }
    },
  }
}
