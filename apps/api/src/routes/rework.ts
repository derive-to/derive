import {
  newId,
  parseBrandprint,
  profileState,
  resolveBrandprint,
  reworkInstruction,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { quoteOf } from "../lib/comments"
import { bail, fail, readJson } from "../lib/http"
import { notifyMentions } from "../lib/mentions"
import { notifyCommentBells } from "../lib/notify-comment"

/** Phase 3 (apply): the Rework button's endpoint. A thin wrapper over the existing
 *  @mention-to-inbox path — composes the canned Brandprint instruction server-side
 *  (the single source of truth; the client never carries the prompt) and posts it as
 *  a whole-document comment @mentioning the chosen agent, which drops into that
 *  agent's MCP pull inbox. The agent revises and publishes per its grant: a
 *  publish-capable agent posts the new version directly, a lower grant files a
 *  proposal — no special case here. */
export const reworkRoutes = (ctx: AppContext) => {
  const { meta, bus, background, notify, actingUser, authorize, limited, commentLimiter } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/rework",
      tags: ["Artifacts"],
      summary: "Ask a registered agent to rework this artifact to match the Brandprint.",
      request: {
        params: z.object({ shortId: z.string() }),
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z.object({
                agentId: z
                  .string()
                  .optional()
                  .describe("Which agent to ask; omit to use the sole registered agent."),
              }),
            },
          },
        },
      },
      responses: {
        201: {
          description:
            "The rework request was posted and landed in the agent's pull inbox. 409 needsAgent when no agent is registered; 409 needsBrandprint when no Brandprint resolves.",
          content: {
            "application/json": {
              schema: z.object({
                requestId: z.string().describe("The request comment's thread id."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact || artifact.current_version === 0) return bail(fail(c, 404, "not found"))
      if (!(await authorize(c, "comment", artifact))) return bail(fail(c, 403, "forbidden"))
      // Rework acts as a named collaborator (the request is authored and attributed,
      // and the personal Brandprint layer is theirs) — no anonymous firing.
      const acting = await actingUser(c)
      if (!acting) return bail(fail(c, 401, "sign in to request a rework"))
      const rl = await limited(c, commentLimiter)
      if (rl) return bail(rl)
      let agentId: string | undefined
      if (c.req.header("content-type")?.includes("application/json")) {
        const body = await readJson(c, z.object({ agentId: z.string().optional() }))
        if (body instanceof Response) return bail(body)
        agentId = body.agentId
      }

      const agents = await meta.listAgents(artifact.org_id)
      if (agents.length === 0) return bail(fail(c, 409, "needsAgent"))
      const agent = agentId
        ? agents.find((a) => a.id === agentId)
        : agents.length === 1
          ? agents[0]
          : undefined
      if (!agent)
        return bail(
          agentId
            ? fail(c, 404, "no such agent in this workspace")
            : fail(c, 400, "agentId required when several agents are registered"),
        )

      // Resolve the Brandprint the agent will read (workspace ⊕ requester's profile) —
      // needed for the profile-first line, and as a guard: firing the canned
      // instruction with zero derive://brandprint/* resources behind it would hand
      // the agent an empty brief.
      const ws = (await meta.getOrgSettings(artifact.org_id)).brandprint
      const personal = parseBrandprint(await meta.getUserBrandprint(acting.id))
      const resolved = resolveBrandprint(ws, personal)
      if (resolved.collectionIds.length === 0 && !resolved.profileId)
        return bail(fail(c, 409, "needsBrandprint"))
      let profileLive = false
      if (resolved.profileId) {
        const prof = await meta.getByShortId(resolved.profileId)
        profileLive = !!prof && profileState(prof.current_version) === "live"
      }

      // The canned request: a whole-document comment (no anchor) @mentioning the
      // agent — the same row and fan-out the ask-agent composer produces.
      const id = newId("c")
      const mentions = [{ id: agent.id, name: agent.name }]
      const created = await meta.createComment({
        id,
        artifact_id: artifact.id,
        thread_id: id,
        base_version: artifact.current_version,
        path: null,
        anchor: null,
        body_md: `@${agent.name} ${reworkInstruction(profileLive)}`,
        author: acting.name,
        author_id: acting.id,
      })
      await meta.updateComment(created.id, { meta: JSON.stringify({ mentions }) })
      bus.publish(artifact.id, { type: "comment.created" })
      await background(
        (async () => {
          await notify(artifact, "comment.created", {
            author: created.author,
            body: created.body_md,
            quote: quoteOf(created.anchor),
            thread_id: created.thread_id,
          })
          await notifyMentions({ meta, bus }, artifact, created, mentions, acting.id)
          await notifyCommentBells({ meta, bus }, artifact, created, {
            mentionIds: new Set(mentions.map((m) => m.id)),
            actorId: acting.id,
          })
        })(),
      )
      return c.json({ requestId: created.thread_id }, 201)
    },
  )
  return app
}
