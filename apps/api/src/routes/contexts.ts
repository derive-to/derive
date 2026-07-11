import {
  type ContextAskerRecord,
  type ContextRecord,
  newId,
  type SessionMessageRecord,
  type SessionRecord,
  type SessionState,
  type UserDir,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"
import { log } from "../log"

/**
 * Contexts (askable agent setups) + sessions (ask-conversations with one).
 *
 * A context links a registered agent to its manifest artifact. Ask-access is a
 * WORKSPACE-SCOPED grant on the context itself (ask_policy + the asker roster) —
 * NOT the manifest's artifact sharing: a context is a data grant, not a document,
 * and must never be reachable outside its workspace (see canAskContext). Sessions
 * are private to the asker and the context owner — 404 to everyone else, so their
 * existence never leaks. The runner drains `open` sessions from the queue endpoint
 * with the agent's own bearer and answers through the messages endpoint. The
 * ContextInfo / Session / SessionMessage schemas are the single source for the web types.
 */
export const contextRoutes = (ctx: AppContext) => {
  const {
    meta,
    activeWorkspace,
    agentFor,
    authorize,
    canAskContext,
    currentUser,
    managementPrincipal,
    requireUser,
    requireWorkspace,
    sourceText,
    workspaceCan,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const ContextInfo = z
    .object({
      id: z.string(),
      name: z.string(),
      agent_id: z.string().describe("The registered agent this context routes asks to."),
      manifest_short_id: z
        .string()
        .nullable()
        .describe("Short id of the linked manifest artifact; null if it can't be resolved."),
      created_by: z.string(),
      created_at: z.string(),
      runner_seen_at: z
        .string()
        .nullable()
        .describe(
          "When the runner last polled the queue (~minutely); null = never. Drives online/offline.",
        ),
      ask_policy: z
        .enum(["workspace", "invited"])
        .describe(
          "Who in the workspace may ask: any member, or the invited roster. Never outside the workspace.",
        ),
    })
    .openapi("ContextInfo")

  // The runner's structured payload on an agent message (parsed server-side).
  const SessionMeta = z
    .object({
      query: z
        .string()
        .nullable()
        .optional()
        .describe("The underlying query the agent ran to produce this answer."),
      confidence: z
        .number()
        .nullable()
        .optional()
        .describe("The agent's confidence in the answer, 0-1 (shown as a percentage)."),
      caveats: z
        .array(z.string())
        .optional()
        .describe("Caveats or limitations the agent flagged on its answer."),
      escalation_reason: z
        .string()
        .nullable()
        .optional()
        .describe("Why the agent escalated to a human instead of answering."),
      artifacts: z
        .array(z.object({ short_id: z.string(), title: z.string() }))
        .optional()
        .describe("Artifacts the agent cited, each linkable by short_id."),
    })
    .openapi("SessionMeta")

  const SessionMessage = z
    .object({
      id: z.string(),
      author_kind: z
        .enum(["asker", "agent"])
        .describe("Who wrote it: asker (the human) or agent (the context's runner)."),
      author_id: z
        .string()
        .describe("The asker's user id, or the agent id when author_kind is agent."),
      body_md: z.string().describe("The message body as Markdown."),
      meta: SessionMeta.nullable().describe(
        "Structured answer payload on agent messages; null on asker messages.",
      ),
      created_at: z.string(),
    })
    .openapi("SessionMessage")

  const Session = z
    .object({
      id: z.string(),
      context_id: z.string(),
      asker_id: z.string(),
      context_version: z.number().describe("The manifest version this session was opened against."),
      state: z
        .enum(["open", "answered", "escalated", "failed", "closed"])
        .describe(
          "open = awaiting the agent; answered; escalated = draft went to review; failed = run crashed; closed = ended by asker/owner.",
        ),
      created_at: z.string(),
      updated_at: z
        .string()
        .describe("Last state/message change; equals created_at when never updated."),
    })
    .openapi("Session")

  const contextJson = (x: ContextRecord, manifestShortId: string | null) => ({
    id: x.id,
    name: x.name,
    agent_id: x.agent_id,
    manifest_short_id: manifestShortId,
    created_by: x.created_by,
    created_at: x.created_at,
    runner_seen_at: x.runner_seen_at,
    ask_policy: x.ask_policy,
  })

  const messageJson = (m: SessionMessageRecord) => {
    // Stored as TEXT (see ports); parsed here so clients never re-parse. Only
    // this route ever writes it (JSON.stringify), but a hand-edited row
    // shouldn't 500 a whole transcript — treat unparseable meta as absent.
    let meta: z.infer<typeof SessionMeta> | null = null
    if (m.meta) {
      try {
        meta = JSON.parse(m.meta) as z.infer<typeof SessionMeta>
      } catch {
        meta = null
      }
    }
    return {
      id: m.id,
      author_kind: m.author_kind,
      author_id: m.author_id,
      body_md: m.body_md,
      meta,
      created_at: m.created_at,
    }
  }

  const sessionJson = (s: SessionRecord) => ({
    id: s.id,
    context_id: s.context_id,
    asker_id: s.asker_id,
    context_version: s.context_version,
    state: s.state,
    created_at: s.created_at,
    updated_at: s.updated_at ?? s.created_at,
  })

  /** A session's context + manifest, or null when either half is gone. */
  const contextOf = async (s: SessionRecord) => {
    const x = await meta.getContext(s.context_id)
    if (!x) return null
    const manifest = await meta.getArtifactById(x.manifest_artifact_id)
    return manifest ? { context: x, manifest } : null
  }

  // Create a context: wire an agent to a manifest artifact. Editor+ in the
  // workspace, and share-standing on the manifest (creating a context exposes the
  // manifest's identity to askers, so it's a sharing decision). Who can ASK is a
  // separate, workspace-scoped grant on the context — set via /access, not here.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/contexts",
      tags: ["Contexts"],
      summary: "Create a context (wire an agent to a manifest artifact).",
      responses: {
        201: {
          description: "The created context.",
          content: { "application/json": { schema: ContextInfo } },
        },
      },
    }),
    async (c) => {
      // Management principals only: a signed-in user, or an OAuth grant carrying
      // derive:manage (`derive context push`) acting as its grantor — that human
      // keys created_by. Registered dk_agt_ runner tokens are deliberately NOT
      // accepted here (nor on list/delete): they're runtime principals, and a
      // stolen one must not be able to rewire ask surfaces. The capability gate
      // still applies on top with the grant's membership-capped role.
      const owner = await managementPrincipal(c)
      if (!owner) return bail(fail(c, 401, "unauthenticated"))
      const org = await requireWorkspace(c, "publish")
      if (org instanceof Response) return bail(org)
      const b = await readJson(
        c,
        z.object({
          name: z.string().trim().min(1).max(80),
          agent_id: z.string(),
          manifest_short_id: z.string(),
        }),
      )
      if (b instanceof Response) return bail(b)
      const agents = await meta.listAgents(org)
      if (!agents.some((a) => a.id === b.agent_id)) return bail(fail(c, 404, "no such agent"))
      const manifest = await meta.getByShortId(b.manifest_short_id)
      if (!manifest || manifest.org_id !== org || !(await authorize(c, "share", manifest)))
        return bail(fail(c, 404, "no such artifact"))
      try {
        const created = await meta.createContext({
          id: newId("ctx"),
          org_id: org,
          name: b.name,
          agent_id: b.agent_id,
          manifest_artifact_id: manifest.id,
          created_by: owner,
        })
        return c.json(contextJson(created, manifest.short_id), 201)
      } catch {
        return bail(fail(c, 409, "a context with that name already exists"))
      }
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/contexts",
      tags: ["Contexts"],
      summary: "List the workspace's contexts.",
      responses: {
        200: {
          description: "The workspace's contexts.",
          content: { "application/json": { schema: z.object({ contexts: z.array(ContextInfo) }) } },
        },
      },
    }),
    async (c) => {
      // Management principals only (see POST): the list exposes every context's
      // wiring (agent ids, creators), which GET /:id deliberately hides from
      // agents that aren't the context's own.
      if (!(await managementPrincipal(c))) return bail(fail(c, 401, "unauthenticated"))
      const org = await requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)
      const rows = await meta.listContexts(org)
      // Resolve every context's manifest artifact in ONE query, then map id → short_id —
      // not a getArtifactById per row.
      const manifests = await meta.getArtifactsByIds(rows.map((x) => x.manifest_artifact_id))
      const shortById = new Map(manifests.map((a) => [a.id, a.short_id]))
      const contexts = rows.map((x) =>
        contextJson(x, shortById.get(x.manifest_artifact_id) ?? null),
      )
      return c.json({ contexts })
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/contexts/{id}",
      tags: ["Contexts"],
      summary: "One context; the context's agent also gets the manifest source to run.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The context (with manifest source for the agent).",
          content: {
            "application/json": {
              schema: ContextInfo.extend({
                manifest_version: z.number().optional(),
                manifest_md: z.string().nullable().optional(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const x = await meta.getContext(c.req.param("id"))
      if (!x) return bail(fail(c, 404, "not found"))
      // The context's own agent gets its wiring to run; a human gets it only if
      // they can ASK — workspace-scoped, never via the manifest's artifact access
      // (see canAskContext). A context is a data grant, not a document: it must
      // not be reachable outside its workspace, so 404 (not 403) to everyone else
      // — its existence never leaks.
      const agent = await agentFor(c)
      const manifest = await meta.getArtifactById(x.manifest_artifact_id)
      const allowed = agent ? agent.id === x.agent_id : await canAskContext(c, x)
      if (!allowed) return bail(fail(c, 404, "not found"))
      // The runner's one config fetch: its system prompt is the manifest's current
      // source, so a manifest edit reconfigures the runner with no deploy.
      if (agent && manifest) {
        const v = await meta.getVersion(manifest.id, manifest.current_version)
        return c.json({
          ...contextJson(x, manifest.short_id),
          manifest_version: manifest.current_version,
          manifest_md: v ? await sourceText(v) : null,
        })
      }
      return c.json(contextJson(x, manifest?.short_id ?? null))
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/contexts/{id}",
      tags: ["Contexts"],
      summary: "Delete a context (its creator or a workspace manager).",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "The context was deleted." } },
    }),
    async (c) => {
      // Management principals only (see POST) — the created_by match below must
      // never be reachable by the runner's own token, whose registrant usually
      // IS the context creator.
      const owner = await managementPrincipal(c)
      if (!owner) return bail(fail(c, 401, "unauthenticated"))
      const x = await meta.getContext(c.req.param("id"))
      // workspaceCan reads the CALLER's active workspace, so it only authorizes
      // deletes of that workspace's contexts — without the org check, a manager of
      // workspace B would pass it and reach into workspace A. Cross-workspace
      // callers get the same 404 as a missing id.
      if (!x || x.org_id !== (await activeWorkspace(c))) return bail(fail(c, 404, "not found"))
      if (x.created_by !== owner && !(await workspaceCan(c, "manage")))
        return bail(fail(c, 403, "forbidden"))
      await meta.deleteContext(x.id, x.org_id)
      return c.body(null, 204)
    },
  )

  // ---- ask-access management (workspace-scoped only) ------------------------
  // The context that this caller may MANAGE (set who can ask), or a Response to
  // return. Management is the creator or a workspace manager — the same gate as
  // delete, and NOT reachable by a runner's own agent token (managementPrincipal
  // refuses those). Scoped to the caller's active workspace so a manager of B
  // can't reach into A; cross-workspace callers get the same 404 as a missing id.
  const manageableContext = async (c: Context): Promise<ContextRecord | Response> => {
    const owner = await managementPrincipal(c)
    if (!owner) return fail(c, 401, "unauthenticated")
    // The generic hono Context (this helper is route-shared) types params as
    // possibly-undefined; an empty id just resolves to no context → 404.
    const x = await meta.getContext(c.req.param("id") ?? "")
    if (!x || x.org_id !== (await activeWorkspace(c))) return fail(c, 404, "not found")
    if (x.created_by !== owner && !(await workspaceCan(c, "manage")))
      return fail(c, 403, "forbidden")
    return x
  }

  const askerJson = (a: ContextAskerRecord, u: UserDir | undefined) => ({
    user_id: a.user_id,
    username: u?.username ?? null,
    added_at: a.created_at,
  })

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/contexts/{id}/access",
      tags: ["Contexts"],
      summary: "Set who may ask a context (workspace | invited). Never leaves the workspace.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The updated ask policy.",
          content: {
            "application/json": {
              schema: z.object({ ask_policy: z.enum(["workspace", "invited"]) }),
            },
          },
        },
      },
    }),
    async (c) => {
      const x = await manageableContext(c)
      if (x instanceof Response) return bail(x)
      const b = await readJson(c, z.object({ ask_policy: z.enum(["workspace", "invited"]) }))
      if (b instanceof Response) return bail(b)
      await meta.setContextAskPolicy(x.id, b.ask_policy)
      return c.json({ ask_policy: b.ask_policy })
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/contexts/{id}/askers",
      tags: ["Contexts"],
      summary: "The invited-asker roster (manager only).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The roster.",
          content: {
            "application/json": {
              schema: z.object({
                askers: z.array(
                  z.object({
                    user_id: z.string(),
                    username: z.string().nullable(),
                    added_at: z.string(),
                  }),
                ),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const x = await manageableContext(c)
      if (x instanceof Response) return bail(x)
      const roster = await meta.listContextAskers(x.id)
      const users = new Map(
        (await meta.getUsers(roster.map((a) => a.user_id))).map((u) => [u.id, u]),
      )
      return c.json({ askers: roster.map((a) => askerJson(a, users.get(a.user_id))) })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/contexts/{id}/askers",
      tags: ["Contexts"],
      summary: "Invite a WORKSPACE MEMBER to ask (by email). A non-member is rejected.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        201: {
          description: "The added asker.",
          content: {
            "application/json": {
              schema: z.object({
                user_id: z.string(),
                username: z.string().nullable(),
                added_at: z.string(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const x = await manageableContext(c)
      if (x instanceof Response) return bail(x)
      const owner = (await managementPrincipal(c)) as string
      const b = await readJson(c, z.object({ email: z.string().trim().email() }))
      if (b instanceof Response) return bail(b)
      const user = await meta.findUserByEmail(b.email)
      if (!user) return bail(fail(c, 404, "no such user"))
      // The invariant, enforced at the source: only a member of THIS context's
      // workspace can be added to the roster. A non-member can never be an asker,
      // so the roster can't reference outside the workspace.
      if (!(await meta.getMembership(x.org_id, user.id)))
        return bail(fail(c, 400, "that person isn't a member of this workspace"))
      const added = await meta.addContextAsker({
        id: newId("cask"),
        context_id: x.id,
        user_id: user.id,
        added_by: owner,
      })
      return c.json(askerJson(added, user), 201)
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/contexts/{id}/askers/{userId}",
      tags: ["Contexts"],
      summary: "Remove someone from the asker roster (manager only).",
      request: { params: z.object({ id: z.string(), userId: z.string() }) },
      responses: { 204: { description: "Removed." } },
    }),
    async (c) => {
      const x = await manageableContext(c)
      if (x instanceof Response) return bail(x)
      await meta.removeContextAsker(x.id, c.req.param("userId"))
      return c.body(null, 204)
    },
  )

  // Ask: open a session with the first question. The ask grant is the context's
  // own workspace-scoped policy (canAskContext) — NOT manifest read-access.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/contexts/{id}/sessions",
      tags: ["Contexts"],
      summary: "Ask: open a session with the first question.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        201: {
          description: "The new session and its first message.",
          content: {
            "application/json": {
              schema: z.object({ session: Session, messages: z.array(SessionMessage) }),
            },
          },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const x = await meta.getContext(c.req.param("id"))
      // Asking is a workspace-scoped grant on the CONTEXT, not manifest read —
      // so a manifest world link can never open a session (query the data).
      if (!x || !(await canAskContext(c, x))) return bail(fail(c, 404, "not found"))
      const manifest = await meta.getArtifactById(x.manifest_artifact_id)
      if (!manifest) return bail(fail(c, 404, "not found"))
      const b = await readJson(c, z.object({ body_md: z.string().trim().min(1).max(20_000) }))
      if (b instanceof Response) return bail(b)
      const session = await meta.createSession({
        id: newId("ses"),
        context_id: x.id,
        org_id: x.org_id,
        asker_id: me.id,
        context_version: manifest.current_version,
      })
      const first = await meta.addSessionMessage(
        {
          id: newId("sm"),
          session_id: session.id,
          author_kind: "asker",
          author_id: me.id,
          body_md: b.body_md,
        },
        "open",
      )
      return c.json({ session: sessionJson(session), messages: [messageJson(first)] }, 201)
    },
  )

  // A context's sessions: the owner sees every session (the activity view);
  // anyone else sees only their own.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/contexts/{id}/sessions",
      tags: ["Contexts"],
      summary: "A context's sessions (owner sees all; others only their own).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The sessions.",
          content: { "application/json": { schema: z.object({ sessions: z.array(Session) }) } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const x = await meta.getContext(c.req.param("id"))
      if (!x || !(await canAskContext(c, x))) return bail(fail(c, 404, "not found"))
      const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50))
      const sessions = await meta.listSessions(x.id, {
        askerId: x.created_by === me.id ? undefined : me.id,
        limit,
      })
      return c.json({ sessions: sessions.map(sessionJson) })
    },
  )

  // One session with its transcript — the asker's and the context owner's view.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/sessions/{id}",
      tags: ["Contexts"],
      summary: "One session with its transcript (asker or context owner).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The session, its context, and the full transcript.",
          content: {
            "application/json": {
              schema: z.object({
                session: Session,
                context: z.object({ id: z.string(), name: z.string() }),
                messages: z.array(SessionMessage),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const s = await meta.getSession(c.req.param("id"))
      const linked = s ? await contextOf(s) : null
      // Membership is the floor for BOTH parties: canAskContext requires it even
      // for the creator, so a removed creator can't keep reading transcripts any
      // more than a removed asker can (the invariant applies to owners too). The
      // creator sees ANY session on their context; anyone else sees only their
      // own — sessions stay private to asker + owner.
      const allowed =
        !!s &&
        !!linked &&
        (await canAskContext(c, linked.context)) &&
        (linked.context.created_by === me.id || s.asker_id === me.id)
      if (!s || !linked || !allowed) return bail(fail(c, 404, "not found"))
      const messages = await meta.listSessionMessages(s.id)
      return c.json({
        session: sessionJson(s),
        context: { id: linked.context.id, name: linked.context.name },
        messages: messages.map(messageJson),
      })
    },
  )

  // Append a turn. The asker's message re-opens the session (back on the queue);
  // the context's agent settles it (answered, or escalated when its draft went to
  // review, or failed when the run crashed).
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/sessions/{id}/messages",
      tags: ["Contexts"],
      summary: "Append a message to a session (asker follow-up or the agent's answer).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        201: {
          description: "The appended message.",
          content: { "application/json": { schema: z.object({ message: SessionMessage }) } },
        },
      },
    }),
    async (c) => {
      const s = await meta.getSession(c.req.param("id"))
      const linked = s ? await contextOf(s) : null
      if (!s || !linked) return bail(fail(c, 404, "not found"))
      // Authorization decides before state does: a caller with no standing gets the
      // same 404 whether the session is open or closed — 409 would leak its state.
      const closed = (): Response | null =>
        s.state === "closed" ? fail(c, 409, "session is closed") : null

      const agent = await agentFor(c)
      if (agent) {
        if (agent.id !== linked.context.agent_id) return bail(fail(c, 404, "not found"))
        const gone = closed()
        if (gone) return bail(gone)
        const b = await readJson(
          c,
          z.object({
            body_md: z.string().trim().min(1).max(100_000),
            meta: z.unknown().optional(),
            state: z.enum(["answered", "escalated", "failed"]).optional(),
            // The asker message this answer addresses (from the runner's queue
            // snapshot) — the guard against the lost-turn race below.
            answers: z.string().optional(),
          }),
        )
        if (b instanceof Response) return bail(b)
        // A model run takes minutes; the asker may follow up mid-run. An answer
        // generated before that follow-up must not settle the session — it would
        // take the follow-up off the queue unanswered, permanently. When the
        // runner says which message it answered and a newer asker message exists,
        // keep the session open (the re-serve sees the full transcript) and stamp
        // the answer stale so the runner's duplicate guard knows to re-serve.
        let state: SessionState = b.state ?? "answered"
        let payloadMeta = b.meta
        if (b.answers !== undefined && state !== "failed") {
          const transcript = await meta.listSessionMessages(s.id)
          const lastAsker = transcript.filter((t) => t.author_kind === "asker").at(-1)
          if (lastAsker && lastAsker.id !== b.answers) {
            state = "open"
            payloadMeta = { ...(typeof b.meta === "object" ? b.meta : {}), stale: true }
          }
        }
        const m = await meta.addSessionMessage(
          {
            id: newId("sm"),
            session_id: s.id,
            author_kind: "agent",
            author_id: agent.id,
            body_md: b.body_md,
            meta: payloadMeta === undefined ? null : JSON.stringify(payloadMeta),
          },
          state,
        )
        return c.json({ message: messageJson(m) }, 201)
      }

      const me = await currentUser(c)
      if (!me) return bail(fail(c, 401, "unauthenticated"))
      // Re-gate on ask-access, not just session ownership: a follow-up re-opens
      // the session and the runner answers it (a fresh query against the data).
      // A member removed from the workspace/roster after opening a session must
      // not keep querying through it — canAskContext re-checks membership + policy.
      if (s.asker_id !== me.id || !(await canAskContext(c, linked.context)))
        return bail(fail(c, 404, "not found"))
      const gone = closed()
      if (gone) return bail(gone)
      const b = await readJson(c, z.object({ body_md: z.string().trim().min(1).max(20_000) }))
      if (b instanceof Response) return bail(b)
      const m = await meta.addSessionMessage(
        {
          id: newId("sm"),
          session_id: s.id,
          author_kind: "asker",
          author_id: me.id,
          body_md: b.body_md,
        },
        "open",
      )
      return c.json({ message: messageJson(m) }, 201)
    },
  )

  // Close (asker or owner) / fail without a message (the runner's crash path).
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/sessions/{id}",
      tags: ["Contexts"],
      summary: "Close a session (asker/owner) or fail it (the context's agent).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The updated session.",
          content: { "application/json": { schema: z.object({ session: Session }) } },
        },
      },
    }),
    async (c) => {
      const s = await meta.getSession(c.req.param("id"))
      const linked = s ? await contextOf(s) : null
      if (!s || !linked) return bail(fail(c, 404, "not found"))

      const agent = await agentFor(c)
      if (agent) {
        if (agent.id !== linked.context.agent_id) return bail(fail(c, 404, "not found"))
        // The asker may close mid-run; the run's eventual failure must not reopen
        // a conversation they deliberately ended.
        if (s.state === "closed") return bail(fail(c, 409, "session is closed"))
        const b = await readJson(c, z.object({ state: z.literal("failed") }))
        if (b instanceof Response) return bail(b)
        const updated = await meta.setSessionState(s.id, b.state)
        if (!updated) return bail(fail(c, 404, "not found"))
        return c.json({ session: sessionJson(updated) })
      }

      const me = await currentUser(c)
      if (!me) return bail(fail(c, 401, "unauthenticated"))
      // Same membership floor as the session read: a removed asker/creator can't
      // touch the session at all (close included) once they're out of the workspace.
      if (
        !(await canAskContext(c, linked.context)) ||
        (s.asker_id !== me.id && linked.context.created_by !== me.id)
      )
        return bail(fail(c, 404, "not found"))
      const b = await readJson(c, z.object({ state: z.literal("closed") }))
      if (b instanceof Response) return bail(b)
      const updated = await meta.setSessionState(s.id, b.state)
      if (!updated) return bail(fail(c, 404, "not found"))
      return c.json({ session: sessionJson(updated) })
    },
  )

  // The runner's queue: open sessions, oldest first, transcripts embedded so one
  // poll is one round-trip. Auth = the context's own agent bearer (the inbox model).
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/contexts/{id}/queue",
      tags: ["Contexts"],
      summary: "The runner's queue: open sessions with transcripts (agent bearer).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Open sessions, oldest first, each with its transcript.",
          content: {
            "application/json": {
              schema: z.object({
                sessions: z.array(Session.extend({ messages: z.array(SessionMessage) })),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const agent = await agentFor(c)
      if (!agent) return bail(fail(c, 401, "agent token required"))
      const x = await meta.getContext(c.req.param("id"))
      if (!x || x.agent_id !== agent.id) return bail(fail(c, 404, "not found"))
      // Liveness IS this poll — no heartbeat protocol. Stamp at most once a
      // minute (the poll is ~5s; a write per poll would be pure churn, and the
      // console's 90s "online" window tolerates the gap). Best-effort: a failed
      // stamp must not 500 the queue — the runner's real job comes first.
      const now = new Date()
      if (!x.runner_seen_at || now.getTime() - new Date(x.runner_seen_at).getTime() > 60_000) {
        try {
          await meta.touchContextSeen(x.id, now.toISOString())
        } catch (err) {
          log.warn("runner liveness stamp failed", {
            context: x.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const limit = Math.min(20, Math.max(1, Number(c.req.query("limit")) || 10))
      const sessions = await meta.pendingSessions(x.id, limit)
      // One query for every pending session's transcript, then group by session_id —
      // not a listSessionMessages per session.
      const bySession = new Map<string, ReturnType<typeof messageJson>[]>()
      for (const m of await meta.listSessionMessagesFor(sessions.map((s) => s.id))) {
        const arr = bySession.get(m.session_id)
        if (arr) arr.push(messageJson(m))
        else bySession.set(m.session_id, [messageJson(m)])
      }
      const out = sessions.map((s) => ({
        ...sessionJson(s),
        messages: bySession.get(s.id) ?? [],
      }))
      return c.json({ sessions: out })
    },
  )

  return app
}
