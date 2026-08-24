import {
  AGENT_INBOX_PAGE,
  type AgentRecord,
  type ArtifactRecord,
  buildProfileInstruction,
  fillInstruction,
  newId,
  profileState,
  reworkInstruction,
  saveAsSkillInstruction,
  workflowRunInstruction,
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
import { parseLinkedWorkflowFacts } from "../lib/workflow-facts"

/** The canned agent-request endpoints — Rework, generate-profile, and the fill and
 *  save-as-skill pairs (each pair: a GET returning the instruction for copy-paste, a
 *  POST delivering it). Thin wrappers over the existing @mention-to-inbox path: each
 *  composes its instruction server-side (the single source of truth; the client never
 *  carries a prompt) and posts it as a whole-document comment @mentioning the chosen
 *  agent, which drops into that agent's MCP pull inbox. The agent does the work and
 *  publishes per its grant: a publish-capable agent posts directly, a lower grant
 *  answers in comments — no special case here. */
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

  // The guard chain the POST endpoints share: the artifact, comment authz, a
  // signed-in requester (the request is authored and attributed — no anonymous
  // firing), the comment rate limit, and the optional body (readJson tolerates a
  // missing one, so a bare POST means "use the sole registered agent"). `note` is
  // consumed by fill and save-as-skill, `threadId` by save-as-skill only; the other
  // endpoints ignore them. Returns a ready-to-bail Response on any failed gate.
  const requestContext = async (c: Context, shortId: string) => {
    const artifact = await meta.getByShortId(shortId)
    if (!artifact || artifact.current_version === 0) return fail(c, 404, "not found")
    if (!(await authorize(c, "comment", artifact))) return fail(c, 403, "forbidden")
    const acting = await actingUser(c)
    if (!acting) return fail(c, 401, "sign in to send an agent request")
    const rl = await limited(c, commentLimiter)
    if (rl) return rl
    const body = await readJson(
      c,
      z.object({
        agentId: z.string().optional(),
        diagramId: z.string().optional(),
        note: z.string().max(500).optional(),
        threadId: z.string().optional(),
      }),
    )
    if (body instanceof Response) return body
    return {
      artifact,
      acting,
      agentId: body.agentId,
      diagramId: body.diagramId,
      note: body.note,
      threadId: body.threadId,
    }
  }

  // A thread reference in a capture request must name a thread ON this artifact —
  // a stale or foreign id would send the agent chasing a conversation that isn't
  // there. A thread's id is its root comment's id.
  const requireThread = async (
    c: Context,
    artifact: ArtifactRecord,
    threadId: string | undefined,
  ): Promise<Response | undefined> => {
    if (!threadId) return undefined
    const root = await meta.getComment(threadId)
    if (!root || root.artifact_id !== artifact.id)
      return fail(c, 404, "no such comment thread on this artifact")
    return undefined
  }

  // A fill request only makes sense on a derived copy, against a source that still
  // resolves — the instruction anchors on the template's short id. Returns the source
  // artifact or the refusal to bail with.
  const requireSource = async (c: Context, artifact: ArtifactRecord) => {
    if (!artifact.derived_from)
      return fail(c, 409, "this artifact was not derived from a template", {
        code: "notDerived",
      })
    const source = await meta.getArtifactById(artifact.derived_from)
    if (!source || source.removed_at)
      return fail(c, 409, "the template this was derived from is gone", { code: "sourceGone" })
    return source
  }

  // Does any Brandprint resolve for this requester? Fill works either way — the
  // brand line is simply omitted — unlike Rework, where the Brandprint IS the job.
  const hasBrandprint = async (orgId: string, userId: string): Promise<boolean> => {
    const resolved = await resolveActorBrandprint(meta, orgId, userId)
    return resolved.collectionIds.length > 0 || !!resolved.profileId
  }

  const requireReadyWorkflow = async (c: Context, artifact: ArtifactRecord, diagramId: string) => {
    const rows = await meta.getVersionData(artifact.id, artifact.current_version)
    const facts = parseLinkedWorkflowFacts(rows)
    if (!facts.bundleFound || !facts.workflowFound)
      return fail(c, 409, "this artifact does not contain a runnable workflow", {
        code: "notWorkflow",
      })
    if (!facts.manifest)
      return fail(c, 409, "the visible workflow graph needs changes", {
        code: "needsChanges",
        errors: facts.bundleErrors,
      })
    if (facts.preview?.status !== "ready")
      return fail(c, 409, "the workflow Preview needs changes", {
        code: "needsChanges",
        errors: facts.preview?.errors ?? [],
      })
    const diagram = facts.preview.diagrams.find((item) => item.id === diagramId)
    if (!diagram) return fail(c, 404, "no such workflow diagram")
    return diagram
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

  // Post the canned request: a whole-document comment (no anchor) @mentioning the
  // agent — the same ROW the ask-agent composer writes, but a deliberately narrower
  // fan-out: comment.created + mention/bell notify only, skipping the comment.mention
  // webhook, comment emails, Slack, and the GitHub PR echo. This is a canned,
  // bot-directed note, not a human conversation — mirroring it into those channels
  // would just be noise for people who didn't ask for it.
  //
  // One queued ask per (agent, artifact): the inbox is a pull queue, so re-firing while
  // the last request still waits would stack an identical row for the agent to do twice.
  // Returns the 409 instead of posting; once the agent acks, firing again is allowed.
  const postRequest = async (
    c: Context,
    artifact: ArtifactRecord,
    acting: Acting,
    agent: AgentRecord,
    instruction: string,
  ): Promise<string | Response> => {
    const queued = await meta.listPendingAgentMentions(agent.id, AGENT_INBOX_PAGE)
    if (queued.some((m) => m.artifact_short_id === artifact.short_id))
      return fail(c, 409, `a request for this artifact is already queued for ${agent.name}`, {
        code: "alreadyQueued",
      })
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
      method: "get",
      path: "/v1/artifacts/{shortId}/workflow-run",
      tags: ["Artifacts"],
      summary: "Get the explicit handoff prompt for a validated workflow diagram.",
      request: {
        params: z.object({ shortId: z.string() }),
        query: z.object({ diagram: z.string().min(1) }),
      },
      responses: {
        200: {
          description:
            "A copyable prompt for any local agent harness. Previewing it does not start execution.",
          content: {
            "application/json": {
              schema: z.object({
                prompt: z.string(),
                diagram: z.object({ id: z.string(), title: z.string() }),
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
      if (!(await actingUser(c))) return bail(fail(c, 401, "sign in to run this workflow"))
      const ready = await requireReadyWorkflow(c, artifact, c.req.query("diagram") ?? "")
      if (ready instanceof Response) return bail(ready)
      return c.json({
        prompt: workflowRunInstruction(artifact.short_id, ready.id),
        diagram: { id: ready.id, title: ready.title },
      })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/workflow-run",
      tags: ["Artifacts"],
      summary: "Queue a validated workflow diagram for a registered local agent.",
      request: {
        params: z.object({ shortId: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ agentId: z.string().optional(), diagramId: z.string().min(1) }),
            },
          },
        },
      },
      responses: requestCreated(
        "The validated workflow handoff landed in the selected agent's pull inbox. Derive does not execute the workflow itself.",
      ),
    }),
    async (c) => {
      const rc = await requestContext(c, c.req.param("shortId"))
      if (rc instanceof Response) return bail(rc)
      const { artifact, acting, agentId, diagramId } = rc
      if (!diagramId) return bail(fail(c, 400, "diagramId is required"))
      const ready = await requireReadyWorkflow(c, artifact, diagramId)
      if (ready instanceof Response) return bail(ready)
      const agent = pickAgent(c, await meta.listAgents(artifact.org_id), agentId)
      if (agent instanceof Response) return bail(agent)
      const requestId = await postRequest(
        c,
        artifact,
        acting,
        agent,
        workflowRunInstruction(artifact.short_id, ready.id),
      )
      if (requestId instanceof Response) return bail(requestId)
      return c.json({ requestId }, 201)
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/rework",
      tags: ["Artifacts"],
      summary: "Ask a registered agent to rework this artifact to match the Brandprint.",
      request: { params: z.object({ shortId: z.string() }), body: requestBody },
      responses: requestCreated(
        "The rework request was posted and landed in the agent's pull inbox. 409 needsAgent when no agent is registered; 409 needsBrandprint when no Brandprint resolves; 409 brandprintDisabled when the caller turned the workspace Brandprint off in their settings; 409 alreadyQueued while an earlier request for this artifact still waits.",
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

      // The resolved Brandprint (workspace ⊕ requester's profile) drives the
      // profile-first line and guards the empty brief: firing the canned instruction
      // with zero derive://brandprint/* resources behind it would hand the agent
      // nothing to read. An empty brief has two distinct causes: the caller turned
      // the workspace layer off (workspaceSuppressed), or nothing was ever set up.
      // Tell them apart so the client can point at Settings instead of onboarding.
      if (resolved.collectionIds.length === 0 && !resolved.profileId)
        return bail(
          resolved.workspaceSuppressed
            ? fail(c, 409, "Brandprint is turned off in your settings. Turn it on to rework.", {
                code: "brandprintDisabled",
              })
            : fail(c, 409, "no Brandprint is set on this workspace or your profile", {
                code: "needsBrandprint",
              }),
        )
      let profileLive = false
      if (resolved.profileId) {
        const prof = await meta.getByShortId(resolved.profileId)
        profileLive = !!prof && profileState(prof.current_version) === "live"
      }

      const requestId = await postRequest(
        c,
        artifact,
        acting,
        agent,
        reworkInstruction(profileLive),
      )
      if (requestId instanceof Response) return bail(requestId)
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
      // canned brief tells the agent to publish to exactly this short id (the round
      // that opens on publish is the person's reveal).
      if (settings.brandprint?.profileId !== artifact.short_id)
        return bail(fail(c, 400, "this artifact is not the workspace's brand profile"))
      const agent = pickAgent(c, agents, agentId)
      if (agent instanceof Response) return bail(agent)

      const requestId = await postRequest(
        c,
        artifact,
        acting,
        agent,
        buildProfileInstruction(artifact.short_id),
      )
      if (requestId instanceof Response) return bail(requestId)
      return c.json({ requestId }, 201)
    },
  )

  // The copyable capture prompt — save-as-skill for whatever agent the requester
  // already has open. This is the variant most sessions use: consumption is mostly
  // local MCP sessions, and those need no registered agent, just the text.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{shortId}/save-as-skill",
      tags: ["Artifacts"],
      summary: "The capture prompt: turn a review correction into a workspace skill.",
      request: {
        params: z.object({ shortId: z.string() }),
        query: z.object({
          threadId: z
            .string()
            .optional()
            .describe("The comment thread carrying the correction; omit for the whole page."),
          note: z
            .string()
            .max(500)
            .optional()
            .describe("Optional requester intent, appended to the prompt verbatim."),
        }),
      },
      responses: {
        200: {
          description: "The prompt. 404 when a threadId names no thread on this artifact.",
          content: {
            "application/json": { schema: z.object({ prompt: z.string() }) },
          },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact || artifact.current_version === 0) return bail(fail(c, 404, "not found"))
      if (!(await authorize(c, "comment", artifact))) return bail(fail(c, 403, "forbidden"))
      const acting = await actingUser(c)
      if (!acting) return bail(fail(c, 401, "sign in to capture a skill"))
      const threadId = c.req.query("threadId")
      const badThread = await requireThread(c, artifact, threadId)
      if (badThread) return bail(badThread)
      return c.json({
        prompt: saveAsSkillInstruction(artifact.short_id, {
          threadId,
          note: c.req.query("note"),
        }),
      })
    },
  )

  // One-click capture: the same instruction, delivered to a registered agent's inbox.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/save-as-skill",
      tags: ["Artifacts"],
      summary: "Ask a registered agent to turn a review correction into a workspace skill.",
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
                threadId: z
                  .string()
                  .optional()
                  .describe("The comment thread carrying the correction."),
                note: z
                  .string()
                  .max(500)
                  .optional()
                  .describe("Optional requester intent, appended to the prompt verbatim."),
              }),
            },
          },
        },
      },
      responses: requestCreated(
        "The capture request landed in the agent's pull inbox. 404 when a threadId names " +
          "no thread on this artifact; 409 needsAgent when no agent is registered; 409 " +
          "alreadyQueued while an earlier request for this artifact still waits.",
      ),
    }),
    async (c) => {
      const rc = await requestContext(c, c.req.param("shortId"))
      if (rc instanceof Response) return bail(rc)
      const { artifact, acting, agentId, note, threadId } = rc
      const badThread = await requireThread(c, artifact, threadId)
      if (badThread) return bail(badThread)
      const agent = pickAgent(c, await meta.listAgents(artifact.org_id), agentId)
      if (agent instanceof Response) return bail(agent)
      const requestId = await postRequest(
        c,
        artifact,
        acting,
        agent,
        saveAsSkillInstruction(artifact.short_id, { threadId, note }),
      )
      if (requestId instanceof Response) return bail(requestId)
      return c.json({ requestId }, 201)
    },
  )

  // The copyable fill prompt — the sheet's "paste this into whatever agent you
  // already have" path. Same fillInstruction the POST below delivers to an inbox,
  // ?note= included, so the client never assembles any part of the prompt.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{shortId}/fill",
      tags: ["Artifacts"],
      summary: "The fill-with-your-work prompt for a derived copy (the copy-paste variant).",
      request: {
        params: z.object({ shortId: z.string() }),
        query: z.object({
          note: z
            .string()
            .max(500)
            .optional()
            .describe("Optional requester intent, appended to the prompt verbatim."),
        }),
      },
      responses: {
        200: {
          description:
            "The prompt and the resolved template. 409 notDerived when the artifact has no " +
            "template lineage; 409 sourceGone when the template no longer resolves.",
          content: {
            "application/json": {
              schema: z.object({
                prompt: z.string(),
                source: z.object({ short_id: z.string(), title: z.string().nullable() }),
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
      const acting = await actingUser(c)
      if (!acting) return bail(fail(c, 401, "sign in to fill from a template"))
      const source = await requireSource(c, artifact)
      if (source instanceof Response) return bail(source)
      const prompt = fillInstruction(artifact.short_id, source.short_id, {
        brandprint: await hasBrandprint(artifact.org_id, acting.id),
        note: c.req.query("note"),
      })
      return c.json({ prompt, source: { short_id: source.short_id, title: source.title } })
    },
  )

  // One-click fill: the same instruction, delivered to the chosen agent's inbox.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/fill",
      tags: ["Artifacts"],
      summary: "Ask a registered agent to fill this derived copy with the workspace's real work.",
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
                note: z
                  .string()
                  .max(500)
                  .optional()
                  .describe("Optional requester intent, appended to the prompt verbatim."),
              }),
            },
          },
        },
      },
      responses: requestCreated(
        "The fill request landed in the agent's pull inbox. 409 notDerived when the artifact " +
          "has no template lineage; 409 sourceGone when the template no longer resolves; 409 " +
          "needsAgent when no agent is registered; 409 alreadyQueued while an earlier request " +
          "for this artifact still waits.",
      ),
    }),
    async (c) => {
      const rc = await requestContext(c, c.req.param("shortId"))
      if (rc instanceof Response) return bail(rc)
      const { artifact, acting, agentId, note } = rc
      const source = await requireSource(c, artifact)
      if (source instanceof Response) return bail(source)
      const agent = pickAgent(c, await meta.listAgents(artifact.org_id), agentId)
      if (agent instanceof Response) return bail(agent)
      const instruction = fillInstruction(artifact.short_id, source.short_id, {
        brandprint: await hasBrandprint(artifact.org_id, acting.id),
        note,
      })
      const requestId = await postRequest(c, artifact, acting, agent, instruction)
      if (requestId instanceof Response) return bail(requestId)
      return c.json({ requestId }, 201)
    },
  )

  return app
}
