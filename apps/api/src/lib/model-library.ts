import type { InstanceModel, InstanceSlots, MetaStore, ModelProbe } from "@derive/core"
import { getInstanceSettings, setInstanceSettings } from "./instance-settings"
import type { GatewayConfig, ModelCatalog, ResolvedChatModel } from "./model-catalog"
import { labelFor } from "./model-catalog"
import { openAiCompatModel } from "./model-openai"

/**
 * THE MODEL LIBRARY: which models this deploy can answer with, and which one serves which lane,
 * held where an operator can change it in seconds.
 *
 * The catalog (model-catalog.ts) already made "which model" a CHOICE rather than a property of
 * the process — but only among the ids named in the environment, so the set itself still moved at
 * the speed of a deploy. That is the wrong speed for the case it is most needed in, which is the
 * same case the live default switch was built for: a provider has gone slow or dark and people
 * are typing. Being able to pick between two models nobody can change is half a lever.
 *
 * WHAT THIS CAN AND CANNOT ADD, and why the line is where it is. An entry here is a model id on
 * the gateway the deploy is ALREADY configured with — same base URL, same key. That is not a
 * limitation of the storage, it is the honest boundary of what can be changed without a deploy:
 * every host this adapter reaches (Fireworks, OpenRouter, Together, vLLM) serves many models
 * behind one credential, so a second model needs no second secret. A genuinely different
 * provider needs a key that only the environment can hold, so it stays a deploy — and an id with
 * no key behind it would be a 401 on every turn, filed as a model that "exists".
 *
 * ENVIRONMENT FIRST, ALWAYS. The configured ids are the floor: an operator can add to them,
 * relabel them and pin a lane to one, but cannot delete one — removing the last reachable model
 * from a running deploy through a settings write is not a lever, it is an outage with an audit
 * trail. Taking a model away stays where taking a model away belongs, in the configuration that
 * owns the credential.
 */

/** The deploy's library, normalized: never null, ids unique, junk dropped. */
export interface ModelLibrary {
  models: InstanceModel[]
  slots: InstanceSlots
}

export const EMPTY_LIBRARY: ModelLibrary = { models: [], slots: {} }

/** How long a probe waits before calling it dark. Deliberately generous — a slow model is a
 *  RESULT worth recording, and the number the operator is looking at is the latency, not a
 *  pass/fail. Short enough that probing every model in a list stays a page load. */
export const PROBE_TIMEOUT_MS = 30_000

/** The probe prompt. Tiny on both sides: one sentence in, a word out, so a probe costs a
 *  fraction of a cent and the time it reports is the provider's overhead rather than a
 *  measurement of how long some model likes to talk for. Identical for every model, which is
 *  the only reason two probes can be compared at all. */
const PROBE_SYSTEM = "You are a availability probe. Reply with the single word OK."
const PROBE_PROMPT = "Reply with OK."

const trimmed = (s: unknown): string => (typeof s === "string" ? s.trim() : "")

/**
 * Read a stored blob into a library. Tolerant on purpose: this is operator-written data on a
 * shared JSON row, and a malformed entry must cost that entry rather than every turn on the
 * deploy — the same reasoning that makes an unknown slot id an ignored override rather than a
 * failure.
 */
