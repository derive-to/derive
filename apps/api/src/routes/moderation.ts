import { newId } from "@dock/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { fail, readJson, str } from "../lib/http"

/** Abuse reports (public) + takedown / reinstate / audit (Admin). A taken-down
 *  artifact keeps its record but serves no content (410). */
export const moderationRoutes = (ctx: AppContext) => {
  const { meta, actingUser, workspaceCan, activeWorkspace, isSuperAdmin } = ctx
  const app = new Hono()

  // Anyone can report a public artifact for abuse. Rate-limited by the global
  // per-IP limiter on mutating /v1; the reporter's IP is recorded best-effort.
  // authz-exempt: abuse reports are intentionally public (any visitor can report)
  app.post("/v1/artifacts/:shortId/report", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return fail(c, 404, "not found")
    const b = await readJson(
      c,
      z.object({
        reason: z.string().refine((s) => s.trim() !== "", "reason required"),
        detail: z.unknown(),
      }),
    )
    if (b instanceof Response) return b
    const reason = b.reason.trim()
    const ip = (
      c.req.header("x-forwarded-for")?.split(",")[0] ??
      c.req.header("x-real-ip") ??
      ""
    ).trim()
    const id = newId("rep")
    await meta.createReport({
      id,
      org_id: artifact.org_id,
      artifact_id: artifact.id,
      artifact_short_id: artifact.short_id,
      reason,
      detail: str(b.detail) ?? null,
      reporter: ip || null,
    })
    await meta.createAuditLog({
      id: newId("aud"),
      org_id: artifact.org_id,
      action: "report",
      artifact_id: artifact.id,
      actor: ip || "anonymous",
      detail: reason,
    })
    return c.json({ ok: true }, 201)
  })

  // The owner's moderation queue: open reports with their artifacts.
  app.get("/v1/reports", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    // A super-admin operator sees every workspace's reports (the global queue);
    // a workspace Admin sees only their own.
    const scope = (await isSuperAdmin(c)) ? undefined : await activeWorkspace(c)
    const reports = await meta.listReports(scope, { state: "open", limit: 200 })
    return c.json({ reports, open: reports.length })
  })

  app.get("/v1/audit", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const scope = (await isSuperAdmin(c)) ? undefined : await activeWorkspace(c)
    return c.json({ audit: await meta.listAuditLog(scope, { limit: 200 }) })
  })

  // Take an artifact down: its content 410s everywhere, the record stays, and
  // any open reports against it are marked actioned.
  app.post("/v1/artifacts/:shortId/takedown", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    // A super-admin (operator) takes down any artifact globally; a workspace
    // Admin only within their own workspace.
    if (!artifact || (!(await isSuperAdmin(c)) && artifact.org_id !== (await activeWorkspace(c))))
      return fail(c, 404, "not found")
    const who = (await actingUser(c))?.name ?? "owner"
    const b = await readJson(c, z.object({ note: z.unknown() }))
    if (b instanceof Response) return b
    await meta.setArtifactRemoved(artifact.id, new Date().toISOString())
    for (const r of await meta.listReports(artifact.org_id, { state: "open" }))
      if (r.artifact_id === artifact.id)
        await meta.setReportState(r.id, "actioned", artifact.org_id)
    await meta.createAuditLog({
      id: newId("aud"),
      org_id: artifact.org_id,
      action: "takedown",
      artifact_id: artifact.id,
      actor: who,
      detail: str(b.note) ?? null,
    })
    return c.json({ ok: true, removed: true })
  })

  // Reverse a takedown.
  app.post("/v1/artifacts/:shortId/reinstate", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || (!(await isSuperAdmin(c)) && artifact.org_id !== (await activeWorkspace(c))))
      return fail(c, 404, "not found")
    const who = (await actingUser(c))?.name ?? "owner"
    await meta.setArtifactRemoved(artifact.id, null)
    await meta.createAuditLog({
      id: newId("aud"),
      org_id: artifact.org_id,
      action: "reinstate",
      artifact_id: artifact.id,
      actor: who,
      detail: null,
    })
    return c.json({ ok: true, removed: false })
  })

  // Dismiss a report without taking the artifact down.
  app.post("/v1/reports/:id/dismiss", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    // A workspace Admin can only dismiss their own workspace's reports; a
    // super-admin operator any. Resolve (and scope) the report before acting.
    const scope = (await isSuperAdmin(c)) ? undefined : await activeWorkspace(c)
    const rep = await meta.getReport(c.req.param("id"), scope)
    if (!rep) return fail(c, 404, "not found")
    await meta.setReportState(rep.id, "dismissed", scope)
    await meta.createAuditLog({
      id: newId("aud"),
      org_id: rep.org_id,
      action: "dismiss",
      artifact_id: rep.artifact_id,
      actor: (await actingUser(c))?.name ?? "owner",
      detail: rep.id,
    })
    return c.json({ ok: true })
  })

  return app
}
