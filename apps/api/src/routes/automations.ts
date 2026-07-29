import { randomUUID } from "node:crypto"
import {
  type AutomationRecord,
  type AutomationTrigger,
  mergeRunMeta,
  newId,
  normalizeSelectors,
  parseRunMeta,
  runCounter,
} from "@derive/core"
import { z } from "@hono/zod-openapi"
import { type Context, Hono } from "hono"
import type { AppContext } from "../context"
import { parseConnectionIds, parseRefs, parseTrigger } from "../lib/automation"
import { brokerFor, connectionBindError, executeSecretTool, toolsForRun } from "../lib/broker"
import { overBudget } from "../lib/budget"
import { mintToken, safeEqual, sha256 } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"
import { RUN_MAX_RETRIES, retryDelayMs } from "../lib/run-lifecycle"
import { materializeDueRuns } from "../lib/schedule"

// Automations + runs — the generic agent-work primitive. An automation is a
// standing job: WHO (agent), WHEN (trigger: manual | schedule | event), WHAT (free-form
// instruction), on WHAT (refs). Every firing is a run; the run table is both the queue
// (status=queued) and the ledger (terminal rows). A "living doc" is just an automation whose
// instruction keeps a doc current — refreshing it is "run now", the same verb a schedule
// tick or a webhook uses. Plain routes (agent-facing + admin), not the OpenAPI web surface.

const isoNow = () => new Date().toISOString()

// Fire-URL limits: one payload is capped, and a coalesced run's accumulated payloads are
// capped too, so a burst can't grow a single run's meta blob without bound.
const MAX_FIRE_BODY_BYTES = 64_000
const MAX_FIRE_META_BYTES = 256_000
// A fire folds into an already-queued run for the same automation scheduled within this
// forward window (i.e. until a worker claims it), so a burst becomes one run of many payloads.
const COALESCE_WINDOW_MS = 60_000

/** Present an automation with its JSON blobs parsed and enabled as a boolean. Both blobs
 *  parse defensively so a single malformed row can't 500 every list/claim response. */
const present = (a: AutomationRecord) => {
  // Redact the fire-secret hash: never surfaced on read. `has_fire_url` tells a reader a
  // webhook trigger exists (fire at /v1/automations/:id/fire) without exposing the secret.
  const { secret_hash, ...trigger } = parseTrigger(a.trigger)
  return {
    ...a,
    trigger,
    refs: parseRefs(a.refs),
    connection_ids: parseConnectionIds(a.connection_ids),
    enabled: a.enabled === 1,
    has_fire_url: secret_hash !== undefined,
  }
}

// Bound the free-form blobs so a manage user (refs) or an agent token (meta) can't store
// multi-MB rows. The instruction is capped at its zod schema.
const META = z.record(z.string(), z.unknown()).refine((m) => JSON.stringify(m).length <= 8000, {
  message: "meta too large",
})
// A ref is a selector: a bare artifact short id (the shorthand) or a typed pointer at a
// collection or tag. Same discriminated-union pattern as the trigger.
const MODE = z.enum(["publish", "propose"]).optional()
const REF = z.union([
  z.string().min(1).max(512),
  z.object({ kind: z.literal("artifact"), id: z.string().min(1).max(512), mode: MODE }),
  z.object({ kind: z.literal("collection"), id: z.string().min(1).max(512), mode: MODE }),
  z.object({ kind: z.literal("tag"), tag: z.string().min(1).max(128), mode: MODE }),
])
const REFS = z.array(REF).max(100)
const TRIGGER = z.object({
  kind: z.enum(["manual", "schedule", "event"]),
  cron: z.string().optional(),
  tz: z.string().optional(),
  on: z.string().optional(),
})

