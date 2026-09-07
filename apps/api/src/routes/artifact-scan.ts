import { newId } from "@derive/core"
import { OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { localArtifactScanActivity } from "../lib/artifact-scan"
import { fail, readJson } from "../lib/http"

const scannedArtifactEvent = z.object({
  event_id: z.string().regex(/^[a-f0-9]{64}$/),
  artifact_short_id: z.string().min(1).max(128),
  artifact_version: z.number().int().positive(),
  client: z.enum(["claude", "codex"]),
  action: z.enum(["read", "published"]),
  evidence: z.literal("structured_tool_result"),
  opaque_session_id: z.string().regex(/^[a-f0-9]{64}$/),
  occurred_at: z.string().datetime(),
})

const scanCoverage = z.object({
  client: z.enum(["claude", "codex"]),
  source_files: z.number().int().nonnegative(),
  sessions_scanned: z.number().int().nonnegative(),
  records_scanned: z.number().int().nonnegative(),
  parser_version: z.number().int().positive(),
  scanned_at: z.string().datetime(),
})

const scanBatch = z.object({
  events: z.array(scannedArtifactEvent).max(500),
  coverage: z.array(scanCoverage).max(10),
})

/** Local agent-log observations. These routes store exact Derive artifact metadata only. */
export const artifactScanRoutes = (ctx: AppContext) => {
  const { meta, actingHuman, actingUser, activeWorkspace, requireArtifact, authorize } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  app.post("/v1/artifact-scan/batch", async (c) => {
    const body = await readJson(c, scanBatch)
    if (body instanceof Response) return body
    const actor = (await actingHuman(c)) ?? (await actingUser(c))
    if (!actor) return fail(c, 401, "a signed-in user or user-authorized agent is required")
    const orgId = await activeWorkspace(c)
    const now = new Date().toISOString()
    const recorded: string[] = []
    const rejected: Array<{ event_id: string; reason: string }> = []

    for (const event of body.events) {
      const artifact = await requireArtifact(c, "read", { shortId: event.artifact_short_id })
      if (artifact instanceof Response || artifact.org_id !== orgId) {
        rejected.push({ event_id: event.event_id, reason: "artifact_unavailable" })
        continue
      }
      const version = await meta.getVersion(artifact.id, event.artifact_version)
      if (!version) {
        rejected.push({ event_id: event.event_id, reason: "version_not_found" })
        continue
      }
      if (event.action === "published" && version.author_id !== actor.id) {
        rejected.push({ event_id: event.event_id, reason: "publish_not_owned" })
        continue
      }
      await meta.recordArtifactScanEvent({
        id: newId("ase"),
        event_id: event.event_id,
        org_id: orgId,
        artifact_id: artifact.id,
        artifact_version: event.artifact_version,
        scanned_by: actor.id,
        client: event.client,
        action: event.action,
        evidence: event.evidence,
        opaque_session_id: event.opaque_session_id,
        occurred_at: event.occurred_at,
        created_at: now,
      })
      recorded.push(event.event_id)
    }
    for (const row of body.coverage)
      await meta.upsertArtifactScanCoverage({
        id: newId("asc"),
        org_id: orgId,
        scanned_by: actor.id,
        client: row.client,
        source_files: row.source_files,
        sessions_scanned: row.sessions_scanned,
        records_scanned: row.records_scanned,
        parser_version: row.parser_version,
        scanned_at: row.scanned_at,
        updated_at: now,
      })
    return c.json({ recorded, rejected, coverage: body.coverage.length })
  })

  app.get("/v1/artifacts/:shortId/local-activity", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    const local = await localArtifactScanActivity({
      meta,
      artifact,
      canRead: (candidate) => authorize(c, "read", candidate),
    })
    return c.json({
      ...local,
      coverage: await meta.listArtifactScanCoverage(artifact.org_id),
    })
  })

  return app
}
