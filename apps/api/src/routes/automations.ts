import { randomUUID } from "node:crypto"
import {
  type AutomationRecord,
  type AutomationTrigger,
  newId,
  normalizeSelectors,
  type Selector,
} from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { sha256 } from "../lib/crypto"
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

/** Stored refs → canonical selectors. Rows predating selectors hold bare short-id strings;
 *  normalizeSelectors turns those into artifact selectors, so every historical row stays
 *  valid with no migration. Malformed JSON parses to []. */
const parseRefs = (raw: string | null): Selector[] => {
  try {
    if (raw) return normalizeSelectors(JSON.parse(raw))
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
  const { meta, agentFor, privateOwnerId, requireUser, requireWorkspace } = ctx
  const app = new Hono()

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
        enabled: z.boolean().default(true),
      }),
    )
    if (b instanceof Response) return bail(b)
    if (b.agentId) {
      // The agent must belong to this workspace — never an id from another tenant.
      const agents = await meta.listAgents(org)
      if (!agents.some((a) => a.id === b.agentId))
        return bail(fail(c, 400, "agent must be in this workspace"))
    }
    let agentId = b.agentId ?? null
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
    try {
      const rec = await meta.createAutomation({
        id: newId("auto"),
        org_id: org,
        agent_id: agentId,
        trigger: JSON.stringify(b.trigger satisfies AutomationTrigger),
        instruction: b.instruction,
        // Stored CANONICAL (bare strings become artifact selectors) so readers never re-guess.
        refs: b.refs ? JSON.stringify(normalizeSelectors(b.refs)) : null,
        enabled: b.enabled ? 1 : 0,
      })
      return c.json({ ...present(rec), ...(agentToken ? { agent_token: agentToken } : {}) }, 201)
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
    // The runs-lane heartbeat (twin of the session queue's runner_seen_at): throttled
    // to ~minutely, best-effort — liveness display must never fail a claim.
    if (!agent.runs_seen_at || Date.now() - new Date(agent.runs_seen_at).getTime() > 60_000)
      await meta.touchAgentRunsSeen(agent.id, isoNow()).catch(() => {})
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
        // The wallet key: whose plan this run bills (null = clock/event → registrant
        // today, the workspace pool once it lands). The executor passes it back on
        // the model-credential fetch via ?run=.
        initiated_by: r.initiated_by,
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