export const automationRoutes = (ctx: AppContext) => {
  const {
    meta,
    agentFor,
    agentRunScope,
    agentSessionScope,
    privateOwnerId,
    requireUser,
    requireWorkspace,
    deps,
  } = ctx
  const app = new Hono()

  // The run lane reads "no run scope" as "a standing polling runner", which is the only
  // thing entitled to claim a BATCH, tick the schedule and sweep the queue. A session
  // capability token also has no run scope — so without this guard it inherited every one
  // of those powers, and a credential minted for a single question could claim this agent's
  // automation runs, execute their bound source tools, and settle them as succeeded.
  //
  // The two kinds are cryptographically distinct (separate signing domains), but that only
  // stops a token verifying as the wrong kind. It does not stop the wrong kind being
  // ACCEPTED somewhere kind was never checked, which is what happened here. The session lane
  // has always had the mirror of this (routes/contexts.ts refuses a standing bearer); the run
  // lane never got it. Check kind explicitly, at the door, on every run-lane endpoint.
  const isSessionBearer = (c: Context): boolean => agentSessionScope(c) !== null

  // ---- Owner surface: define / list / delete ---------------------------------
  app.post("/v1/automations", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const b = await readJson(
      c,
      z.object({
        // Omit to auto-mint a MANAGED agent for this automation — its own Derive
        // access, no roster persona, nothing to pick. Pass an id to run as an
        // existing (service) agent instead. Mirrors context creation (#525).
        agentId: z.string().optional(),
        trigger: TRIGGER,
        instruction: z.string().min(1).max(4000),
        refs: REFS.optional(),
        connectionIds: z.array(z.string().max(64)).max(20).optional(),
        // Bind a context: the automation becomes a scheduled use(context, instruction) — its
        // runs materialize the context's manifest + skills, and it runs AS the context's agent.
        contextId: z.string().max(64).optional(),
        enabled: z.boolean().default(true),
      }),
    )
    if (b instanceof Response) return bail(b)
    // A bound context must exist in this workspace, and it decides the acting agent: the run
    // must be the context's agent or the context's skills would belong to someone else. An
    // explicit agentId is allowed only when it AGREES.
    let boundContext = null as Awaited<ReturnType<typeof meta.getContext>> | null
    if (b.contextId) {
      boundContext = await meta.getContext(b.contextId)
      if (!boundContext || boundContext.org_id !== org)
        return bail(fail(c, 400, "context must exist in this workspace"))
      if (b.agentId && b.agentId !== boundContext.agent_id)
        return bail(fail(c, 400, "a context-bound automation runs as the context's agent"))
    }
    if (b.agentId) {
      // The agent must belong to this workspace — never an id from another tenant.
      const agents = await meta.listAgents(org)
      if (!agents.some((a) => a.id === b.agentId))
        return bail(fail(c, 400, "agent must be in this workspace"))
    }
    // Least privilege at bind time, not only at run time: the ids must be this workspace's,
    // and attachable by this caller. The route already gated on manage, hence canManage.
    if (b.connectionIds?.length) {
      const bindErr = await connectionBindError(
        meta,
        org,
        { userId: (await privateOwnerId(c)) ?? null, canManage: true },
        b.connectionIds,
      )
      if (bindErr) return bail(fail(c, 400, bindErr))
    }
    let agentId = b.agentId ?? boundContext?.agent_id ?? null
    let agentToken: string | null = null
    if (!agentId) {
      agentToken = `dk_agt_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`
      // Automations have no name; derive one from the instruction so the (hidden)
      // roster row is still recognizable. Names are unique per workspace — a
      // collision suffixes instead of failing the create.
      const base = b.instruction.trim().slice(0, 40).trim() || "Automation"
      const owner = (await privateOwnerId(c)) ?? null
      const mint = (name: string) =>
        meta.createAgent({
          id: newId("ag"),
          org_id: org,
          name,
          token: sha256(agentToken as string),
          role: "editor",
          created_by: owner,
          managed: 1,
        })
      const minted = await mint(base).catch(() => mint(`${base} ${randomUUID().slice(0, 4)}`))
      agentId = minted.id
    }
    // A webhook trigger gets a fire secret minted here: stored only as its sha256, the raw
    // secret returned ONCE in this response and never readable again (like an agent token).
    const trigger: AutomationTrigger = { ...b.trigger }
    let fireSecret: string | undefined
    if (trigger.kind === "event" && trigger.on === "webhook") {
      fireSecret = mintToken("dfire")
      trigger.secret_hash = sha256(fireSecret)
    }
    try {
      const rec = await meta.createAutomation({
        id: newId("auto"),
        org_id: org,
        agent_id: agentId,
        trigger: JSON.stringify(trigger satisfies AutomationTrigger),
        instruction: b.instruction,
        // Stored CANONICAL (bare strings become artifact selectors) so readers never re-guess.
        refs: b.refs ? JSON.stringify(normalizeSelectors(b.refs)) : null,
        connection_ids: b.connectionIds?.length ? JSON.stringify(b.connectionIds) : null,
        context_id: b.contextId ?? null,
        enabled: b.enabled ? 1 : 0,
      })
      // The auto-mint token + the fire secret/URL ride this create response ONCE.
      return c.json(
        {
          ...present(rec),
          ...(agentToken ? { agent_token: agentToken } : {}),
          ...(fireSecret
            ? { fire_secret: fireSecret, fire_url: `/v1/automations/${rec.id}/fire` }
            : {}),
        },
        201,
      )
    } catch (e) {
      // A failed create after an auto-mint must not strand an orphaned managed
      // agent (and its live token) — unwind the mint with the create.
      if (agentToken && agentId) await meta.deleteAgent(agentId, org).catch(() => {})
      throw e
    }
  })

  // Edit in place: instruction, trigger, refs (write modes ride IN them), the agent,
  // and enabled (pause/resume). Same manage gate as create; org-scoped update so a
  // shared short id can never cross tenants. Pausing composes with the existing
  // guards: run-now 400s and stale queued runs cancel at claim.
  app.patch("/v1/automations/:id", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const a = await meta.getAutomation(c.req.param("id"))
    if (!a || a.org_id !== org) return fail(c, 404, "not found")
    const b = await readJson(
      c,
      z.object({
        agentId: z.string().optional(),
        trigger: TRIGGER.optional(),
        instruction: z.string().min(1).max(4000).optional(),
        refs: REFS.nullable().optional(),
        enabled: z.boolean().optional(),
      }),
    )
    if (b instanceof Response) return bail(b)
    if (b.agentId !== undefined) {
      const agents = await meta.listAgents(org)
      if (!agents.some((ag) => ag.id === b.agentId))
        return bail(fail(c, 400, "agent must be in this workspace"))
    }
    const rec = await meta.updateAutomation(a.id, org, {
      agent_id: b.agentId,
      trigger: b.trigger ? JSON.stringify(b.trigger satisfies AutomationTrigger) : undefined,
      instruction: b.instruction,
      refs:
        b.refs === undefined
          ? undefined
          : b.refs === null
            ? null
            : JSON.stringify(normalizeSelectors(b.refs)),
      enabled: b.enabled === undefined ? undefined : b.enabled ? 1 : 0,
    })
    if (!rec) return fail(c, 404, "not found")
    return c.json(present(rec))
  })

  app.get("/v1/automations", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    // Each row carries its agent's runs-lane liveness so the UI can say, honestly,
    // whether ANYTHING executes this automation — null = no executor has ever polled.
    // One batched roster read (no-N+1), joined in memory.
    const [autos, agents] = await Promise.all([meta.listAutomations(org), meta.listAgents(org)])
    const seen = new Map(agents.map((a) => [a.id, a.runs_seen_at]))
    return c.json({
      automations: autos.map((a) => ({
        ...present(a),
        executor_seen_at: seen.get(a.agent_id) ?? null,
      })),
    })
  })

  app.delete("/v1/automations/:id", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const a = await meta.getAutomation(c.req.param("id"))
    if (!a || a.org_id !== org) return fail(c, 404, "not found")
    await meta.deleteAutomation(a.id, org)
    return c.body(null, 204)
  })

  // Run now: a write-capable member asks the automation to run. Enqueues a run scheduled
  // for now — the SAME path a schedule tick or a webhook takes. This is "refresh please".
  // Gated at `publish` (not just membership): triggering an agent action + paid model calls
  // is a write, so a viewer/commenter can't force it.
  app.post("/v1/automations/:id/run", async (c) => {
    const org = await requireWorkspace(c, "publish")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const a = await meta.getAutomation(c.req.param("id"))
    if (!a || a.org_id !== org) return fail(c, 404, "not found")
    // A disabled automation takes no new runs — from ANY trigger: this path, and the
    // future schedule tick / event kick must all check the same flag.
    if (a.enabled !== 1) return fail(c, 400, "automation is disabled")
    // Budget guard at enqueue (invariant 2): a run-now bills to the requester.
    if (await overBudget(meta, org, me.id)) return fail(c, 429, "monthly run budget reached")
    const rec = await meta.createRun({
      id: newId("run"),
      org_id: org,
      automation_id: a.id,
      agent_id: a.agent_id,
      reason: `manual:${me.id}`,
      // First-class, not parsed out of `reason`: the clicker's plan bills this run
      // (the wallet follows the initiator). Schedule/event enqueues leave it null.
      initiated_by: me.id,
      scheduled_for: isoNow(),
    })
    // Hosted runs: start it NOW rather than at the next tick, so "Run now" feels immediate.
    // Fire-and-forget — the tick is the guarantee, this is only the latency (and it is a no-op
    // on every deployment with hosted execution off).
    deps.pokeRun?.(rec.id)
    return c.json({ id: rec.id, status: rec.status }, 201)
  })

  // Fire URL: an external system (CI, a zap, curl) triggers this automation by POSTing to a
  // per-automation secret URL — the webhook kick the run queue was built for. The body becomes
  // run input; a burst coalesces into one run.
  // authz-exempt: the per-automation fire secret (sha256-checked in constant time) is the gate, not a session.
  app.post("/v1/automations/:id/fire", async (c) => {
    const a = await meta.getAutomation(c.req.param("id"))
    // 404 both for a missing automation and one that isn't webhook-fireable — never reveal
    // which, so a probe can't enumerate ids or learn a given automation's trigger kind.
    if (!a) return fail(c, 404, "not found")
    const trigger = parseTrigger(a.trigger)
    if (trigger.on !== "webhook" || !trigger.secret_hash) return fail(c, 404, "not found")
    // Constant-time check of the presented bearer against the stored hash.
    const presented = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "")
    if (!safeEqual(trigger.secret_hash, sha256(presented))) return fail(c, 401, "invalid secret")
    // Same enabled-gate as run-now: a disabled automation takes no new runs from ANY trigger.
    // (The killswitch stays enforced downstream at claim, exactly as for the other triggers.)
    if (a.enabled !== 1) return fail(c, 400, "automation is disabled")
    // Budget guard at enqueue (invariant 2): a fire bills to the workspace pool (no user).
    if (await overBudget(meta, a.org_id, null)) return fail(c, 429, "monthly run budget reached")
    // Read the body under a hard cap, then parse. An empty body fires with an empty payload.
    const raw = await c.req.text()
    if (raw.length > MAX_FIRE_BODY_BYTES) return fail(c, 413, "payload too large")
    let payload: unknown = {}
    if (raw.trim() !== "") {
      try {
        payload = JSON.parse(raw)
      } catch {
        return fail(c, 400, "body must be JSON")
      }
    }
    // Coalesce into an open queued run for this automation if one exists; otherwise enqueue a
    // fresh run carrying the first payload. A lost CAS (a concurrent claim or append) falls
    // through to a fresh run, so a payload is never dropped.
    const now = Date.now()
    const cutoff = new Date(now + COALESCE_WINDOW_MS).toISOString()
    const open = await meta.findCoalescibleRun(a.id, cutoff)
    if (open) {
      const appended = await meta.appendRunPayload(open.id, payload, MAX_FIRE_META_BYTES)
      if (appended)
        return c.json({ id: appended.id, status: appended.status, coalesced: true }, 202)
    }
    const rec = await meta.createRun({
      id: newId("run"),
      org_id: a.org_id,
      automation_id: a.id,
      agent_id: a.agent_id,
      reason: "fire",
      scheduled_for: new Date(now).toISOString(),
      meta: JSON.stringify({ payloads: [payload] }),
    })
    // Same immediate start for an external trigger (CI, a zap, curl): a fire URL that takes a
    // minute to visibly do anything reads as broken.
    deps.pokeRun?.(rec.id)
    return c.json({ id: rec.id, status: rec.status, coalesced: false }, 202)
  })

  // ---- Agent surface: claim due runs, finish them, record ad-hoc runs ---------
  // The executor CONTRACT: an agent claims the oldest queued runs due now (its own), flipped
  // to running under a row lock so replicas never double-run, then finishes each. This is the
  // surface an executor drives; wiring the executor loop that polls it (and reclaims runs
  // orphaned by a crashed worker) is deployment work, deferred alongside the schedule tick and
  // the webhook kick. Today the queue is fed by run-now and drained in tests + a future loop.
  app.get("/v1/agent/runs/claim", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20))
    // The runs-lane heartbeat (twin of the session queue's runner_seen_at): throttled
    // to ~minutely, best-effort — liveness display must never fail a claim. Both claim
    // shapes beat, so an automation executed by hosted dispatch reads as live too.
    if (!agent.runs_seen_at || Date.now() - new Date(agent.runs_seen_at).getTime() > 60_000)
      await meta.touchAgentRunsSeen(agent.id, isoNow()).catch(() => {})
    // Two claim shapes, one contract. A run-scoped capability bearer (hosted dispatch) claims
    // EXACTLY its run — no batch, no schedule tick, and the SKIP-LOCKED flip means a
    // double-booted substrate loses the race and gets an empty claim. A standing agent bearer
    // (a polling runner) materializes its due schedule runs first — the poll IS the tick —
    // then claims the oldest due batch.
    if (isSessionBearer(c)) return fail(c, 403, "a session token cannot claim runs")
    const scope = agentRunScope(c)
    let claimed: Awaited<ReturnType<typeof meta.claimDueRuns>>
    if (scope) {
      const one = await meta.claimRunById(scope, agent.id, isoNow())
      claimed = one ? [one] : []
    } else {
      // Best-effort (a bad cron is skipped), and never blocks the claim on failure. The
      // reclaim sweep rides along: runs whose substrate died (running past the 30-minute
      // lease) go back to queued, so a polling runner self-heals the queue as it drains it.
      await materializeDueRuns(meta, agent, new Date()).catch(() => 0)
      await meta.reclaimStaleRuns(new Date(Date.now() - 30 * 60_000).toISOString()).catch(() => 0)
      claimed = await meta.claimDueRuns(agent.id, isoNow(), limit)
    }
    // Resolve each claimed run's automation DIRECTLY by id, in ONE batched query — never
    // via a capped org-wide list (which silently loses instructions past its limit), and
    // never a per-id loop (the no-N+1 rule).
    const ids = [...new Set(claimed.map((r) => r.automation_id).filter((x): x is string => !!x))]
    const byId = new Map((await meta.getAutomationsByIds(ids)).map((a) => [a.id, a]))
    // Resolve the gate inputs server-side, FRESH at claim time (so a flipped killswitch is
    // seen on the next claim): flags from org settings; write mode rides per-target in refs.
    // The executor gets everything it needs to run each run in one call — no extra round-trips.
    const s = await meta.getOrgSettings(agent.org_id)
    const flags = { agentKillswitch: s.agentKillswitch, agentAutoEnabled: s.agentAutoEnabled }
    // Defense-in-depth: a run whose automation vanished (the delete race), was disabled after
    // enqueue, or carries no instruction must never reach the executor — it would burn a model
    // call on an empty task. Finish it as failed/cancelled here and hand back only real work.
    const runnable: { r: (typeof claimed)[number]; a: AutomationRecord }[] = []
    const cancelled: string[] = []
    for (const r of claimed) {
      const a = r.automation_id ? byId.get(r.automation_id) : undefined
      if (a && a.org_id === agent.org_id && a.enabled === 1 && a.instruction.trim() !== "") {
        runnable.push({ r, a })
      } else {
        cancelled.push(r.id)
      }
    }
    // Concurrent, not per-row sequential — the rare cancel path shouldn't serialize.
    const cancelAt = isoNow()
    await Promise.all(
      cancelled.map((id) =>
        meta.finishRun(id, agent.id, {
          status: "failed",
          finishedAt: cancelAt,
          meta: JSON.stringify({ outcome: "cancelled", why: "automation missing or disabled" }),
        }),
      ),
    )
    // One broker for this workspace (the owner's Composio plan → its key, else the LocalBroker),
    // used to resolve each run's LEAST-PRIVILEGE source tools: a run gets the tools of ITS
    // automation's bound connections only. The runner's shim calls these back through the tool
    // endpoint below — credentials never leave the API.
    const broker = runnable.length
      ? await brokerFor(meta, agent.org_id, null, deps.encryptionKey)
      : null
    const runs = await Promise.all(
      runnable.map(async ({ r, a }) => {
        const connIds = parseConnectionIds(a.connection_ids)
        const tools =
          broker && connIds.length ? await toolsForRun(meta, broker, agent.org_id, connIds) : []
        return {
          id: r.id,
          reason: r.reason,
          // The wallet key: whose plan this run bills (null = clock/event → registrant
          // today, the workspace pool once it lands). The executor passes it back on
          // the model-credential fetch via ?run=.
          initiated_by: r.initiated_by,
          automation_id: r.automation_id,
          // The bound context, when there is one: the executor materializes its manifest +
          // skills as the run's system prompt (the ask lane's bootHost machinery, reused).
          context_id: a.context_id,
          instruction: a.instruction,
          // Canonical selectors: artifact = revise it, collection = file new work there,
          // tag = the platform stamps it on every write. Each target's `mode` says how the
          // write lands (publish live vs propose, default propose) — the executor maps it
          // per write; it never re-derives semantics.
          targets: parseRefs(a.refs),
          // The run's source tools (name/description/params + broker ref), least-privilege.
          // Projected field by field on purpose: RunTool also carries routing detail the
          // executor has no use for, and this endpoint is the last stop before the wire.
          tools: tools.map((t) => ({ def: t.def, ref: t.ref })),
          // What fired it, when something sent a body. /fire stores each webhook payload on
          // the run (coalescing a burst into one run of many payloads), and this is where they
          // reach the executor. Without it the fire-URL path was write-only: payloads were
          // validated, capped, coalesced and CAS-appended, and then no consumer ever read
          // them, so a webhook-triggered run executed as though a clock had started it. Empty
          // for schedule and manual runs.
          payloads: parseRunMeta(r.meta).payloads ?? [],
          flags,
        }
      }),
    )
    return c.json({ runs })
  })

  // Finish a claimed run: terminal status + cost + result meta. Only the claiming agent, and
  // a run-scoped capability bearer can settle ONLY its own run.
  app.post("/v1/agent/runs/:id/finish", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    if (isSessionBearer(c)) return fail(c, 403, "a session token cannot act on a run")
    const scope = agentRunScope(c)
    if (scope && scope !== c.req.param("id")) return fail(c, 404, "not found")
    const b = await readJson(
      c,
      z.object({
        status: z.enum(["succeeded", "failed"]),
        cost_micro_usd: z.number().int().nonnegative().nullish(),
        meta: META.nullish(),
      }),
    )
    if (b instanceof Response) return bail(b)
    const runId = c.req.param("id")
    // RETRY, not resurrection. A run that failed for a TRANSIENT reason (the executor says
    // `retryable`: a provider 5xx/429, a timeout, a failed spawn) goes back to the queue with a
    // backoff instead of settling. A deterministic failure — no revision block, a rejected
    // write, an empty instruction — is terminal: retrying it would fail identically while
    // spending the owner's model plan again. The cap is small for the same reason.
    if (b.status === "failed" && b.meta?.retryable === true) {
      const prior = await meta.getRun(runId)
      const retries = runCounter(parseRunMeta(prior?.meta), "retries")
      if (retries < RUN_MAX_RETRIES) {
        const attempt = retries + 1
        const requeued = await meta.requeueRun(runId, agent.id, {
          scheduledFor: new Date(Date.now() + retryDelayMs(attempt)).toISOString(),
          // MERGE onto the run's existing meta, never replace it — the rule run-meta.ts
          // states and reclaimStaleRuns already follows. Replacing dropped two things that
          // live there: the fire-URL `payloads` (so a retried webhook run executed with no
          // input at all), and the `attempts` counter written by the reclaim sweep (so the
          // retry cap and the attempt cap stopped composing, allowing far more executions
          // than either was set to permit).
          meta: mergeRunMeta(prior?.meta, {
            ...b.meta,
            retries: attempt,
            last_error: b.meta.why ?? null,
          }),
        })
        if (requeued) return c.json({ id: requeued.id, status: requeued.status, retry: attempt })
      }
    }
    // MERGE, like every other writer of run.meta (run-meta.ts states the rule; the reclaim
    // sweep and the retry path above both follow it). Replacing here erased the run's own
    // history at the moment it settled: the `attempts` the reclaim sweep had recorded, so a
    // run that failed twice and then succeeded reported zero retries in the timeline built to
    // answer exactly that question — and the `payloads` of a webhook-triggered run, so the
    // ledger no longer showed what it had acted on. Found by the dispatch simulation.
    const settling = await meta.getRun(runId)
    const rec = await meta.finishRun(runId, agent.id, {
      status: b.status,
      finishedAt: isoNow(),
      costMicroUsd: b.cost_micro_usd ?? null,
      meta: b.meta ? mergeRunMeta(settling?.meta, b.meta) : (settling?.meta ?? null),
    })
    return rec ? c.json({ id: rec.id, status: rec.status }) : fail(c, 404, "not found")
  })

  // Execute a source tool for a claimed run — the least-privilege callback the runner's shim
  // uses when the agent invokes one of the run's bound-connection tools. Resolves the run → its
  // automation's bound source tools (the SAME least-privilege set the claim returned), so the
  // shim only sends a tool NAME: the server maps it to the connected-account ref, verifies it is
  // one of THIS run's tools, and runs it through the broker. Credentials stay server-side; the
  // runner only ever holds tool names. An explicit `ref` is still honored (and re-checked).
  app.post("/v1/agent/runs/:id/tool", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    // A run-scoped capability bearer pulls ONLY through its own run's tools.
    if (isSessionBearer(c)) return fail(c, 403, "a session token cannot act on a run")
    const scope = agentRunScope(c)
    if (scope && scope !== c.req.param("id")) return fail(c, 404, "not found")
    const run = await meta.getRun(c.req.param("id"))
    if (!run || run.agent_id !== agent.id || run.org_id !== agent.org_id)
      return fail(c, 404, "not found")
    const b = await readJson(
      c,
      z.object({
        tool: z.string().max(200),
        args: z.unknown().optional(),
        ref: z.string().max(200).optional(),
      }),
    )
    if (b instanceof Response) return bail(b)
    const auto = run.automation_id ? await meta.getAutomation(run.automation_id) : null
    const connIds = parseConnectionIds(auto?.connection_ids ?? null)
    if (connIds.length === 0) return fail(c, 403, "run has no bound sources")
    // Resolve the run's allowed (tool → ref) set once, least-privilege. The requested tool must
    // be one of them; if a ref is supplied it must match that tool's ref (never cross to another).
    const broker = await brokerFor(meta, agent.org_id, null, deps.encryptionKey)
    const allowed = await toolsForRun(meta, broker, agent.org_id, connIds)
    const match = allowed.find((t) => t.def.name === b.tool && (!b.ref || t.ref === b.ref))
    if (!match) return fail(c, 403, "tool not allowed for this run")
    try {
      // A pasted-secret connection has no vendor, so Derive executes it: the credential is
      // fetched, decrypted and spent here. Either way the runner only ever sent a tool NAME.
      if (match.kind === "secret") {
        if (!deps.encryptionKey) return fail(c, 502, "secret connections need an encryption key")
        const cn = await meta.getConnection(match.connectionId)
        if (!cn || cn.org_id !== agent.org_id) return fail(c, 404, "not found")
        const result = await executeSecretTool(cn, b.tool, b.args ?? {}, deps.encryptionKey)
        return c.json({ result })
      }
      const result = await broker.execute({ ref: match.ref, tool: b.tool, args: b.args ?? {} })
      return c.json({ result })
    } catch (e) {
      return fail(c, 502, e instanceof Error ? e.message : "tool failed")
    }
  })

  // Record an already-finished run straight into the ledger — the host's best-effort write
  // after a live invoke. org_id + agent_id come from the RESOLVED principal, never the body.
  app.post("/v1/agent/runs", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    const b = await readJson(
      c,
      z.object({
        reason: z.string().min(1).max(120),
        status: z.enum(["succeeded", "failed"]).default("succeeded"),
        automation_id: z.string().max(64).nullish(),
        cost_micro_usd: z.number().int().nonnegative().nullish(),
        meta: META.nullish(),
      }),
    )
    if (b instanceof Response) return bail(b)
    // Only attribute the run to an automation that actually belongs to this agent's org —
    // an unknown or foreign id is dropped (ledger hygiene), the run still records.
    let automationId = b.automation_id ?? null
    if (automationId) {
      const owner = await meta.getAutomation(automationId)
      if (!owner || owner.org_id !== agent.org_id) automationId = null
    }
    const now = isoNow()
    const rec = await meta.createRun({
      id: newId("run"),
      org_id: agent.org_id,
      agent_id: agent.id,
      automation_id: automationId,
      reason: b.reason,
      status: b.status,
      started_at: now,
      finished_at: now,
      cost_micro_usd: b.cost_micro_usd ?? null,
      meta: b.meta ? JSON.stringify(b.meta) : null,
    })
    return c.json({ id: rec.id }, 201)
  })

  return app
}
