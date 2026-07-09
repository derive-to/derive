import { newId } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson, str } from "../lib/http"
import { clientIp } from "../lib/rate-limit"

/** Abuse reports (public) + takedown / reinstate / audit (Admin). A taken-down
 *  artifact keeps its record but serves no content (410). The Report response schema
 *  is the single source for the web client's type. */
export const moderationRoutes = (ctx: AppContext) => {
  const { meta, actingUser, workspaceCan, activeWorkspace, isSuperAdmin } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const Report = z
    .object({
      id: z.string(),
      artifact_id: z.string(),
      artifact_short_id: z.string(),
      reason: z.string().describe("The reporter's stated reason for the report"),
      detail: z.string().nullable().describe("Optional extra detail from the reporter, or null"),
      reporter: z
        .string()
        .nullable()
        .describe("The reporter's IP (best-effort), or null; abuse reports are anonymous/public"),
      state: z
        .enum(["open", "actioned", "dismissed"])
        .describe("open (awaiting review), actioned (taken down), or dismissed (no action)"),
      created_at: z.string(),
    })
    .openapi("Report")

  const AuditEntry = z
    .object({
      id: z.string(),
      org_id: z.string(),
      action: z
        .enum(["report", "takedown", "reinstate", "dismiss"])
        .describe("What happened: report filed, takedown, reinstate, or dismiss"),
      artifact_id: z
        .string()
        .nullable()
        .describe("The artifact acted on, or null if not artifact-specific"),
      actor: z
        .string()
        .describe("Who performed it: a user's name, or an IP/'anonymous' for public reports"),
      detail: z
        .string()
        .nullable()
        .describe("Context such as the report reason or takedown note, or null"),
      created_at: z.string(),
    })
    .openapi("AuditEntry")

  // Anyone can report a public artifact for abuse. Rate-limited by the global
  // per-IP limiter on mutating /v1; the reporter's IP is recorded best-effort.
  // authz-exempt: abuse reports are intentionally public (any visitor can report)
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/report",
      tags: ["Moderation"],
      summary: "Report an artifact for abuse (public).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        201: {
          description: "The report was filed.",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      const b = await readJson(
        c,
        z.object({
          reason: z.string().refine((s) => s.trim() !== "", "reason required"),
          detail: z.unknown().optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      const reason = b.reason.trim()
      const ip = clientIp(c, "")
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
    },
  )

  // The owner's moderation queue: open reports with their artifacts.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/reports",
      tags: ["Moderation"],
      summary: "The open moderation queue (Admin only).",
      responses: {
        200: {
          description: "Open reports and their count.",
          content: {
            "application/json": {
              schema: z.object({ reports: z.array(Report), open: z.number() }),
            },
          },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "manage"))) return bail(fail(c, 403, "forbidden"))
      // A super-admin operator sees every workspace's reports (the global queue);
      // a workspace Admin sees only their own.
      const scope = (await isSuperAdmin(c)) ? undefined : await activeWorkspace(c)
      const reports = await meta.listReports(scope, { state: "open", limit: 200 })
      return c.json({ reports, open: reports.length })
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/audit",
      tags: ["Moderation"],
      summary: "The moderation audit log (Admin only).",
      responses: {
        200: {
          description: "Recent audit-log entries.",
          content: { "application/json": { schema: z.object({ audit: z.array(AuditEntry) }) } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "manage"))) return bail(fail(c, 403, "forbidden"))
      const scope = (await isSuperAdmin(c)) ? undefined : await activeWorkspace(c)
      return c.json({ audit: await meta.listAuditLog(scope, { limit: 200 }) })
    },
  )

  // Take an artifact down: its content 410s everywhere, the record stays, and
  // any open reports against it are marked actioned.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/takedown",
      tags: ["Moderation"],
      summary: "Take an artifact down (Admin only); its content 410s everywhere.",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The artifact was taken down.",
          content: {
            "application/json": { schema: z.object({ ok: z.boolean(), removed: z.boolean() }) },
          },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "manage"))) return bail(fail(c, 403, "forbidden"))
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      // A super-admin (operator) takes down any artifact globally; a workspace
      // Admin only within their own workspace.
      if (!artifact || (!(await isSuperAdmin(c)) && artifact.org_id !== (await activeWorkspace(c))))
        return bail(fail(c, 404, "not found"))
      const who = (await actingUser(c))?.name ?? "owner"
      const b = await readJson(c, z.object({ note: z.unknown().optional() }))
      if (b instanceof Response) return bail(b)
      // One atomic step: tombstone the artifact, resolve every open report against
      // it, and write the audit entry. (Was a non-transactional read-loop-write that
      // also scanned the whole open-report queue to filter by artifact — N+1.)
      await meta.takedownArtifact({
        artifactId: artifact.id,
        orgId: artifact.org_id,
        removedAt: new Date().toISOString(),
        audit: {
          id: newId("aud"),
          org_id: artifact.org_id,
          action: "takedown",
          artifact_id: artifact.id,
          actor: who,
          detail: str(b.note) ?? null,
        },
      })
      return c.json({ ok: true, removed: true })
    },
  )

  // Reverse a takedown.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/reinstate",
      tags: ["Moderation"],
      summary: "Reverse an artifact takedown (Admin only).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The artifact was reinstated.",
          content: {
            "application/json": { schema: z.object({ ok: z.boolean(), removed: z.boolean() }) },
          },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "manage"))) return bail(fail(c, 403, "forbidden"))
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact || (!(await isSuperAdmin(c)) && artifact.org_id !== (await activeWorkspace(c))))
        return bail(fail(c, 404, "not found"))
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
    },
  )

  // Dismiss a report without taking the artifact down.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/reports/{id}/dismiss",
      tags: ["Moderation"],
      summary: "Dismiss a report without taking the artifact down (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The report was dismissed.",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "manage"))) return bail(fail(c, 403, "forbidden"))
      // A workspace Admin can only dismiss their own workspace's reports; a
      // super-admin operator any. Resolve (and scope) the report before acting.
      const scope = (await isSuperAdmin(c)) ? undefined : await activeWorkspace(c)
      const rep = await meta.getReport(c.req.param("id"), scope)
      if (!rep) return bail(fail(c, 404, "not found"))
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
    },
  )

  return app
}
