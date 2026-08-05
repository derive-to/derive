import type { ModelProbe } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import { capabilityReport } from "../config-manifest"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"
import {
  getInstanceSlot,
  probeModel,
  readLibrary,
  setInstanceSlot,
  writeLibrary,
} from "../lib/model-library"
import { openAiCompatModel } from "../lib/model-openai"
import { foldTimings } from "../lib/model-timing"
import { reindexSearchBatch } from "../lib/search"
import { log } from "../log"

/** Operational endpoints: liveness (/healthz), readiness (/readyz — proves the datastore
 *  and blob store are reachable), and the minimal API-origin landing page. */
export const systemRoutes = (ctx: AppContext) => {
  const { deps, meta, blobs, search, isToken, isSuperAdmin } = ctx
  const app = new Hono()

  /**
   * THE ONE OPERATOR GATE for everything in this file that reads or writes deploy-wide state.
   *
   * Written once and called first in every handler rather than repeated inline: the model
   * library is the most privileged thing a non-workspace route touches on this deploy — it
   * decides which model every tenant's turns run on, and its GET returns a sample of real
   * answers — so a handler added later that FORGETS the check is the failure mode worth
   * engineering against. One helper makes the omission visible in review; four copies of an
   * if-statement do not.
   *
   * `isSuperAdmin` is DERIVE_TOKEN (the static operator bearer) or a signed-in account whose
   * email is in DERIVE_OPERATORS. A workspace Admin is NOT an operator here, deliberately: they
   * administer a tenant, and this spends the operator's credential for every tenant at once.
   */
  const operatorOnly = async (c: Parameters<typeof isSuperAdmin>[0]): Promise<Response | null> =>
    isToken(c) || (await isSuperAdmin(c))
      ? null
      : fail(c, 403, "operator access required (DERIVE_TOKEN or a super-admin account)")

  /** A path segment that is a model id. Ids carry slashes (`deepseek/deepseek-v4-flash`), so they
   *  arrive percent-encoded — and a malformed escape THROWS, which would hand an operator a 500
   *  about a typo. */
  const decodeParam = (raw: string): string | null => {
    try {
      return decodeURIComponent(raw)
    } catch {
      return null
    }
  }

  /** How many models the library may hold. */
  const MAX_LIBRARY_MODELS = 50

  /** How many recent answers the observed timings are folded from. Big enough that a p95 means
   *  something on a busy deploy, small enough to stay one indexed read. */
  const TIMING_SAMPLE = 500

  /** A probe of an id that is not in the catalog yet — built on the deploy's own gateway, which
   *  is the only endpoint the library can ever add a model on. */
  const probeAdded = async (id: string) => {
    const gw = ctx.modelGateway
    if (!gw) throw new Error("no gateway")
    return probeModel({
      id,
      label: id,
      isDefault: false,
      callModel: openAiCompatModel({ baseUrl: gw.baseUrl, apiKey: gw.apiKey, model: id }),
    })
  }

  /** Every lane and what serves it — the shape both the library view and a pin's response
   *  return. One read of the instance row for both lanes, and one definition, so a third lane
   *  cannot appear in one response and be forgotten in the other. */
  const slotsJson = async () => {
    const { slots } = await readLibrary(meta)
    return { chat: slots.chat ?? null, automation: slots.automation ?? null }
  }

  const probeJson = (p: ModelProbe) => ({
    at: p.at,
    ok: p.ok,
    ttft_ms: p.ttftMs,
    total_ms: p.totalMs,
    error: p.error ?? null,
  })

  // Liveness, plus the commit actually serving. `build` is what makes a silent non-deploy
  // detectable without Cloudflare credentials or CI access: curl it and compare. Deliberately
  // on the UNAUTHENTICATED liveness route — the audience is a deploy check and an operator
  // asking "did my change ship", and a commit sha discloses nothing a public repo does not.
  app.get("/healthz", (c) => c.json({ ok: true, build: deps.buildId ?? "dev" }))

  // Readiness (vs /healthz liveness): proves the datastore + blob store are
  // actually reachable, so an orchestrator stops routing to an instance whose DB
  // or blob backend is down instead of letting it 500 every request. 503 on any
  // failure. Point the platform healthcheck here for rollout/traffic gating.
  app.get("/readyz", async (c) => {
    try {
      await meta.getWorkspace(deps.defaultOrgId ?? "default")
      // A valid 64-hex key so the store does real I/O (fs read / S3 GET): the
      // sentinel doesn't exist, so a healthy backend returns null, but an
      // unreachable one throws — which is the signal we want. A non-hex key
      // would short-circuit to null without touching the backend (no-op probe).
      await blobs.get("0".repeat(64))
      return c.json({ ok: true })
    } catch (err) {
      log.error("readiness check failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      return c.json({ ok: false }, 503)
    }
  })

  // THE DEPLOY-WIDE MODEL, read and set by the operator.
  //
  // Not a workspace setting: the operator holds the model credential and pays for every turn on
  // it, and when a provider goes slow or dark the person who has to move everyone at once is the
  // one who runs the instance. Read fresh per turn, so a change lands on the next message rather
  // than the next deploy.
  app.get("/v1/system/chat-model", async (c) => {
    const denied = await operatorOnly(c)
    if (denied) return denied
    return c.json({
      model: await getInstanceSlot(meta, "chat"),
      // The catalog travels with it so the picker needs one call, and so "what is set" and "what
      // could be set" can never disagree about which ids exist.
      options: (ctx.models?.options ?? []).map((m) => ({
        id: m.id,
        label: m.label,
        is_default: m.isDefault,
      })),
    })
  })

  app.put("/v1/system/chat-model", async (c) => {
    const denied = await operatorOnly(c)
    if (denied) return denied
    const b = await readJson(c, z.object({ model: z.string().nullable() }))
    if (b instanceof Response) return b
    // Validated against the catalog, so a typo is refused HERE where somebody is looking at the
    // response rather than silently costing every turn on the deploy.
    if (b.model && !(await ctx.modelsFor(c)).catalog?.resolve(b.model))
      return fail(c, 400, `unknown model "${b.model}"`)
    await setInstanceSlot(meta, "chat", b.model)
    return c.json({ model: await getInstanceSlot(meta, "chat") })
  })

  /**
   * THE MODEL LIBRARY — the operator's whole view: what this deploy can answer with, which model
   * serves which lane, what the last probe found, and how each one is actually performing.
   *
   * ONE GET for the page, deliberately. "What is set", "what could be set", "is it healthy" and
   * "is it fast" are the four things an operator weighs in a single decision, and splitting them
   * across four calls is how a page renders three of them and a spinner at the moment somebody
   * needs to act.
   */
  app.get("/v1/system/models", async (c) => {
    const denied = await operatorOnly(c)
    if (denied) return denied
    const [catalog, lib, sample] = await Promise.all([
      ctx.modelsFor(c),
      readLibrary(meta),
      // A bounded sample of recent answers, folded into per-model timings in memory. Bounded
      // rather than windowed: a quiet deploy still gets numbers, and a busy one pays a constant.
      meta.listRecentAgentMessages(TIMING_SAMPLE).catch(() => []),
    ])
    const timings = new Map(foldTimings(sample).map((t) => [t.modelId, t]))
    const added = new Set(lib.models.map((m) => m.id))
    // WHICH IDS THE ENVIRONMENT OWNS. Not "everything the library has no entry for": probing a
    // CONFIGURED model creates an entry to hold its probe, which made that model start
    // reporting itself as library-sourced and removable. Removing it then deleted the probe and
    // nothing else — the model stayed in the catalog, because the environment still names it —
    // so the button did approximately nothing and said otherwise.
    const configured = new Set(ctx.models?.options.map((o) => o.id) ?? [])
    const probes = new Map(lib.models.map((m) => [m.id, m.probe]))
    return c.json({
      slots: await slotsJson(),
      // Whether this deploy can ADD a model at all. False (no gateway configured) means the
      // library can still relabel and pin, and the UI has to say so rather than offer an input
      // whose every submission would be refused.
      can_add: !!ctx.modelGateway,
      models: (catalog.catalog?.options ?? []).map((m) => {
        const t = timings.get(m.id)
        const probe = probes.get(m.id)
        return {
          id: m.id,
          label: m.label,
          is_default: m.isDefault,
          // Configured models come from the environment and cannot be removed here — taking the
          // last reachable model off a running deploy is not a lever (see lib/model-library.ts).
          source: configured.has(m.id) ? "configured" : "library",
          removable: added.has(m.id) && !configured.has(m.id),
          probe: probe
            ? {
                at: probe.at,
                ok: probe.ok,
                ttft_ms: probe.ttftMs,
                total_ms: probe.totalMs,
                error: probe.error ?? null,
              }
            : null,
          observed: t
            ? {
                samples: t.samples,
                ttft_p50_ms: t.ttftP50,
                ttft_p95_ms: t.ttftP95,
                total_p50_ms: t.totalP50,
                total_p95_ms: t.totalP95,
                last_at: t.lastAt,
              }
            : null,
        }
      }),
    })
  })

  /** Add a model id the environment never named, on the gateway this deploy already holds. */
  app.post("/v1/system/models", async (c) => {
    const denied = await operatorOnly(c)
    if (denied) return denied
    const b = await readJson(c, z.object({ id: z.string(), label: z.string().optional() }))
    if (b instanceof Response) return b
    const id = b.id.trim()
    const label = b.label?.trim()
    // Bounded because it is persisted and rendered. A provider model id is tens of characters;
    // anything approaching this is not one.
    if (!id || id.length > 200) return fail(c, 400, "a model id is required (max 200 chars)")
    if (label && label.length > 80) return fail(c, 400, "label too long (max 80 chars)")
    if (!ctx.modelGateway)
      return fail(
        c,
        400,
        "this deploy has no model gateway configured, so there is no endpoint to reach a new model on — set DERIVE_MODEL_BASE_URL, DERIVE_MODEL_API_KEY and DERIVE_MODEL_NAME",
      )
    const lib = await readLibrary(meta)
    if (lib.models.some((m) => m.id === id))
      return fail(c, 409, `"${id}" is already in the library`)
    // The library is ONE JSON blob on a row the chat path reads per turn, so its size is a
    // latency budget rather than a preference. Far above any real catalog, low enough that a
    // stuck script cannot grow the instance settings row without bound.
    if (lib.models.length >= MAX_LIBRARY_MODELS)
      return fail(c, 400, `the library is full (${MAX_LIBRARY_MODELS} models); remove one first`)
    if ((await ctx.modelsFor(c)).catalog?.resolve(id) && !lib.models.some((m) => m.id === id))
      return fail(c, 409, `"${id}" is already configured on this deploy`)

    // PROBED BEFORE IT IS SAVED, and refused if it cannot answer. An id is a free-text string
    // that only the provider can validate, so the alternative is a library entry that looks
    // identical to a working one and 404s every turn somebody selects it — discovered by a
    // person mid-conversation rather than by the operator who typed it.
    const probed = await probeAdded(id)
    if (!probed.ok)
      return fail(c, 400, `"${id}" did not answer: ${probed.error ?? "no reply"}`, {
        probe: probeJson(probed),
      })
    await writeLibrary(meta, {
      ...lib,
      models: [...lib.models, { id, ...(label ? { label } : {}), probe: probed }],
    })
    return c.json({ id, label: label ?? null, probe: probeJson(probed) }, 201)
  })

  /**
   * Remove a model from the library.
   *
   * Only a LIBRARY entry: a configured id belongs to the environment. Any lane pinned to it is
   * unpinned in the same write — leaving a slot pointing at a model that no longer resolves is
   * a silent fallback to the default, and a lane that quietly stopped honoring its pin is worse
   * than one that was never pinned.
   */
  app.delete("/v1/system/models/:id", async (c) => {
    const denied = await operatorOnly(c)
    if (denied) return denied
    const id = decodeParam(c.req.param("id"))
    if (id === null) return fail(c, 400, "malformed model id")
    const lib = await readLibrary(meta)
    if (!lib.models.some((m) => m.id === id))
      return fail(c, 404, `"${id}" is not in the library (configured models come from the env)`)
    await writeLibrary(meta, {
      models: lib.models.filter((m) => m.id !== id),
      slots: {
        chat: lib.slots.chat === id ? undefined : lib.slots.chat,
        automation: lib.slots.automation === id ? undefined : lib.slots.automation,
      },
    })
    return c.json({ removed: id })
  })

  /**
   * PROBE: does this model answer, and how fast, through the same path a turn takes.
   *
   * Works for a CONFIGURED id as well as a library one — "how fast is what we are already
   * running" is the first question anyone comparing models asks, and answering it only for
   * models nobody has adopted yet would be a strange place to stop. Probing a configured id
   * creates a library entry that holds nothing but the probe.
   */
  app.post("/v1/system/models/:id/probe", async (c) => {
    const denied = await operatorOnly(c)
    if (denied) return denied
    const id = decodeParam(c.req.param("id"))
    if (id === null) return fail(c, 400, "malformed model id")
    const resolved = (await ctx.modelsFor(c)).catalog?.resolve(id)
    if (!resolved) return fail(c, 404, `unknown model "${id}"`)
    const probe = await probeModel(resolved)
    const lib = await readLibrary(meta)
    const known = lib.models.some((m) => m.id === id)
    await writeLibrary(meta, {
      ...lib,
      models: known
        ? lib.models.map((m) => (m.id === id ? { ...m, probe } : m))
        : [...lib.models, { id, probe }],
    })
    // 200 EVEN WHEN THE MODEL FAILED. The probe itself succeeded — it found out. A 5xx here
    // would say Derive is broken when the finding is that a provider is, which is the opposite
    // of what this page exists to tell somebody.
    return c.json({ id, probe: probeJson(probe) })
  })

  /** Pin a LANE to a model, or clear it back to the deploy's configured default. */
  app.put("/v1/system/models/slots/:lane", async (c) => {
    const denied = await operatorOnly(c)
    if (denied) return denied
    const lane = c.req.param("lane")
    if (lane !== "chat" && lane !== "automation") return fail(c, 404, `unknown lane "${lane}"`)
    const b = await readJson(c, z.object({ model: z.string().nullable() }))
    if (b instanceof Response) return b
    // Same validation as the chat pin, for the same reason — and it matters MORE here: an
    // automation run is unattended, so a pin naming nothing would fail runs with nobody watching.
    if (b.model && !(await ctx.modelsFor(c)).catalog?.resolve(b.model))
      return fail(c, 400, `unknown model "${b.model}"`)
    if (lane === "chat") await setInstanceSlot(meta, "chat", b.model)
    else await setInstanceSlot(meta, "automation", b.model)
    return c.json({
      slots: await slotsJson(),
    })
  })

  // Operator-only config introspection for `derive doctor`: which optional features are
  // on / off / half-configured, plus the env vars still missing (names only, never secret
  // values). process.env carries the vars on both runtimes (nodejs_compat populate).
  app.get("/v1/system/capabilities", async (c) => {
    const denied = await operatorOnly(c)
    if (denied) return denied
    // Email's transport is runtime-specific: Resend on Node, but the Cloudflare Email
    // Service binding (NOT a process.env var) on the edge. So its true on/off is the app's
    // already-resolved `emailEnabled`, not a guess from RESEND_API_KEY (unset on the edge).
    // The other capabilities are gated on secrets that populate_process_env mirrors on both.
    const capabilities = capabilityReport(process.env).map((cap) => {
      // Email's true on/off is the resolved transport, not an env guess (see below).
      if (cap.id === "email" && deps.emailEnabled)
        return { ...cap, status: "on" as const, missing: [] }
      // Semantic search's true on/off is whether the dense arm actually got wired: the embedder
      // vars alone report "on", but the arm needs Postgres (pgvector) and a working setup, so on
      // SQLite — or when dense setup failed — `search` is undefined and it's really off.
      if (cap.id === "semanticSearch")
        return search
          ? { ...cap, status: "on" as const, missing: [] }
          : { ...cap, status: "off" as const }
      return cap
    })
    return c.json({ capabilities })
  })

  // Backfill the workspace search index over the EXISTING corpus. Publishing keeps the
  // index current going forward (emitVersionBump), but artifacts published before that
  // wiring — or created outside it — need a one-time sweep. Operator-only, idempotent,
  // and bounded: it indexes one page (default 100, max 200) and returns `nextCursor`;
  // the operator re-POSTs with that cursor until it comes back null. The cap stays modest
  // because it reads every page a bundle holds. The dense arm now embeds + upserts in BATCHES (few
  // subrequests), so the per-invocation budget is dominated by the LEXICAL arm's per-artifact blob
  // read + D1 write; keeping `limit` ≤ 200 holds that under the Worker's subrequest ceiling. Two
  // failure modes to know: (1) one artifact's lexical index fails (e.g. an unreadable blob) — caught
  // per-artifact, and `indexed < scanned` flags it, so re-sweep from cursor 0 (idempotent) to catch
  // it; (2) the whole dense BATCH fails — best-effort, swallowed after the loop, so it does NOT lower
  // `indexed`; if the dense arm was down for a page, re-sweep from cursor 0. Keeping each call
  // bounded fits the Workers CPU + subrequest budget rather than one unbounded pass. Run it as
  // a one-time backfill: under a concurrent live publish it could momentarily write
  // older-version text for that artifact, but grep-confirm reads the live blob (so
  // precision holds) and the next publish re-indexes it — the staleness self-heals.
  //   curl -XPOST -H "authorization: Bearer $DERIVE_TOKEN" .../v1/system/search-reindex
  //   # then repeat, passing {"cursor": <nextCursor>} until nextCursor is null
  app.post("/v1/system/search-reindex", async (c) => {
    const denied = await operatorOnly(c)
    if (denied) return denied
    const body = await readJson(
      c,
      z.object({
        orgId: z.string().optional(),
        // `.nullish()`: the natural resume loop echoes back the previous `nextCursor`, which is
        // literally `null` on the final page — accept it as "start from the top" rather than 400.
        cursor: z.object({ key: z.string(), id: z.string() }).nullish(),
        limit: z.number().int().optional(),
      }),
    )
    if (body instanceof Response) return body
    const limit = Math.min(Math.max(body.limit ?? 100, 1), 200)
    const result = await reindexSearchBatch(
      { meta, blobs, search },
      // Normalize null→undefined: reindexSearchBatch's keyset cursor is `{…} | undefined`.
      { orgId: body.orgId, cursor: body.cursor ?? undefined, limit },
    )
    return c.json(result)
  })

  // A minimal API-origin landing, ONLY for deployments with no SPA at all. Skipped
  // when the SPA is bundled in-process (serveWeb, the Node tier) AND when a shell
  // provider exists (the edge Worker, where `/` is routed worker-first and
  // routes/marketing.ts owns it — this placeholder would shadow the real home page).
  if (!deps.serveWeb && !deps.shell && !deps.shellFetch)
    app.get("/", (c) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>Derive</title>
<body style="font:16px/1.6 system-ui;background:#f6f0e3;color:#2a2540;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="letter-spacing:-.02em">Derive</h1>
<p>An open home for AI-generated artifacts.<br>
<code style="background:#eee7d6;padding:2px 8px;border-radius:6px">derive publish ./your-thing</code></p></div>`,
      ),
    )

  return app
}
