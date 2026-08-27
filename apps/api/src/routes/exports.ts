import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import {
  EXPORT_KINDS,
  exportInputHash,
  isQaEmailRecipient,
  normalizeExportOptions,
  profileFor,
} from "../lib/export-system"
import { bail, fail, toBody } from "../lib/http"

const DOWNLOAD_TYPES: Record<string, { ext: string; disposition: string }> = {
  "application/pdf": { ext: "pdf", disposition: "attachment" },
  "image/png": { ext: "png", disposition: "attachment" },
  "application/json": { ext: "json", disposition: "attachment" },
  "text/csv": { ext: "csv", disposition: "attachment" },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    ext: "pptx",
    disposition: "attachment",
  },
}

const jobJson = (baseUrl: string, job: Awaited<ReturnType<AppContext["meta"]["getExportJob"]>>) => {
  if (!job) return null
  return {
    id: job.id,
    artifact_id: job.artifact_id,
    version: job.version_n,
    kind: job.kind,
    profile: job.profile,
    status: job.status,
    attempts: job.attempts,
    error: job.last_error,
    error_class: job.error_class,
    bytes: job.output_bytes,
    created_at: job.created_at,
    updated_at: job.updated_at,
    download_url: job.status === "ready" ? `${baseUrl}/v1/exports/${job.id}/download` : null,
    public_url: job.public_asset_hash
      ? `${baseUrl}/blob/${job.public_asset_hash}.${job.output_type === "image/png" ? "png" : "bin"}`
      : null,
    preview_url:
      job.status === "ready" && job.kind === "email" && job.output_type === "text/html"
        ? `${baseUrl}/v1/exports/${job.id}/preview`
        : null,
  }
}

