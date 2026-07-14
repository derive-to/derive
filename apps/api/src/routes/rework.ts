import {
  type AgentRecord,
  type ArtifactRecord,
  buildProfileInstruction,
  newId,
  profileState,
  reworkInstruction,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { resolveActorBrandprint } from "../lib/brandprint"
import { parseMeta, quoteOf } from "../lib/comments"
import { bail, fail, readJson } from "../lib/http"
import { notifyMentions } from "../lib/mentions"
import { notifyCommentBells } from "../lib/notify-comment"

/** The canned agent-request endpoints — Rework and generate-profile. Thin wrappers
 *  over the existing @mention-to-inbox path: each composes its instruction server-side
 *  (the single source of truth; the client never carries a prompt) and posts it as a
 *  whole-document comment @mentioning the chosen agent, which drops into that agent's
 *  MCP pull inbox. The agent does the work and publishes per its grant: a
 *  publish-capable agent posts directly, a lower grant files a proposal — no special
 *  case here. */
export const reworkRoutes = (ctx: AppContext) => {
  const { meta, bus, background, notify, actingUser, authorize, limited, commentLimiter } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  type Acting = Exclude<Awaited<ReturnType<AppContext["actingUser"]>>, null>

  const requestBody = {
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
  }
  const requestCreated = (description: string) => ({
    201: {
      description,
      content: {
        "application/json": {
          schema: z.object({
            requestId: z.string().describe("The request comment's thread id."),
          }),
        },
      },
    },
  })

  // The guard chain both endpoints share: the artifact, comment authz, a signed-in
  // requester (the request is authored and attributed — no anonymous firing), the
  // comment rate limit, and the optional { agentId } body (readJson tolerates a
  // missing body, so a bare POST means "use the sole registered agent"). Returns a
  // ready-to-bail Response on any failed gate.
  const requestContext = async (c: Context, shortId: string) => {
    const artifact = await meta.getByShortId(shortId)
    if (!artifact || artifact.current_version === 0) return fail(c, 404, "not found")
    if (!(await authorize(c, "comment", artifact))) return fail(c, 403, "forbidden")
    const acting = await actingUser(c)
    if (!acting) return fail(c, 401, "sign in to send an agent request")
    const rl = await limited(c, commentLimiter)
    if (rl) return rl
    const body = await readJson(c, z.object({ agentId: z.string().optional() }))
    if (body instanceof Response) return body
    return { artifact, acting, agentId: body.agentId }
  }

  // Pick the addressee: the named agent, else the workspace's sole one.
  const pickAgent = (
    c: Context,
    agents: AgentRecord[],
    agentId?: string,
  ): AgentRecord | Response => {
    if (agents.length === 0)
      return fail(c, 409, "no agent is registered in this workspace", { code: "needsAgent" })
    if (agentId)
      return agents.find((a) => a.id === agentId) ?? fail(c, 404, "no such agent in this workspace")
    // `!sole` can't fire — the empty case 409'd above; it narrows the destructured
    // element so no unchecked index escapes.
    const [sole, ...rest] = agents
    if (!sole || rest.length > 0)
      return fail(c, 400, "agentId required when several agents are registered")
    return sole
  }

  // One queued ask per (agent, artifact): re-firing while the last request still
  // waits in the inbox would only stack an identical row (a double-click did exactly
  // that in the field). Once the agent acks, firing again is allowed.
  const alreadyQueued = async (agent: AgentRecord, artifactShortId: string) =>
    (await meta.listPendingAgentMentions(agent.id, 50)).some(
      (m) => m.artifact_short_id === artifactShortId,
    )

  // Post the canned request: a whole-document comment (no anchor) @mentioning the
  // agent — the same ROW the ask-agent composer writes, but a deliberately narrower
  // fan-out: comment.created + mention/bell notify only, skipping the comment.mention
  // webhook, comment emails, Slack, and the GitHub PR echo. This is a canned,
  // bot-directed note, not a human conversation — mirroring it into those channels
  // would just be noise for people who didn't ask for it.
  const postRequest = async (
    artifact: ArtifactRecord,
    acting: Acting,
    agent: AgentRecord,
    instruction: string,
  ) => {
    const id = newId("c")
    const mentions = [{ id: agent.id, name: agent.name }]
    const created = await meta.createComment({
      id,
      artifact_id: artifact.id,
      thread_id: id,
      base_version: artifact.current_version,
      path: null,
      anchor: null,
      body_md: `@${agent.name} ${instruction}`,
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
    return created.thread_id
  }

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/rework",
      tags: ["Artifacts"],
      summary: "Ask a registered agent to rework this artifact to match the Brandprint.",
      request: { params: z.object({ shortId: z.string() }), body: requestBody },
      responses: requestCreated(
        "The rework request was posted and landed in the agent's pull inbox. 409 needsAgent when no agent is registered; 409 needsBrandprint when no Brandprint resolves; 409 alreadyQueued while an earlier request for this artifact still waits.",
      ),
    }),
    async (c) => {
      const rc = await requestContext(c, c.req.param("shortId"))
      if (rc instanceof Response) return bail(rc)
      const { artifact, acting, agentId } = rc

      // The agent list and the Brandprint resolution are independent reads; batch them.
      const [agents, resolved] = await Promise.all([
        meta.listAgents(artifact.org_id),
        resolveActorBrandprint(meta, artifact.org_id, acting.id),
      ])
      const agent = pickAgent(c, agents, agentId)
      if (agent instanceof Response) return bail(agent)
      if (await alreadyQueued(agent, artifact.short_id))
        return bail(
          fail(c, 409, `a request for this artifact is already queued for ${agent.name}`, {
            code: "alreadyQueued",
          }),
        )

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

      const requestId = await postRequest(artifact, acting, agent, reworkInstruction(profileLive))
      return c.json({ requestId }, 201)
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/generate-profile",
      tags: ["Artifacts"],
      summary: "Ask a registered agent to build this workspace's brand profile.",
      request: { params: z.object({ shortId: z.string() }), body: requestBody },
      responses: requestCreated(
        "The build request was posted and landed in the agent's pull inbox. 400 when the artifact is not the workspace's brand profile; 409 needsAgent when no agent is registered; 409 alreadyQueued while an earlier request still waits.",
      ),
    }),
    async (c) => {
      const rc = await requestContext(c, c.req.param("shortId"))
      if (rc instanceof Response) return bail(rc)
      const { artifact, acting, agentId } = rc

      const [settings, agents] = await Promise.all([
        meta.getOrgSettings(artifact.org_id),
        meta.listAgents(artifact.org_id),
      ])
      // Only the workspace's brand-profile artifact can be generated into — the
      // canned brief tells the agent to publish for_review to exactly this short id.
      if (settings.brandprint?.profileId !== artifact.short_id)
        return bail(fail(c, 400, "this artifact is not the workspace's brand profile"))
      const agent = pickAgent(c, agents, agentId)
      if (agent instanceof Response) return bail(agent)
      if (await alreadyQueued(agent, artifact.short_id))
        return bail(
          fail(c, 409, `a request for this artifact is already queued for ${agent.name}`, {
            code: "alreadyQueued",
          }),
        )

      const requestId = await postRequest(
        artifact,
        acting,
        agent,
        buildProfileInstruction(artifact.short_id),
      )
      return c.json({ requestId }, 201)
    },
  )

  return app
}
