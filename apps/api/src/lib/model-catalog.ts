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
  /**
   * What this gateway is called, and the NAMESPACE for its model ids (`openrouter:gpt-x`).
   *
   * Needed the moment a deploy has more than one, because the same model id is served by
   * several of them — `deepseek-v4-flash` on OpenRouter and on a direct host are different
   * credentials, different speeds and different prices, and a catalog that collapsed them
   * would resolve to whichever was declared last.
   *
   * Unnamed is the LEGACY gateway (the original three env vars) and its ids stay bare, so every
   * id already written into a transcript keeps resolving to the same place. That is not
   * politeness: an id is stored per answer, and re-pointing an old one at a different provider
   * would silently rewrite what the record says produced it.
   */
  name?: string
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
  /**
   * Preferred upstream providers, best first, comma-separated (`DERIVE_MODEL_PROVIDERS`).
   *
   * Only meaningful on a gateway that ROUTES. OpenRouter serves one model id from a dozen
   * backends whose speed differs by an order of magnitude, so the id alone does not determine
   * what you get — measured on the incumbent gateway, generation ran ~18 tokens/sec, which
   * turns a three-call agent turn into half a minute. Unset ⇒ nothing is sent and the gateway
   * routes however it likes, which is right for every gateway that does not route at all.
   */
  providers?: string
}

/**
 * A model id's display label: the part after the last `/`, which is what distinguishes
 * `accounts/fireworks/models/deepseek-v4-flash` from its neighbours. Kept dumb on purpose — a
 * mapping table of pretty names would be one more thing to keep in step with a provider's
 * catalog, and would be wrong the first time a model was renamed upstream.
 */
const labelFor = (id: string): string => id.split("/").filter(Boolean).pop() ?? id

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
export const catalogFromGateway = (gw: GatewayConfig | null | undefined): ModelCatalog | null =>
  catalogFromGateways(gw ? [gw] : [])

/** The entries one gateway contributes: its default model first, then its extras. */
const entriesFor = (gw: GatewayConfig): CatalogEntry[] => {
  const models = [gw.model, ...parseAlso(gw.alsoModels, gw.model)]
  // OpenRouter's routing preference, in its own shape. `allow_fallbacks` stays ON: pinning a
  // list and then refusing everything else converts "slower than we hoped" into "no answer at
  // all" the moment the preferred backend is busy, which is a worse failure than the one this
  // exists to avoid. Absent entirely when unset, so a non-routing gateway sees no stray field.
  const order = (gw.providers ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  const extraBody = order.length ? { provider: { order, allow_fallbacks: true } } : undefined
  return models.map((model) => ({
    // Namespaced per gateway, EXCEPT the unnamed legacy one — see GatewayConfig.name.
    id: gw.name ? `${gw.name}:${model}` : model,
    // The label carries the gateway too once there is more than one, because "deepseek-v4-flash"
    // appearing twice in a picker with no way to tell them apart is not a choice.
    label: gw.name ? `${labelFor(model)} (${gw.name})` : labelFor(model),
    isDefault: false,
    build: () => openAiCompatModel({ baseUrl: gw.baseUrl, apiKey: gw.apiKey, model, extraBody }),
  }))
}

/**
 * The catalog over EVERY configured gateway — the answer to "route between several providers,
 * switch whenever, and add more without a code change".
 *
 * Each gateway keeps its own credential, its own model list and its own backend routing, so a
 * second provider is a second entry in configuration rather than a second code path. They are
 * all in ONE catalog because that is what makes them interchangeable everywhere it matters: the
 * picker lists them together, a turn takes any of their ids, and the transcript records which
 * one actually answered.
 *
 * `defaultId` names the one used when nobody chose. Unset, it is the first model of the first
 * gateway — the legacy behaviour — so pointing a deploy at a different provider is one variable,
 * not a redeploy with the vars swapped around. An id that names nothing is ignored rather than
 * fatal: a typo there should cost the default, never the whole chat surface.
 */
export const catalogFromGateways = (
  gateways: readonly (GatewayConfig | null | undefined)[],
  defaultId?: string | null,
): ModelCatalog | null => {
  const entries = gateways.filter((g): g is GatewayConfig => !!g).flatMap(entriesFor)
  if (!entries.length) return null
  // De-dupe by id, first declaration winning: two gateways sharing a name is a configuration
  // mistake, and silently serving the second one's credential under the first one's id is the
  // kind of wrong nobody would find.
  const seen = new Set<string>()
  const unique = entries.filter((e) => !seen.has(e.id) && (seen.add(e.id), true))
  const wanted = defaultId?.trim()
  const fallback = (wanted && unique.find((e) => e.id === wanted)) || unique[0]
  return catalogOf(unique.map((e) => ({ ...e, isDefault: e === fallback })))
}

/**
 * Extra gateways, declared as JSON in one variable (`DERIVE_MODEL_GATEWAYS`).
 *
 * JSON rather than numbered variables (`DERIVE_MODEL_2_BASE_URL`, …) because the whole point is
 * that adding the fourth provider costs nothing: a new object in a list, not four new names that
 * every entry point and the manifest must learn. It carries KEYS, so it is a secret like the one
 * it sits beside.
 *
 * Malformed input yields NOTHING rather than throwing. This is read at boot on a path that also
 * serves anonymous reads, and a stray comma in a model list is not a reason for a deploy to stop
 * answering; the configured-models endpoint is what shows whether it took.
 */
export const parseGatewaysJson = (raw: string | undefined): GatewayConfig[] => {
  if (!raw?.trim()) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.flatMap((x) => {
      const g = x as Partial<GatewayConfig> & { models?: unknown; apiKeyEnv?: unknown }
      // THE KEY BY REFERENCE, which is how an operator will actually hold it: as its own secret,
      // rotatable on its own, rather than pasted inside a JSON blob that then becomes a secret
      // itself and has to be re-pasted whole to change one field. `apiKey` still works for the
      // simple case; `apiKeyEnv` names the variable to read instead. process.env carries these
      // on both runtimes (nodejs_compat_populate_process_env on Workers).
      const apiKey =
        g.apiKey ?? (typeof g.apiKeyEnv === "string" ? process.env[g.apiKeyEnv] : undefined)
      // A gateway missing any of the three essentials cannot answer, and half-configuring one
      // should not half-break the catalog — drop it and keep the rest. A named-but-unset key
      // lands here too, which is the right outcome: better one absent provider than a catalog
      // advertising a model every turn then 401s on.
      if (!g.baseUrl || !apiKey || !(g.model || Array.isArray(g.models))) return []
      const models = Array.isArray(g.models) ? g.models.filter((m) => typeof m === "string") : []
      const model = g.model ?? models[0]
      if (!model) return []
      return [
        {
          ...(g.name ? { name: String(g.name) } : {}),
          baseUrl: String(g.baseUrl),
          apiKey: String(apiKey),
          model: String(model),
          alsoModels: [...models.slice(g.model ? 0 : 1), g.alsoModels ?? ""]
            .filter(Boolean)
            .join(","),
          ...(g.providers ? { providers: String(g.providers) } : {}),
        },
      ]
    })
  } catch {
    return []
  }
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
