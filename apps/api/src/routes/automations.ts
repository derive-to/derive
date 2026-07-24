import {
  type AutomationRecord,
  type AutomationTrigger,
  newId,
  normalizeSelectors,
} from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { parseRefs, parseTrigger } from "../lib/automation"
import { overBudget } from "../lib/budget"
import { mintToken, safeEqual, sha256 } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"

// WP5/WP6 — automations + runs, the generic agent-work primitive. An automation is a
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

export const automationRoutes = (ctx: AppContext) => {
  const { meta, agentFor, requireUser, requireWorkspace } = ctx
  const app = new Hono()

  // ---- Owner surface: define / list / delete ---------------------------------
  app.post("/v1/automations", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const b = await readJson(
      c,
      z.object({
        agentId: z.string(),
        trigger: z.object({
          kind: z.enum(["manual", "schedule", "event", "view"]),
          cron: z.string().optional(),
          tz: z.string().optional(),
          on: z.string().optional(),
          maxAgeMinutes: z.number().int().nonnegative().optional(),
        }),
        instruction: z.string().min(1).max(4000),
        refs: REFS.optional(),
        enabled: z.boolean().default(true),
      }),
    )
    if (b instanceof Response) return bail(b)
    // The agent must belong to this workspace — never an id from another tenant.
    const agents = await meta.listAgents(org)
    if (!agents.some((a) => a.id === b.agentId))
      return bail(fail(c, 400, "agent must be in this workspace"))
    // A webhook trigger gets a fire secret minted here: stored only as its sha256, the raw
    // secret returned ONCE in this response and never readable again (like an agent token).
    const trigger: AutomationTrigger = { ...b.trigger }
    let fireSecret: string | undefined
    if (trigger.kind === "event" && trigger.on === "webhook") {
      fireSecret = mintToken("dfire")
      trigger.secret_hash = sha256(fireSecret)
    }
    const rec = await meta.createAutomation({
      id: newId("auto"),
      org_id: org,
      agent_id: b.agentId,
      trigger: JSON.stringify(trigger satisfies AutomationTrigger),
      instruction: b.instruction,
      // Stored CANONICAL (bare strings become artifact selectors) so readers never re-guess.
      refs: b.refs ? JSON.stringify(normalizeSelectors(b.refs)) : null,
      enabled: b.enabled ? 1 : 0,
    })
    const out = present(rec)
    // The secret + ready-to-copy fire URL ride this create response only.
    return c.json(
      fireSecret
        ? { ...out, fire_secret: fireSecret, fire_url: `/v1/automations/${rec.id}/fire` }
        : out,
      201,
    )
  })

  app.get("/v1/automations", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    return c.json({ automations: (await meta.listAutomations(org)).map(present) })
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
      scheduled_for: isoNow(),
    })
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
    const claimed = await meta.claimDueRuns(agent.id, isoNow(), limit)
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
    return c.json({
      runs: runnable.map(({ r, a }) => ({
        id: r.id,
        reason: r.reason,
        automation_id: r.automation_id,
        instruction: a.instruction,
        // Canonical selectors: artifact = revise it, collection = file new work there,
        // tag = the platform stamps it on every write. Each target's `mode` says how the
        // write lands (publish live vs propose, default propose) — the executor maps it
        // per write; it never re-derives semantics.
        targets: parseRefs(a.refs),
        flags,
      })),
    })
  })

  // Finish a claimed run: terminal status + cost + result meta. Only the claiming agent.
  app.post("/v1/agent/runs/:id/finish", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    const b = await readJson(
      c,
      z.object({
        status: z.enum(["succeeded", "failed"]),
        cost_micro_usd: z.number().int().nonnegative().nullish(),
        meta: META.nullish(),
      }),
    )
    if (b instanceof Response) return bail(b)
    const rec = await meta.finishRun(c.req.param("id"), agent.id, {
      status: b.status,
      finishedAt: isoNow(),
      costMicroUsd: b.cost_micro_usd ?? null,
      meta: b.meta ? JSON.stringify(b.meta) : null,
    })
    return rec ? c.json({ id: rec.id, status: rec.status }) : fail(c, 404, "not found")
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
