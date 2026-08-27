import { LINKED_BUNDLE_FACT, WORKFLOW_DEFINITION_FACT } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail } from "../lib/http"
import { visibleArtifactIds } from "../lib/visibility"
import { parseLinkedWorkflowFacts } from "../lib/workflow-facts"

const workflowDirectoryItem = z.object({
  shortId: z.string(),
  title: z.string(),
  version: z.number().int(),
  updatedAt: z.string(),
  purpose: z.string().nullable(),
  status: z.enum(["ready", "needs-changes"]),
  diagrams: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      agentSteps: z.number().int(),
      humanPauses: z.number().int(),
      branches: z.number().int(),
      loops: z.number().int(),
    }),
  ),
})

export const workflowRoutes = (ctx: AppContext) => {
  const {
    meta,
    requireWorkspace,
    resolveArtifacts,
    authorizeStanding,
    privateOwnerId,
    actingUser,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workflows",
      tags: ["Workflows"],
      summary: "List visible workflow artifacts from their current versioned definitions.",
      responses: {
        200: {
          description:
            "Current workflow definitions the caller may read, newest first. No execution is started.",
          content: {
            "application/json": {
              schema: z.object({ workflows: z.array(workflowDirectoryItem) }),
            },
          },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)

      // The fact index narrows the corpus; it does not grant access. Standing deliberately excludes
      // world link roles, which allow a known URL to open but do not make an unlisted artifact
      // discoverable in a directory.
      const candidates = await meta.listFactAcrossArtifacts(org, WORKFLOW_DEFINITION_FACT, {
        limit: 100,
      })
      const viewerId = (await privateOwnerId(c)) ?? (await actingUser(c))?.id
      const allowed = await visibleArtifactIds(
        meta,
        candidates.map((row) => row.id),
        { orgId: org, viewerId: viewerId ?? undefined },
      )
      const artifacts = await resolveArtifacts(
        c,
        candidates.filter((row) => allowed.has(row.id)).map((row) => row.short_id),
      )
      const visible = new Set<string>()
      for (const artifact of artifacts) {
        if (artifact.org_id === org && (await authorizeStanding(c, "read", artifact)))
          visible.add(artifact.id)
      }
      const rows = candidates.filter((row) => visible.has(row.id)).slice(0, 50)
      const data = await meta.currentVersionDataForArtifacts(
        rows.map((row) => row.id),
        [LINKED_BUNDLE_FACT],
      )
      const byArtifact = new Map<string, { slot: string; json: string }[]>(
        rows.map((row) => [row.id, [{ slot: WORKFLOW_DEFINITION_FACT, json: row.json }]]),
      )
      for (const fact of data) {
        const facts = byArtifact.get(fact.artifact_id)
        if (!facts) continue
        facts.push({ slot: fact.slot, json: fact.json })
      }

      return c.json({
        workflows: rows.map((row) => {
          const facts = parseLinkedWorkflowFacts(byArtifact.get(row.id) ?? [])
          const preview = facts.preview
          return {
            shortId: row.short_id,
            title: row.title ?? "Untitled workflow",
            version: row.n,
            updatedAt: row.at,
            purpose: preview?.purpose ?? null,
            status: preview?.status ?? "needs-changes",
            diagrams: (preview?.diagrams ?? []).map((diagram) => ({
              id: diagram.id,
              title: diagram.title,
              agentSteps: diagram.context_sessions.length,
              humanPauses: diagram.will_pause.length,
              branches: diagram.may_do.length,
              loops: diagram.can_repeat.length,
            })),
          }
        }),
      })
    },
  )

  return app
}
