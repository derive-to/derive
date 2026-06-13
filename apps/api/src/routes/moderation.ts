import { newId } from "@dock/core"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { str } from "../lib/http"

/** Abuse reports (public) + takedown / reinstate / audit (Admin). A taken-down
 *  artifact keeps its record but serves no content (410). */
export const moderationRoutes = (ctx: AppContext) => {
  const { meta, actingUser, workspaceCan } = ctx
  const app = new Hono()

  // Anyone can report a public artifact for abuse. Rate-limited by the global
  // per-IP limiter on mutating /v1; the reporter's IP is recorded best-effort.
  // authz-exempt: abuse reports are intentionally public (any visitor can report)
  app.post("/v1/artifacts/:shortId/report", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return c.json({ error: "not found" }, 404)
    const b = (await c.req.json().catch(() => ({}))) as { reason?: unknown; detail?: unknown }
    const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : ""
    if (!reason) return c.json({ error: "reason required" }, 400)
    const ip = (
      c.req.header("x-forwarded-for")?.split(",")[0] ??
      c.req.header("x-real-ip") ??
      ""
    ).trim()
    const id = newId("rep")
    await meta.createReport({
      id,
      artifact_id: artifact.id,
      artifact_short_id: artifact.short_id,
      reason,
      detail: str(b.detail) ?? null,
      reporter: ip || null,
    })
    await meta.createAuditLog({
      id: newId("aud"),
      action: "report",
      artifact_id: artifact.id,
      actor: ip || "anonymous",
      detail: reason,
    })
    return c.json({ ok: true }, 201)
  })

  // The owner's moderation queue: open reports with their artifacts.
  app.get("/v1/reports", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const reports = await meta.listReports({ state: "open", limit: 200 })
    return c.json({ reports, open: reports.length })
  })

  app.get("/v1/audit", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    return c.json({ audit: await meta.listAuditLog({ limit: 200 }) })
  })

  // Take an artifact down: its content 410s everywhere, the record stays, and
  // any open reports against it are marked actioned.
  app.post("/v1/artifacts/:shortId/takedown", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return c.json({ error: "not found" }, 404)
    const who = (await actingUser(c))?.name ?? "owner"
    const b = (await c.req.json().catch(() => ({}))) as { note?: unknown }
    await meta.setArtifactRemoved(artifact.id, new Date().toISOString())
    for (const r of await meta.listReports({ state: "open" }))
      if (r.artifact_id === artifact.id) await meta.setReportState(r.id, "actioned")
    await meta.createAuditLog({
      id: newId("aud"),
      action: "takedown",
      artifact_id: artifact.id,
      actor: who,
      detail: str(b.note) ?? null,
    })
    return c.json({ ok: true, removed: true })
  })

  // Reverse a takedown.
  app.post("/v1/artifacts/:shortId/reinstate", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return c.json({ error: "not found" }, 404)
    const who = (await actingUser(c))?.name ?? "owner"
    await meta.setArtifactRemoved(artifact.id, null)
    await meta.createAuditLog({
      id: newId("aud"),
      action: "reinstate",
      artifact_id: artifact.id,
      actor: who,
      detail: null,
    })
    return c.json({ ok: true, removed: false })
  })

  // Dismiss a report without taking the artifact down.
  app.post("/v1/reports/:id/dismiss", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    await meta.setReportState(c.req.param("id"), "dismissed")
    await meta.createAuditLog({
      id: newId("aud"),
      action: "dismiss",
      artifact_id: null,
      actor: (await actingUser(c))?.name ?? "owner",
      detail: c.req.param("id"),
    })
    return c.json({ ok: true })
  })

  return app
}