export const exportRoutes = (ctx: AppContext) => {
  const { meta, blobs, requireArtifact, requireUser, overStorage, blockCopy, deps } = ctx
  const app = new OpenAPIHono<BlankEnv>()
  const ExportRequest = z.object({
    kind: z.enum(EXPORT_KINDS),
    version: z.number().int().positive().optional(),
    region: z.string().max(200).optional(),
    dataSlot: z.string().max(120).optional(),
    publicImage: z.boolean().optional(),
    recipient: z.email().max(320).optional(),
    note: z.string().max(2_000).optional(),
    attachPdf: z.boolean().optional(),
  })

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/exports",
      tags: ["Exports"],
      summary: "Create an immutable, version-pinned export or static email job.",
      request: {
        params: z.object({ shortId: z.string() }),
        body: { content: { "application/json": { schema: ExportRequest } } },
      },
      responses: { 202: { description: "Export accepted." } },
    }),
    async (c) => {
      const user = await requireUser(c)
      if (user instanceof Response) return bail(user)
      const artifact = await requireArtifact(c, "read", { split: true })
      if (artifact instanceof Response) return bail(artifact)
      const body = c.req.valid("json")
      const versionN = body.version ?? artifact.current_version
      const version = await meta.getVersion(artifact.id, versionN)
      if (!version) return bail(fail(c, 404, "version not found"))
      const qaCapture = body.kind === "email" && deps.qaEmailCapture === true
      const options = normalizeExportOptions({
        ...body,
        title: artifact.title ?? undefined,
        ...(qaCapture ? { qaCapture: true } : {}),
      })
      if ((body.kind === "chart_json" || body.kind === "chart_csv") && !options.dataSlot)
        return bail(fail(c, 400, "dataSlot is required for declared data export"))
      if (body.kind === "email" && !options.recipient)
        return bail(fail(c, 400, "recipient is required for email export"))
      if (qaCapture && options.recipient && !isQaEmailRecipient(options.recipient))
        return bail(fail(c, 400, "preview email capture requires a recipient under .test"))
      if (
        (body.kind === "deck_pdf" || body.kind === "deck_pptx") &&
        version.content_type !== "text/x-derive-deck"
      )
        return bail(fail(c, 400, "deck export requires a Derive deck"))
      const requiresBrowser = !["chart_json", "chart_csv"].includes(body.kind)
      if (requiresBrowser && !(deps.renderExports ?? deps.renderPreviews))
        return bail(fail(c, 503, "export rendering is not configured"))
      const estimatedBytes = body.kind === "deck_pptx" ? 25 * 1024 * 1024 : 5 * 1024 * 1024
      if (await overStorage(artifact.org_id, estimatedBytes))
        return bail(fail(c, 413, blockCopy.storage.message, { code: blockCopy.storage.code }))
      const recent = await meta.listExportJobs(artifact.id, user.id, 50)
      const active = recent.filter((job) =>
        ["pending", "rendering", "failed"].includes(job.status),
      ).length
      if (active >= 5) return bail(fail(c, 429, "too many active exports; wait for one to finish"))
      const inputHash = await exportInputHash({
        artifactId: artifact.id,
        version: versionN,
        requestedBy: user.id,
        rendererScope: deps.baseUrl.replace(/\/$/, ""),
        kind: body.kind,
        options,
      })
      const job = await meta.enqueueExportJob({
        id: `ex_${crypto.randomUUID().slice(0, 16)}`,
        artifact_id: artifact.id,
        version_n: versionN,
        org_id: artifact.org_id,
        requested_by: user.id,
        kind: body.kind,
        profile: profileFor(body.kind),
        renderer_scope: deps.baseUrl.replace(/\/$/, ""),
        options_json: JSON.stringify(options),
        input_hash: inputHash,
        expires_at: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
      })
      deps.pokePreviews?.()
      return c.json(jobJson(deps.baseUrl.replace(/\/$/, ""), job), 202)
    },
  )

  app.get("/v1/artifacts/:shortId/exports", async (c) => {
    const user = await requireUser(c)
    if (user instanceof Response) return user
    const artifact = await requireArtifact(c, "read", { split: true })
    if (artifact instanceof Response) return artifact
    const jobs = await meta.listExportJobs(artifact.id, user.id, 20)
    return c.json({ jobs: jobs.map((job) => jobJson(deps.baseUrl.replace(/\/$/, ""), job)) })
  })

  const ownJob = async (c: Parameters<typeof requireUser>[0]) => {
    const user = await requireUser(c)
    if (user instanceof Response) return user
    const job = await meta.getExportJob(c.req.param("id") ?? "")
    if (!job || job.requested_by !== user.id) return fail(c, 404, "not found")
    const artifact = await meta.getArtifactById(job.artifact_id)
    if (!artifact) return fail(c, 404, "not found")
    const readable = await requireArtifact(c, "read", { shortId: artifact.short_id })
    if (readable instanceof Response) return readable
    return { job, artifact }
  }

  app.get("/v1/exports/:id", async (c) => {
    const found = await ownJob(c)
    if (found instanceof Response) return found
    return c.json(jobJson(deps.baseUrl.replace(/\/$/, ""), found.job))
  })

  app.get("/v1/exports/:id/download", async (c) => {
    const found = await ownJob(c)
    if (found instanceof Response) return found
    const { job, artifact } = found
    if (job.status !== "ready" || !job.output_key || !job.output_type)
      return fail(c, 409, "export is not ready")
    const data = await blobs.get(job.output_key)
    if (!data) return fail(c, 500, "export blob missing")
    const info = DOWNLOAD_TYPES[job.output_type] ?? { ext: "bin", disposition: "attachment" }
    const name = (artifact.title ?? artifact.short_id).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 100)
    return c.body(toBody(data), 200, {
      "Content-Type": job.output_type,
      "Content-Length": String(data.byteLength),
      "Content-Disposition": `${info.disposition}; filename="${name}-v${job.version_n}.${info.ext}"`,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    })
  })

  app.get("/v1/exports/:id/preview", async (c) => {
    const found = await ownJob(c)
    if (found instanceof Response) return found
    const { job } = found
    if (
      job.kind !== "email" ||
      job.status !== "ready" ||
      !job.output_key ||
      job.output_type !== "text/html"
    )
      return fail(c, 409, "email capture is not ready")
    const data = await blobs.get(job.output_key)
    if (!data) return fail(c, 500, "email capture blob missing")
    return c.body(toBody(data), 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(data.byteLength),
      "Content-Security-Policy":
        "sandbox; default-src 'none'; img-src data: https:; style-src 'unsafe-inline'",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    })
  })

  app.post("/v1/exports/:id/cancel", async (c) => {
    const found = await ownJob(c)
    if (found instanceof Response) return found
    if (["ready", "dead", "cancelled", "expired"].includes(found.job.status))
      return fail(c, 409, "export can no longer be cancelled")
    await meta.updateExportJob(found.job.id, {
      status: "cancelled",
      updated_at: new Date().toISOString(),
    })
    return c.json({ ok: true })
  })

  return app
}
