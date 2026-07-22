import type { LivingRoute } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"

// WP5 — the living-artifact contract. Two audiences, plain routes (agent-facing +
// admin, not the OpenAPI web surface):
//   · the OWNER declares/reads/clears an artifact's living maintenance
//   · the MAINTAINER AGENT pulls due work (claim/lease) and settles it
// The freshness clock is server-computed from the cadence, so a lease can never
// let two executor replicas maintain one artifact at once.

const LEASE_MS = 5 * 60_000

const isoNow = () => new Date().toISOString()
const plusSeconds = (from: string, seconds: number): string =>
  new Date(Date.parse(from) + seconds * 1000).toISOString()

/** Present the record with a computed freshness flag: stale once the cadence +
 *  its grace window have elapsed past the last settle (or creation). */
const withFreshness = (l: {
  next_due_at: string
  freshness_window_seconds: number
  last_settled_at: string | null
}) => {
  const staleAfter = plusSeconds(l.next_due_at, l.freshness_window_seconds)
  return { ...l, stale: Date.parse(staleAfter) <= Date.now() }
}

export const livingRoutes = (ctx: AppContext) => {
  const { meta, agentFor, requireArtifact } = ctx
  const app = new Hono()

  // ---- Owner surface: declare / read / clear -----------------------------
  app.put("/v1/artifacts/:shortId/living", async (c) => {
    const artifact = await requireArtifact(c, "manage")
    if (artifact instanceof Response) return artifact
    const b = await readJson(
      c,
      z.object({
        maintainerAgentId: z.string(),
        cadenceSeconds: z.number().int().min(60).max(31_536_000),
        freshnessWindowSeconds: z.number().int().min(0).max(31_536_000).default(0),
        route: z.enum(["auto", "proposal"]).default("proposal"),
      }),
    )
    if (b instanceof Response) return bail(b)
    // The maintainer must be an agent in this workspace — never an id from
    // another tenant, and never a non-agent.
    const agents = await meta.listAgents(artifact.org_id)
    if (!agents.some((a) => a.id === b.maintainerAgentId))
      return bail(fail(c, 400, "maintainer must be an agent in this workspace"))
    const now = isoNow()
    const rec = await meta.setLivingArtifact({
      artifact_id: artifact.id,
      org_id: artifact.org_id,
      maintainer_agent_id: b.maintainerAgentId,
      cadence_seconds: b.cadenceSeconds,
      freshness_window_seconds: b.freshnessWindowSeconds,
      route: b.route as LivingRoute,
      next_due_at: plusSeconds(now, b.cadenceSeconds),
    })
    return c.json(withFreshness(rec))
  })

  app.get("/v1/artifacts/:shortId/living", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    const rec = await meta.getLivingArtifact(artifact.id)
    return rec ? c.json(withFreshness(rec)) : c.json({ living: null })
  })

  app.delete("/v1/artifacts/:shortId/living", async (c) => {
    const artifact = await requireArtifact(c, "manage")
    if (artifact instanceof Response) return artifact
    await meta.deleteLivingArtifact(artifact.id)
    return c.body(null, 204)
  })

  // ---- Maintainer surface: pull due work + settle ------------------------
  // The formalized executor contract: an agent claims the living artifacts it
  // maintains that are due, under a lease so replicas don't double-run.
  app.get("/v1/agent/work", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20))
    const due = await meta.claimDueLivingArtifacts(agent.id, isoNow(), LEASE_MS, limit)
    // The claim keys on the internal artifact id, but every agent read/publish
    // surface is keyed by short_id — so resolve the batch (one query, no N+1) and
    // hand back the short_id + title the agent actually acts on. An artifact
    // deleted out from under a live lease is simply dropped from the batch.
    const byId = new Map(
      (await meta.getArtifactsByIds(due.map((l) => l.artifact_id))).map((a) => [a.id, a]),
    )
    return c.json({
      lease_ms: LEASE_MS,
      work: due.flatMap((l) => {
        const art = byId.get(l.artifact_id)
        if (!art) return []
        return [
          {
            artifact_id: l.artifact_id,
            short_id: art.short_id,
            title: art.title,
            route: l.route,
            cadence_seconds: l.cadence_seconds,
            last_settled_at: l.last_settled_at,
            leased_until: l.leased_until,
          },
        ]
      }),
    })
  })

  // Settle a maintained artifact: stamp the settle time and roll the next due
  // date forward by the cadence, clearing the lease. Only the maintainer.
  app.post("/v1/agent/work/:artifactId/settle", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    const existing = await meta.getLivingArtifact(c.req.param("artifactId"))
    if (!existing || existing.maintainer_agent_id !== agent.id) return fail(c, 404, "not found")
    const now = isoNow()
    const rec = await meta.settleLivingArtifact(
      existing.artifact_id,
      agent.id,
      now,
      plusSeconds(now, existing.cadence_seconds),
    )
    return rec ? c.json(withFreshness(rec)) : fail(c, 404, "not found")
  })

  return app
}
