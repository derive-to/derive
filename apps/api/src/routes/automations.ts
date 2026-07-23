import { type AutomationRecord, type AutomationTrigger, newId } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"

// WP5/WP6 — automations + runs, the generic agent-work primitive. An automation is a
// standing job: WHO (agent), WHEN (trigger: manual | schedule | event), WHAT (free-form
// instruction), on WHAT (refs). Every firing is a run; the run table is both the queue
// (status=queued) and the ledger (terminal rows). A "living doc" is just an automation whose
// instruction keeps a doc current — refreshing it is "run now", the same verb a schedule
// tick or a webhook uses. Plain routes (agent-facing + admin), not the OpenAPI web surface.

const isoNow = () => new Date().toISOString()

const parseTrigger = (raw: string): AutomationTrigger => {
  try {
    const t = JSON.parse(raw)
    if (t && typeof t === "object") return t as AutomationTrigger
  } catch {}
  return { kind: "manual" }
}

const parseRefs = (raw: string | null): string[] => {
  try {
    if (raw) {
      const r = JSON.parse(raw)
      if (Array.isArray(r)) return r as string[]
    }
  } catch {}
  return []
}

/** Present an automation with its JSON blobs parsed and enabled as a boolean. Both blobs
 *  parse defensively so a single malformed row can't 500 every list/claim response. */
const present = (a: AutomationRecord) => ({
  ...a,
  trigger: parseTrigger(a.trigger),
  refs: parseRefs(a.refs),
  enabled: a.enabled === 1,
})

// Bound the free-form blobs so a manage user (refs) or an agent token (meta) can't store
// multi-MB rows. The instruction is capped at its zod schema.
const META = z.record(z.string(), z.unknown()).refine((m) => JSON.stringify(m).length <= 8000, {
  message: "meta too large",
})
const REFS = z.array(z.string().max(512)).max(100)

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
          kind: z.enum(["manual", "schedule", "event"]),
          cron: z.string().optional(),
          tz: z.string().optional(),
          on: z.string().optional(),
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
    const rec = await meta.createAutomation({
      id: newId("auto"),
      org_id: org,
      agent_id: b.agentId,
      trigger: JSON.stringify(b.trigger satisfies AutomationTrigger),
      instruction: b.instruction,
      refs: b.refs ? JSON.stringify(b.refs) : null,
      enabled: b.enabled ? 1 : 0,
    })
    return c.json(present(rec), 201)
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
        refs: parseRefs(a.refs),
        autonomy: "suggest",
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
