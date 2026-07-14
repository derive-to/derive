import { newId, profileState, reworkInstruction } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { resolveActorBrandprint } from "../lib/brandprint"
import { parseMeta, quoteOf } from "../lib/comments"
import { bail, fail, readJson } from "../lib/http"
import { notifyMentions } from "../lib/mentions"
import { notifyCommentBells } from "../lib/notify-comment"

/** The Rework button's endpoint. A thin wrapper over the existing
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
      // readJson tolerates a missing body (it parses to {}), so a bare POST means
      // "use the sole registered agent".
      const body = await readJson(c, z.object({ agentId: z.string().optional() }))
      if (body instanceof Response) return bail(body)

      // The agent list and the Brandprint resolution are independent reads; batch them.
      const [agents, resolved] = await Promise.all([
        meta.listAgents(artifact.org_id),
        resolveActorBrandprint(meta, artifact.org_id, acting.id),
      ])
      if (agents.length === 0)
        return bail(
          fail(c, 409, "no agent is registered in this workspace", { code: "needsAgent" }),
        )
      let agent: (typeof agents)[number]
      if (body.agentId) {
        const found = agents.find((a) => a.id === body.agentId)
        if (!found) return bail(fail(c, 404, "no such agent in this workspace"))
        agent = found
      } else {
        // `!sole` can't fire — the empty case 409'd above; it narrows the
        // destructured element so no unchecked index escapes.
        const [sole, ...rest] = agents
        if (!sole || rest.length > 0)
          return bail(fail(c, 400, "agentId required when several agents are registered"))
        agent = sole
      }

      // The resolved Brandprint (workspace ⊕ requester's profile) drives the
      // profile-first line and guards the empty brief: firing the canned instruction
      // with zero derive://brandprint/* resources behind it would hand the agent
      // nothing to read.
      if (resolved.collectionIds.length === 0 && !resolved.profileId)
        return bail(
          fail(c, 409, "no Brandprint is set on this workspace or your profile", {
            code: "needsBrandprint",
          }),
        )
      let profileLive = false
      if (resolved.profileId) {
        const prof = await meta.getByShortId(resolved.profileId)
        profileLive = !!prof && profileState(prof.current_version) === "live"
      }

      // The canned request: a whole-document comment (no anchor) @mentioning the
      // agent — the same ROW the ask-agent composer writes, but a deliberately
      // narrower fan-out: comment.created + mention/bell notify only, skipping the
      // comment.mention webhook, comment emails, Slack, and the GitHub PR echo. This
      // is a canned, bot-directed note, not a human conversation — mirroring it into
      // those channels would just be noise for people who didn't ask for it.
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
      await meta.updateComment(created.id, {
        meta: JSON.stringify({ ...parseMeta(created.meta), mentions }),
      })
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