export const parseLibrary = (raw: {
  models?: InstanceModel[]
  slots?: InstanceSlots
}): ModelLibrary => {
  const seen = new Set<string>()
  const models: InstanceModel[] = []
  for (const m of Array.isArray(raw.models) ? raw.models : []) {
    const id = trimmed(m?.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = trimmed(m?.label)
    models.push({ id, ...(label ? { label } : {}), ...(m?.probe ? { probe: m.probe } : {}) })
  }
  const chat = trimmed(raw.slots?.chat)
  const automation = trimmed(raw.slots?.automation)
  return { models, slots: { ...(chat ? { chat } : {}), ...(automation ? { automation } : {}) } }
}

/** The library as stored on the reserved instance row. */
export const readLibrary = async (meta: MetaStore): Promise<ModelLibrary> => {
  const s = await getInstanceSettings(meta).catch(() => null)
  return s ? parseLibrary(s) : EMPTY_LIBRARY
}

/** Write it back, leaving every other instance-scoped setting alone. */
export const writeLibrary = async (meta: MetaStore, lib: ModelLibrary): Promise<void> => {
  await setInstanceSettings(meta, {
    models: lib.models.length ? lib.models : undefined,
    slots: lib.slots.chat || lib.slots.automation ? lib.slots : undefined,
  })
}

/**
 * The catalog a turn actually chooses from: the environment's, widened by the library.
 *
 * A DECORATOR over the base catalog rather than a rebuild of it, because the base is the one
 * thing here that is not data — it holds the client the deploy booted with, it is what a test
 * injects, and rebuilding it from `options` would need a `build` this interface deliberately
 * does not expose. So configured ids keep resolving through exactly the path they always did,
 * and only the ids the environment has never heard of are constructed here.
 *
 * With NO gateway there is nothing to construct an added id against — an injected test catalog,
 * or a deploy whose model is configured some other way — so added ids are IGNORED rather than
 * offered as options that cannot answer. Labels still apply: renaming a model needs no key.
 */
export const effectiveCatalog = (
  base: ModelCatalog | null | undefined,
  gw: GatewayConfig | null | undefined,
  lib: ModelLibrary,
): ModelCatalog | null => {
  if (!base) return null
  const baseIds = new Set(base.options.map((o) => o.id))
  const labels = new Map(lib.models.filter((m) => m.label).map((m) => [m.id, m.label as string]))
  // Only ids the base has never heard of, and only when there is something to reach them with.
  const added = gw ? lib.models.filter((m) => !baseIds.has(m.id)) : []
  // Built on first use and kept for the life of this catalog, for the reason catalogOf gives:
  // a library of five models must not open five clients for the four nobody asked for.
  const made = new Map<string, ResolvedChatModel["callModel"]>()
  const relabel = <T extends { id: string; label: string }>(o: T): T => {
    const l = labels.get(o.id)
    return l ? { ...o, label: l } : o
  }
  return {
    options: [
      ...base.options.map(relabel),
      ...added.map((m) => ({ id: m.id, label: m.label ?? labelFor(m.id), isDefault: false })),
    ],
    resolve(id) {
      const hit = base.resolve(id)
      if (hit) return relabel(hit)
      // No id means "the deploy's default", which the base already answered — a miss here is a
      // named id, so an added entry is the only thing left it could be.
      if (!id) return null
      const m = added.find((a) => a.id === id)
      if (!m || !gw) return null
      let call = made.get(m.id)
      if (!call) {
        call = buildAdded(gw, m.id)
        made.set(m.id, call)
      }
      return { id: m.id, label: m.label ?? labelFor(m.id), isDefault: false, callModel: call }
    },
  }
}

/**
 * THE ONE WAY A LANE GETS A CATALOG: read the library, widen the configured catalog, hand it
 * over. Async because the library lives in the datastore, and it is read PER TURN rather than
 * cached for exactly the reason the live default switch exists — a lever that takes effect in an
 * hour is not a lever during an outage. It rides the same instance row `getInstanceChatModel`
 * already reads on that path, so a chat turn gains no round trip.
 *
 * Every surface that answers a turn takes one of these rather than a fixed catalog, so a model
 * added by an operator is reachable from the web rail, an @derive comment mention and an
 * @Derive Slack mention without any of them knowing the library exists.
 */
export type ModelSource = () => Promise<ModelCatalog | null>

export const modelSource = (
  base: ModelCatalog | null | undefined,
  gw: GatewayConfig | null | undefined,
  meta: MetaStore,
): ModelSource => {
  // A deploy with no configured catalog has nothing to widen: the library cannot BE the whole
  // catalog, because its entries are ids on a gateway that, in that state, does not exist.
  if (!base) return async () => null
  return async () => effectiveCatalog(base, gw, await readLibrary(meta))
}

/** An added id, reached exactly as a configured one is: same gateway, same key, same body knobs.
 *  Kept in step with catalogFromGateway by taking the same GatewayConfig — an added model that
 *  answered differently from a configured one would make the library a second code path. */
const buildAdded = (gw: GatewayConfig, id: string): ResolvedChatModel["callModel"] => {
  const order = (gw.providers ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  return openAiCompatModel({
    baseUrl: gw.baseUrl,
    apiKey: gw.apiKey,
    model: id,
    extraBody: {
      ...(order.length ? { provider: { order, allow_fallbacks: true } } : {}),
      reasoning: { enabled: false },
    },
  })
}

/**
 * PROBE ONE MODEL: does it answer, and how long does it take to start.
 *
 * Through the SAME `callModel` a turn uses, deliberately — a probe that dialled the provider its
 * own way would answer a question nobody asked ("is the endpoint up") while the question that
 * matters is "does a turn on this deploy work". Wrong base URL, wrong key, a gateway that routes
 * this id nowhere, a body knob the host rejects: all of them are real failures of chat, and all
 * of them are invisible to a probe that does not use the same path.
 *
 * TWO NUMBERS. Time to first token is what a person feels, because chat streams; total is what
 * an unattended run pays. A model can be fast to start and slow to finish, or think for six
 * seconds and then finish at once — reporting one number would hide whichever failure the
 * operator happened to have.
 */
export const probeModel = async (
  model: ResolvedChatModel,
  opts: { timeoutMs?: number; now?: () => number } = {},
): Promise<ModelProbe> => {
  const now = opts.now ?? (() => Date.now())
  const started = now()
  const at = new Date().toISOString()
  let ttftMs: number | null = null
  try {
    const turn = await withTimeout(
      model.callModel({
        system: PROBE_SYSTEM,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        tools: [],
        // First delta only. Deltas are best-effort and may be coalesced (see the callModel
        // contract), so this is the earliest moment the adapter told us anything — which is
        // exactly what time-to-first-token means. An adapter that does not stream leaves it
        // null and the total still lands.
        onDelta: () => {
          if (ttftMs === null) ttftMs = now() - started
        },
      }),
      opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    )
    const totalMs = now() - started
    // A turn that came back EMPTY is not a pass. A gateway answering 200 with no content is the
    // shape a misrouted model id takes on more than one host, and calling that healthy is how a
    // dead model stays selected.
    if (!turn.text.trim())
      return { at, ok: false, ttftMs, totalMs, error: "the model returned an empty reply" }
    return { at, ok: true, ttftMs, totalMs }
  } catch (err) {
    return {
      at,
      ok: false,
      ttftMs,
      totalMs: now() - started,
      // The provider's own words, bounded: an operator debugging a 401 needs to read it, and a
      // stack trace or an HTML error page must not become a settings row.
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    }
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no reply within ${Math.round(ms / 1000)}s`)), ms)
    p.then(resolve, reject).finally(() => clearTimeout(t))
  })
