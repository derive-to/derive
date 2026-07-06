import {
  type ContextRecord,
  newId,
  type SessionMessageRecord,
  type SessionRecord,
  type SessionState,
} from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"

/**
 * Contexts (askable agent setups) + sessions (ask-conversations with one).
 *
 * A context links a registered agent to its manifest artifact; the manifest's
 * share roster is the ask grant (v1: viewer on the manifest = can ask). Sessions
 * are private to the asker and the context owner — 404 to everyone else, so their
 * existence never leaks. The runner drains `open` sessions from the queue endpoint
 * with the agent's own bearer and answers through the messages endpoint.
 */
export const contextRoutes = (ctx: AppContext) => {
  const {
    meta,
    activeWorkspace,
    agentFor,
    authorize,
    currentUser,
    requireUser,
    sourceText,
    workspaceCan,
  } = ctx
  const app = new Hono()

  const contextJson = (x: ContextRecord, manifestShortId: string | null) => ({
    id: x.id,
    name: x.name,
    agent_id: x.agent_id,
    manifest_short_id: manifestShortId,
    created_by: x.created_by,
    created_at: x.created_at,
  })

  const messageJson = (m: SessionMessageRecord) => {
    // Stored as TEXT (see ports); parsed here so clients never re-parse. Only
    // this route ever writes it (JSON.stringify), but a hand-edited row
    // shouldn't 500 a whole transcript — treat unparseable meta as absent.
    let meta: unknown = null
    if (m.meta) {
      try {
        meta = JSON.parse(m.meta)
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
  // workspace, and share-standing on the manifest — creating a context makes the
  // manifest's roster govern who can ask, which is a sharing decision.
  app.post("/v1/contexts", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    if (!(await workspaceCan(c, "publish"))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z.object({
        name: z.string().trim().min(1).max(80),
        agent_id: z.string(),
        manifest_short_id: z.string(),
      }),
    )
    if (b instanceof Response) return b
    const org = await activeWorkspace(c)
    const agents = await meta.listAgents(org)
    if (!agents.some((a) => a.id === b.agent_id)) return fail(c, 404, "no such agent")
    const manifest = await meta.getByShortId(b.manifest_short_id)
    if (!manifest || manifest.org_id !== org || !(await authorize(c, "share", manifest)))
      return fail(c, 404, "no such artifact")
    try {
      const created = await meta.createContext({
        id: newId("ctx"),
        org_id: org,
        name: b.name,
        agent_id: b.agent_id,
        manifest_artifact_id: manifest.id,
        created_by: me.id,
      })
      return c.json(contextJson(created, manifest.short_id), 201)
    } catch {
      return fail(c, 409, "a context with that name already exists")
    }
  })

  app.get("/v1/contexts", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    if (!(await workspaceCan(c, "read"))) return fail(c, 403, "forbidden")
    const rows = await meta.listContexts(await activeWorkspace(c))
    const contexts = await Promise.all(
      rows.map(async (x) =>
        contextJson(x, (await meta.getArtifactById(x.manifest_artifact_id))?.short_id ?? null),
      ),
    )
    return c.json({ contexts })
  })

  app.get("/v1/contexts/:id", async (c) => {
    const x = await meta.getContext(c.req.param("id"))
    if (!x) return fail(c, 404, "not found")
    // Visible to whoever can read the manifest (users) — or to the context's own
    // agent, which needs its wiring (name, manifest) to run.
    const agent = await agentFor(c)
    const manifest = await meta.getArtifactById(x.manifest_artifact_id)
    // Users need manifest read AND a session: a public manifest makes its
    // CONTENT world-readable, but the context's wiring (agent id, creator)
    // stays behind sign-in.
    const allowed = agent
      ? agent.id === x.agent_id
      : manifest !== null &&
        (await currentUser(c)) !== null &&
        (await authorize(c, "read", manifest))
    if (!allowed) return fail(c, 404, "not found")
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
  })

  app.delete("/v1/contexts/:id", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const x = await meta.getContext(c.req.param("id"))
    // workspaceCan reads the CALLER's active workspace, so it only authorizes
    // deletes of that workspace's contexts — without the org check, a manager of
    // workspace B would pass it and reach into workspace A. Cross-workspace
    // callers get the same 404 as a missing id.
    if (!x || x.org_id !== (await activeWorkspace(c))) return fail(c, 404, "not found")
    if (x.created_by !== me.id && !(await workspaceCan(c, "manage")))
      return fail(c, 403, "forbidden")
    await meta.deleteContext(x.id, x.org_id)
    return c.body(null, 204)
  })

  // Ask: open a session with the first question. The ask grant is read on the
  // manifest, so sharing the manifest is sharing the context.
  app.post("/v1/contexts/:id/sessions", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const x = await meta.getContext(c.req.param("id"))
    const manifest = x ? await meta.getArtifactById(x.manifest_artifact_id) : null
    if (!x || !manifest || !(await authorize(c, "read", manifest))) return fail(c, 404, "not found")
    const b = await readJson(c, z.object({ body_md: z.string().trim().min(1).max(20_000) }))
    if (b instanceof Response) return b
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
  })

  // A context's sessions: the owner sees every session (the activity view);
  // anyone else sees only their own.
  app.get("/v1/contexts/:id/sessions", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const x = await meta.getContext(c.req.param("id"))
    const manifest = x ? await meta.getArtifactById(x.manifest_artifact_id) : null
    if (!x || !manifest || !(await authorize(c, "read", manifest))) return fail(c, 404, "not found")
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50))
    const sessions = await meta.listSessions(x.id, {
      askerId: x.created_by === me.id ? undefined : me.id,
      limit,
    })
    return c.json({ sessions: sessions.map(sessionJson) })
  })

  // One session with its transcript — the asker's and the context owner's view.
  app.get("/v1/sessions/:id", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const s = await meta.getSession(c.req.param("id"))
    const linked = s ? await contextOf(s) : null
    if (!s || !linked || (s.asker_id !== me.id && linked.context.created_by !== me.id))
      return fail(c, 404, "not found")
    const messages = await meta.listSessionMessages(s.id)
    return c.json({
      session: sessionJson(s),
      context: { id: linked.context.id, name: linked.context.name },
      messages: messages.map(messageJson),
    })
  })

  // Append a turn. The asker's message re-opens the session (back on the queue);
  // the context's agent settles it (answered, or escalated when its draft went to
  // review, or failed when the run crashed).
  app.post("/v1/sessions/:id/messages", async (c) => {
    const s = await meta.getSession(c.req.param("id"))
    const linked = s ? await contextOf(s) : null
    if (!s || !linked) return fail(c, 404, "not found")
    // Authorization decides before state does: a caller with no standing gets the
    // same 404 whether the session is open or closed — 409 would leak its state.
    const closed = (): Response | null =>
      s.state === "closed" ? fail(c, 409, "session is closed") : null

    const agent = await agentFor(c)
    if (agent) {
      if (agent.id !== linked.context.agent_id) return fail(c, 404, "not found")
      const gone = closed()
      if (gone) return gone
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
      if (b instanceof Response) return b
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
    if (!me) return fail(c, 401, "unauthenticated")
    if (s.asker_id !== me.id) return fail(c, 404, "not found")
    const gone = closed()
    if (gone) return gone
    const b = await readJson(c, z.object({ body_md: z.string().trim().min(1).max(20_000) }))
    if (b instanceof Response) return b
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
  })

  // Close (asker or owner) / fail without a message (the runner's crash path).
  app.patch("/v1/sessions/:id", async (c) => {
    const s = await meta.getSession(c.req.param("id"))
    const linked = s ? await contextOf(s) : null
    if (!s || !linked) return fail(c, 404, "not found")

    const agent = await agentFor(c)
    if (agent) {
      if (agent.id !== linked.context.agent_id) return fail(c, 404, "not found")
      // The asker may close mid-run; the run's eventual failure must not reopen
      // a conversation they deliberately ended.
      if (s.state === "closed") return fail(c, 409, "session is closed")
      const b = await readJson(c, z.object({ state: z.literal("failed") }))
      if (b instanceof Response) return b
      const updated = await meta.setSessionState(s.id, b.state)
      return updated ? c.json({ session: sessionJson(updated) }) : fail(c, 404, "not found")
    }

    const me = await currentUser(c)
    if (!me) return fail(c, 401, "unauthenticated")
    if (s.asker_id !== me.id && linked.context.created_by !== me.id)
      return fail(c, 404, "not found")
    const b = await readJson(c, z.object({ state: z.literal("closed") }))
    if (b instanceof Response) return b
    const updated = await meta.setSessionState(s.id, b.state)
    return updated ? c.json({ session: sessionJson(updated) }) : fail(c, 404, "not found")
  })

  // The runner's queue: open sessions, oldest first, transcripts embedded so one
  // poll is one round-trip. Auth = the context's own agent bearer (the inbox model).
  app.get("/v1/contexts/:id/queue", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    const x = await meta.getContext(c.req.param("id"))
    if (!x || x.agent_id !== agent.id) return fail(c, 404, "not found")
    const limit = Math.min(20, Math.max(1, Number(c.req.query("limit")) || 10))
    const sessions = await meta.pendingSessions(x.id, limit)
    const out = await Promise.all(
      sessions.map(async (s) => ({
        ...sessionJson(s),
        messages: (await meta.listSessionMessages(s.id)).map(messageJson),
      })),
    )
    return c.json({ sessions: out })
  })

  return app
}
