import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { resolveUserBylines } from "../lib/author"
import { commentJson, parseMeta } from "../lib/comments"
import { bail } from "../lib/http"
import { principalKind } from "../lib/principal-kind"
import { roundJson } from "../lib/review-json"
import { WorkspaceActivity } from "../schemas"

/** How far back the home looks by default, and at most. */
const DAYS_DEFAULT = 7
const DAYS_MAX = 30
/** Rows per kind — well past a week of a busy workspace; the client folds them to lines. */
const LIMIT = 400

/**
 * The workspace's recent activity — the records the home's "Needs you" and "Recent
 * activity" are built from: versions, comments and review rounds across the workspace,
 * over a window, plus every open comment on the artifacts that need this person's
 * feedback (a thread waiting on someone is current however old it is) and every pending
 * round (likewise). The client folds them with the same grouping the artifact rail uses.
 *
 * VISIBILITY: the cross-artifact reads are org-wide and decide nothing; the artifacts are
 * then listed for THIS viewer through the one viewer-aware listing, and only rows on the
 * artifacts it returns are served — a listing must never leak an artifact the viewer
 * cannot open.
 */
export const activityRoutes = (ctx: AppContext) => {
  const { meta, requireUser, requireWorkspace } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspace/activity",
      tags: ["Workspace"],
      summary: "Recent activity across the workspace, for the home.",
      request: {
        query: z.object({
          days: z.coerce
            .number()
            .int()
            .min(1)
            .max(DAYS_MAX)
            .optional()
            .describe(`The window in days (default ${DAYS_DEFAULT}, max ${DAYS_MAX}).`),
        }),
      },
      responses: {
        200: {
          description: "The window's versions, comments and review rounds, over visible artifacts.",
          content: { "application/json": { schema: WorkspaceActivity } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const org = await requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)
      const days = c.req.valid("query").days ?? DAYS_DEFAULT
      const since = new Date(Date.now() - days * 86_400_000).toISOString()

      const needing = await meta.artifactIdsNeedingFeedback(me.id, org)
      const [versions, comments, rounds] = await Promise.all([
        meta.listVersionsInOrg(org, { since, limit: LIMIT }),
        meta.listCommentsInOrg(org, { since, limit: LIMIT, openOn: needing }),
        meta.listReviewRoundsInOrg(org, { since, limit: LIMIT }),
      ])

      // The gate: list the candidate artifacts FOR THIS VIEWER, keep only rows on those.
      const candidates = [
        ...new Set([...versions, ...comments, ...rounds].map((r) => r.artifact_id)),
      ]
      const visible = candidates.length
        ? await meta.listArtifacts({
            ids: candidates,
            orgId: org,
            viewerId: me.id,
            limit: candidates.length,
            archived: "exclude",
          })
        : []
      const byId = new Map(visible.map((a) => [a.id, a]))
      const onVisible = <T extends { artifact_id: string }>(rows: T[]) =>
        rows.filter((r) => byId.has(r.artifact_id))
      const vs = onVisible(versions)
      const cs = onVisible(comments)
      const rs = onVisible(rounds)

      // People read by their live display name, as everywhere (lib/author.ts).
      const bylines = await resolveUserBylines(
        meta,
        [
          ...vs.map((v) => v.author_id),
          ...cs.map((cm) => cm.author_id),
          ...cs.map((cm) => parseMeta(cm.meta).resolved?.by_id),
        ].filter((id): id is string => !!id && principalKind(id) === "user"),
      )
      const live = (id: string | null) => (id ? bylines[id] : undefined)

      return c.json({
        since,
        artifacts: visible.map((a) => ({
          id: a.id,
          short_id: a.short_id,
          title: a.title ?? a.short_id,
        })),
        versions: vs.map((v) => ({
          artifact_id: v.artifact_id,
          n: v.n,
          author: live(v.author_id)?.name || v.author,
          handle: live(v.author_id)?.handle ?? null,
          agent: v.agent_id ? { id: v.agent_id, name: v.agent_name ?? "Agent" } : null,
          message: v.message,
          name: v.name,
          created_at: v.created_at,
        })),
        comments: cs.map((cm) => commentJson(cm, undefined, bylines)),
        rounds: await Promise.all(rs.map((r) => roundJson(meta, r))),
      })
    },
  )
  return app
}
