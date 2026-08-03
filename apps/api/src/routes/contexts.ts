import { randomUUID } from "node:crypto"
import { refRouter } from "@derive/broker"
import {
  type ContextAskerRecord,
  type ContextRecord,
  effectiveRole,
  newId,
  normalizeSelector,
  parseSubject,
  roleAllows,
  type SessionMessageRecord,
  type SessionRecord,
  type SessionState,
  SKILL_CONTENT_TYPE,
  type UserDir,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { isAbandoned } from "../lib/abandoned-turn"
import { resolveActorBrandprint } from "../lib/brandprint"
import {
  brokerFor,
  callTool,
  connectionBindError,
  mcpAuthFor,
  parseConnectionIds,
  spendableConnections,
  toolsForRun,
} from "../lib/broker"
import { overBudget } from "../lib/budget"
import { chatArrival } from "../lib/chat-gate"
import { ASK_CHAT_TOOLS, buildChatTools, RAIL_CHAT_TOOLS } from "../lib/chat-tools"
import { runChatTurn } from "../lib/chat-turn"
import { previewOf } from "../lib/comments"
import { sha256 } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"
import { canPayForAgent, NO_PAYER_MESSAGE } from "../lib/payer"
import { RUN_LEASE_MS } from "../lib/run-lifecycle"
import { type DeltaStream, makeDeltaStream } from "../lib/session-stream"
import { runSessionTurn } from "../lib/session-turn"
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
    agentRunScope,
    agentSessionScope,
    authorize,
    bus,
    askLimiter,
    canAskContext,
    currentUser,
    deps,
    limited,
    managementPrincipal,
    requireUser,
    requireWorkspace,
    sourceText,
    workspaceCan,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  /** A run-scoped capability token, which must not reach the session lane.
   *
   *  The ownership checks below cannot stand in for this: a context-bound automation runs AS the
   *  context's agent, so `context.agent_id === agent.id` holds for a run token aimed at any
   *  session of that context. Mirrors `isSessionBearer` in routes/automations.ts; see
   *  routes/model-credentials.ts for the same rule stated once more — belonging to the same
   *  agent is not enough. Covered by test/work-token-lanes.test.ts. */
  const isRunBearer = (c: Context): boolean => agentRunScope(c) !== null
  const NOT_THIS_LANE = "a run token cannot act on a session"

  /** How many past conversations the history picker offers. A picker, not an archive: far
   *  enough back to find last week's thread, short enough to stay one batched read. */
  const CHAT_HISTORY_PAGE = 50

  /**
   * WHICH MODEL this conversation was last answered with, read off the transcript.
   *
   * A model choice is per-conversation state, and this is where that state already lives: every
   * agent message records the model that produced it, because a transcript that cannot say what
   * wrote it is not a record. Reading the choice back from the same place means no column, no
   * migration, and no way for the stored answer and the stored choice to disagree.
   *
   * Null when nothing has answered yet, or the messages predate the field.
   */
  const lastModelId = (transcript: SessionMessageRecord[]): string | null => {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const m = transcript[i]
      if (!m || m.author_kind !== "agent" || !m.meta) continue
      try {
        const id = (JSON.parse(m.meta) as { model?: { id?: unknown } }).model?.id
        if (typeof id === "string" && id) return id
      } catch {
        /* a hand-edited row must not break the next turn */
      }
    }
    return null
  }

  /** Is this workspace allowed to spend the operator's model key? See DERIVE_CHAT_ALLOWLIST. */
  const chatAllowed = (orgId: string): boolean =>
    !ctx.callModel || !ctx.chatAllowlist?.length || ctx.chatAllowlist.includes(orgId)

  /**
   * EVERY RUNG A CHAT ARRIVAL WALKS, in one place.
   *
   * Chat is the lane a person can drive by hand as fast as they can type, on a key the operator
   * pays for, so it is guarded five times over: the workspace opted in, this deploy lets that
   * workspace opt in, the asker is a MEMBER (not merely someone holding a link), they are within
   * their request rate, and the workspace is within its monthly budget. Each was already
   * enforced somewhere; collecting them is what stops the next arrival — a comment mention, a
   * Slack mention — from quietly inheriting four of the five.
   *
   * Returns a Response to bail with, or null to proceed. Ordered cheapest-first, and membership
   * before the two ceilings so a stranger can never learn a workspace's rate-limit state.
   */
  /**
   * The HTTP lane's rendering of the shared arrival (lib/chat-gate.ts): the same five rungs
   * every surface walks, mapped to status codes.
   *
   * The rate limit stays HERE rather than inside the shared gate because this lane has a Hono
   * context, so `limited` keys on the resolved actor and answers with the standard 429 + Retry
   * headers — machinery a webhook lane has no equivalent of. Everything a lane cannot do
   * differently is shared; this is the part that genuinely differs.
   *
   * 404 rather than 403 on membership: whether a workspace exists is not something a
   * non-member gets to learn from a status code.
   */
  const chatGates = async (c: Context, orgId: string, userId: string): Promise<Response | null> => {
    const rl = await limited(c, askLimiter)
    if (rl) return rl
    const gate = await chatArrival(
      { meta, models: ctx.models, chatAllowlist: ctx.callModel ? ctx.chatAllowlist : [] },
      { org: orgId, userId },
    )
    if (gate.ok) return null
    return gate.reason === "not_member"
      ? fail(c, 404, "not found")
      : gate.reason === "over_budget"
        ? fail(c, 429, "monthly model budget reached")
        : gate.reason === "no_model"
          ? fail(c, 503, "no model is configured on this deploy")
          : fail(c, 404, "chat is not enabled for this workspace")
  }

  /**
   * One WORKSPACE chat turn: the model, this workspace's tools, and the transcript.
   *
   * The tools are Derive's own MCP tools, constructed for the ASKER (see lib/chat-tools.ts), so
   * everything this turn can reach is what that person could reach by hand. The turn itself is
   * turn-core's, exactly like every other lane.
   */
  const serveWorkspaceChat = async (
    s: SessionRecord,
    me: { id: string; name?: string | null; username?: string | null; email?: string },
    reply: (body: string, state: SessionState, payload?: unknown) => Promise<void>,
    stream: DeltaStream,
    askedModelId: string | null,
    /** Where the question was typed. "ask" (the palette) drops the writer for this turn; it can
     *  only ever narrow, so a caller that says nothing gets what it always got. */
    surface?: "ask",
  ) => {
    // The seat is re-read PER TURN, never trusted from session creation: someone removed from
    // the workspace still holds the session id, and their tools would otherwise keep working.
    const seat = await meta.getMembership(s.org_id, me.id).catch(() => null)
    if (!seat) {
      await reply(
        "You are no longer a member of this workspace, so I cannot answer here.",
        "failed",
      )
      return
    }
    const transcript = await meta.listSessionMessages(s.id)
    // WHICH MODEL. What the person asked for on this turn, else the one this conversation was
    // already using (read off the last agent message, so the choice sticks without a column),
    // else the deploy's default.
    const previous = lastModelId(transcript)
    const model = ctx.models?.resolve(askedModelId ?? previous ?? null)
    if (!model) {
      // A named model that is gone is worth saying out loud: silently answering with a different
      // one is a lie about which model produced the text.
      const named = askedModelId ?? previous
      await reply(
        named
          ? `The model "${named}" is not available on this deploy any more. Pick another and ask again.`
          : "No model is configured on this deploy, so I cannot answer.",
        "failed",
      )
      return
    }
    const ws = await meta.getWorkspace(s.org_id).catch(() => null)
    const settings = await meta.getOrgSettings(s.org_id).catch(() => null)
    const tools = buildChatTools(
      ctx,
      {
        org: s.org_id,
        user: { id: me.id, name: me.name ?? me.username ?? null },
        seatRole: seat.role,
        // Read fresh for THIS turn: an operator who flips the killswitch mid-conversation stops
        // the next write, not merely the next session.
        flags: { agentKillswitch: settings?.agentKillswitch ?? false },
      },
      surface === "ask" ? ASK_CHAT_TOOLS : undefined,
    )
    const res = await runChatTurn(
      { model: { ...model, callModel: stream.wrap(model.callModel) } },
      {
        session: s,
        transcript,
        tools,
        workspaceName: ws?.name ?? "this workspace",
        asker: { name: me.name ?? me.username ?? null, role: seat.role },
        skills: tools.skills,
      },
    )
    await reply(res.reply, res.outcome === "failed" ? "failed" : "answered", {
      outcome: res.outcome,
      cost_micro_usd: res.costMicroUsd,
      model: res.model,
      tools: res.tools,
    })
  }

  /**
   * Serve one attended turn for a session that names an artifact subject.
   *
   * Claims the session first (the same status-guarded lease a runner would take), so a polling
   * BYO runner for the same context cannot double-serve the turn. Everything after that is
   * best-effort: this runs detached, and a failure has to land in the TRANSCRIPT rather than
   * anywhere the caller could see, because the caller has already been answered.
   */
  const serveAttended = async (
    s: SessionRecord,
    me: { id: string; name?: string | null; username?: string | null; email?: string },
    /** The context's agent, or NULL for a contextless (default-agent) chat session. */
    agentId: string | null,
    /** What the caller asked for on THIS turn. `modelId` is the person's model pick; absent
     *  means "whatever this conversation was already using", then the deploy's default.
     *
     *  `surface` narrows the tools, and ONLY ever narrows them: the palette says "ask" and loses
     *  the writer (ASK_CHAT_TOOLS). It rides the request rather than the session because it is a
     *  property of where the question was typed, not of the conversation — the same transcript
     *  opened on /chat writes, which is what its Open-in-chat link is for. A caller that omits it
     *  gets exactly what it got before, so this can add capability to nobody. */
    opts?: { modelId?: string | null; surface?: "ask" },
  ) => {
    const subject = parseSubject(s.subject_ref)
    // WHAT THIS LANE WILL SERVE, and what it must leave alone.
    //
    // A subject that is not an artifact belongs to the automation lane (a collection or tag
    // selector), so it is not ours. NO subject is two different things depending on the context:
    // with one, it is the ORIGINAL ask lane — a packaged agent's own runner answers it, and
    // serving it here would answer on the runner's behalf and settle a session it was about to
    // claim. Without one, it is the workspace chat, which is ours.
    if (subject && subject.kind !== "artifact") return
    if (!subject && s.context_id) return
    // Slices of the answer as the model writes it, coalesced so a reply costs tens of publishes
    // rather than one per token. Ephemeral by construction — `reply()` below still writes the
    // whole transcript row, which stays the record.
    const stream = makeDeltaStream({
      publish: ({ seq, text, attempt }) => {
        const channel = `u:${s.asker_id}`
        const event = { type: "session.delta" as const, session_id: s.id, seq, text, attempt }
        // Prefer the receipt-bearing publish: its delivery count is what lets the stream switch
        // itself off when no tab is open, which is most turns (an MCP ask, an API caller, a
        // closed page). Falls back to a plain publish on a backplane that cannot count.
        return bus.publishWithReceipt
          ? bus.publishWithReceipt(channel, event)
          : bus.publish(channel, event)
      },
    })
    const reply = async (body: string, state: SessionState, payload?: unknown) => {
      // Push the tail before the terminal event, so a client can never receive "settled" while
      // a slice is still buffered and end up rendering a truncated answer mid-animation.
      stream.flush()
      await meta.addSessionMessage(
        {
          id: newId("sm"),
          session_id: s.id,
          author_kind: "agent",
          author_id: agentId ?? "derive",
          body_md: body,
          meta: payload === undefined ? null : JSON.stringify(payload),
        },
        state,
      )
      // WAKE THE ASKER. An attended turn used to settle silently — it is served in-process, so
      // nothing went through the runner report path that publishes this, and a watching client
      // learned the answer had landed only on its next poll. Streaming makes this mandatory
      // rather than merely nice: deltas with no terminal event leave a reader watching a reply
      // that never officially finishes.
      if (state !== "open") settleWake(s, state)
    }
    const flags = await meta.getOrgSettings(s.org_id).catch(() => null)
    // No model wired (the common self-host case) — say so in the transcript rather than leaving
    // the session `open` forever waiting on a runner that will never come.
    if (!ctx.callModel) {
      await reply(
        "No model is configured on this deploy, so I cannot answer. Set DERIVE_MODEL_BASE_URL, DERIVE_MODEL_API_KEY and DERIVE_MODEL_NAME.",
        "failed",
      )
      return
    }
    // Claim AS THE CONTEXT'S AGENT, using the same status-guarded claim a polling runner takes.
    // That is what stops a BYO runner for this context from serving the same turn twice — and it
    // has to be that agent's id, because the claim checks ownership through the context.
    // CLAIM EITHER WAY. The earlier reasoning — "no runner competes, so nothing to exclude" —
    // missed that the claim is also the mutual exclusion between two CALLERS (two tabs, or a
    // retry after a client-side timeout), and the only thing that writes a lease a crashed
    // turn can recover from. Without it, both callers ran a turn and both wrote; and a process
    // that died mid-turn left the session `open` forever, which the UI polls on indefinitely.
    const lease = new Date(Date.now() + RUN_LEASE_MS).toISOString()
    const claimed = agentId
      ? await meta.claimSessionById(s.id, agentId, lease)
      : await meta.claimAttendedSession(s.id, lease)
    if (!claimed) return // someone else is already serving this turn
    try {
      // THE WORKSPACE CHAT: no document, so the ground is the workspace and the work happens
      // through tools. Everything above this point — the claim, the delta stream, the reply
      // writer, the settle wake — is shared with the document lane and deliberately not
      // duplicated; what differs is only what the turn is given and what it may do.
      if (!subject) {
        await serveWorkspaceChat(s, me, reply, stream, opts?.modelId ?? null, opts?.surface)
        return
      }
      const artifact = await meta.getByShortId(subject.id)
      if (!artifact) {
        await reply("That document no longer exists, so I have not changed anything.", "failed")
        return
      }
      // RE-CHECK ACCESS EVERY TURN, never just at session creation. A session id is long-lived
      // and the ACL is not: someone removed from the workspace, demoted to viewer, or unshared
      // from the doc still holds the id, and without this they would keep reading the CURRENT
      // contents back and keep publishing to it. `canRead`/`canWrite` are resolved for the
      // asker, not for whoever opened the session.
      const seat = await meta.getMembership(artifact.org_id, me.id)
      const role = effectiveRole(
        {
          kind: "user",
          orgRole: seat?.role,
          artifactRole: (await meta.getArtifactMember(artifact.id, me.id))?.role,
        },
        artifact.workspace_access,
        artifact.link_role,
      )
      if (!role || !roleAllows(role, "read")) {
        await reply("You no longer have access to that document.", "failed")
        return
      }
      // MEMBERSHIP, on top of read-access, for a CHAT session (one with no context behind it).
      // `effectiveRole` folds in `artifact.link_role`, so a viewer LINK is enough to satisfy the
      // read check above — which meant a signed-in non-member who was sent a link to a document
      // in a chat-enabled workspace could hold a live session and spend the OPERATOR's model key,
      // turn after turn, from outside the workspace entirely. Reading a shared document is not
      // standing to run an agent inside the workspace that owns it.
      //
      // Chat only: the context lane has its own gate (canAskContext, which already requires
      // membership or a roster invite), and its sessions are not on the operator's key by
      // default. Refused in the TRANSCRIPT rather than at the door, like every other per-turn
      // access refusal here — the asker sees why instead of a silent session.
      if (!s.context_id && !seat) {
        await reply(
          "You are not a member of the workspace that owns this document, so I cannot answer here.",
          "failed",
        )
        return
      }
      // WRITING needs propose at minimum. `read` alone is not enough: the turn's proposal path
      // calls the store directly rather than going through /v1/artifacts/:id/proposals, so the
      // route's `propose` check does not apply here and has to be made explicitly. Without it,
      // any signed-in user could file unlimited proposals onto any PUBLIC artifact in a
      // chat-enabled workspace, at the operator's model cost.
      if (!roleAllows(role, "propose")) {
        await reply(
          "You can read this document but not suggest changes to it, so I have not written anything.",
          "failed",
        )
        return
      }
      // GitHub-synced artifacts are read-only in Derive, exactly as the proposal route says —
      // changes belong in the repo, and chat must not be a way around that.
      if (await meta.isManagedArtifact(artifact.org_id, artifact.id)) {
        await reply(
          "This document is managed by GitHub sync, so changes belong in the repo rather than here.",
          "failed",
        )
        return
      }
      // The write mode is re-derived too — a demoted editor must fall back to proposing rather
      // than keep the `publish` they held when the session opened.
      const effective: typeof subject =
        subject.mode === "publish" && roleAllows(role, "publish")
          ? subject
          : { kind: "artifact", id: subject.id }
      const res = await runSessionTurn(
        {
          meta,
          blobs: ctx.blobs,
          bus,
          notify: ctx.notify,
          notifyRender: ctx.notifyRender,
          background: ctx.background,
          search: ctx.search,
          // Wrapped, not re-plumbed: runSessionTurn → runTurn → the agent loop all keep passing
          // `callModel` along exactly as before, and the streaming decision stays here, where
          // the transport (this asker's channel) is actually known.
          callModel: stream.wrap(ctx.callModel),
          billingBlocked: ctx.billingBlocked,
        },
        {
          session: s,
          subject: effective,
          artifact,
          transcript: await meta.listSessionMessages(s.id),
          // READ-ONLY reach for the document rail: the conversation can look something up in
          // the workspace, and the DOCUMENT's own write stays on the landing port below. The
          // subset is enforced by not registering the rest (see chat-tools), so this is a
          // narrower surface than the workspace chat rather than the same one with a guard.
          ...(() => {
            const t = seat
              ? buildChatTools(
                  ctx,
                  {
                    org: artifact.org_id,
                    user: { id: me.id, name: me.name ?? me.username ?? null },
                    seatRole: seat.role,
                  },
                  RAIL_CHAT_TOOLS,
                )
              : null
            return t ? { tools: t, skills: t.skills } : {}
          })(),
          // REAL workspace flags, not hardcoded ones. Hardcoding these made chat ignore the
          // killswitch entirely and granted the `auto` opt-in that a workspace has to enable
          // deliberately (it defaults OFF) — so an operator who flipped the killswitch after a
          // bad run would have found chat still live-publishing.
          flags: {
            agentKillswitch: flags?.agentKillswitch ?? false,
            agentAutoEnabled: flags?.agentAutoEnabled ?? false,
          },
          onBehalf: { id: me.id, name: me.name ?? me.username ?? me.email ?? "someone" },
        },
      )
      // METERING. The turn computes its spend and this used to throw it away, so attended chat
      // — the lane on the operator's key — left no trace anywhere. Recorded on the agent message
      // so a turn is auditable next to what it produced, without a new table. `cost_micro_usd`
      // is null when the provider does not report cost (which is every provider today, by
      // design — see costOf); the OUTCOME and turn count are still worth having on their own.
      await reply(res.reply, res.outcome === "failed" ? "failed" : "answered", {
        outcome: res.outcome,
        wrote: res.wrote,
        cost_micro_usd: res.costMicroUsd,
      })
    } catch (e) {
      log.error("attended turn failed", {
        session: s.id,
        error: e instanceof Error ? e.message : String(e),
      })
      await reply("Something went wrong on my side. Nothing has been changed.", "failed")
    }
  }

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
      connection_ids: z
        .array(z.string())
        .describe("Connections this context may use — its tools, in every lane it runs in."),
    })
    .openapi("ContextInfo")

  // The resolved Brandprint handed to the context's runner (agent branch of GET only).
  // The runner materializes skill members into its skills dir and reads notes + theme;
  // it is the runner's ONLY window into workspace conventions — a context has no other
  // config channel. Members are the workspace + owner-profile collection artifacts, deduped.
  const BrandprintConfig = z
    .object({
      profile_short_id: z
        .string()
        .nullable()
        .describe(
          "The workspace brand-profile artifact (an HTML page carrying theme tokens), when set; null otherwise. Not in `members` — it is the headline read, not a note.",
        ),
      members: z
        .array(
          z.object({
            short_id: z.string(),
            title: z.string().nullable(),
            version: z
              .number()
              .describe("The member's current version at fetch time (provenance)."),
            is_skill: z
              .boolean()
              .describe("A skill bundle (materialize into skills/) vs a prose note."),
          }),
        )
        .describe(
          "Convention artifacts: skills to materialize, notes to read. Excludes the profile.",
        ),
    })
    .openapi("BrandprintConfig")

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
      tools: z
        .array(z.string())
        .optional()
        .describe(
          "Which tools the turn actually ran, in order of first use. Names only: arguments can carry the contents of a private document, and this is persisted on the message. This is what lets a surface show HOW an answer was reached rather than only asserting that it searched.",
        ),
      model: z
        .object({ id: z.string(), label: z.string() })
        .optional()
        .describe(
          "Which model produced this answer. Recorded per message rather than per session because the choice is per turn — a conversation can be continued on a different model, and the answers it already gave must keep saying which model wrote them.",
        ),
      outcome: z
        .string()
        .optional()
        .describe("How the turn ended: answered, published, proposed, or failed."),
      cost_micro_usd: z
        .number()
        .nullable()
        .optional()
        .describe("Reported spend for the turn in millionths of a USD; null when unreported."),
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
      context_id: z
        .string()
        .nullable()
        .describe("The packaged agent answering, or null when the default agent is."),
      asker_id: z.string(),
      context_version: z
        .number()
        .nullable()
        .describe("The manifest version this session opened against; null with no context."),
      state: z
        .enum(["open", "working", "answered", "escalated", "failed", "closed"])
        .describe(
          "open = awaiting the agent; working = a runner claimed it and is answering; answered; escalated = draft went to review; failed = run crashed; closed = ended by asker/owner.",
        ),
      created_at: z.string(),
      updated_at: z
        .string()
        .describe("Last state/message change; equals created_at when never updated."),
      subject: z
        .object({
          kind: z.literal("artifact"),
          id: z.string(),
          mode: z.enum(["publish", "propose"]).optional(),
        })
        .nullable()
        .describe(
          "What this session is about, when it names one: an artifact, plus how a write to it lands. Null for a plain ask.",
        ),
    })
    .openapi("Session")

  // The context's tools, resolved exactly as the run lane resolves an automation's, so a
  // context reaches the same things however it was triggered. The broker rides along
  // because the proxy needs it to execute a non-direct tool; nothing bound means no
  // broker is built at all.
  // `credentialed` rides along because it is a DIFFERENT question from "what tools": a
  // connection with no base_url yields no tools yet is still a credential this context may
  // spend, so the write gate must count spendable connections (see spendableConnections).
  const contextTools = async (x: ContextRecord) => {
    const ids = parseConnectionIds(x.connection_ids)
    if (ids.length === 0) return { broker: null, route: null, tools: [], credentialed: false }
    const broker = await brokerFor(meta, x.org_id, null, deps.encryptionKey, deps.allowEchoStub)
    // The router rides along with the broker for the same reason the broker does: the proxy has
    // to EXECUTE through whatever listed the tool, or an `mcp:` tool would be listed by the MCP
    // broker and run by the plan's. It also carries the per-ref bearer.
    const route = refRouter(broker, mcpAuthFor(meta, x.org_id, deps.encryptionKey))
    const spendable = await spendableConnections(meta, x.org_id, ids)
    return {
      broker,
      route,
      tools: await toolsForRun(meta, broker, x.org_id, ids, route, deps.encryptionKey),
      credentialed: spendable.length > 0,
    }
  }

  const contextJson = (x: ContextRecord, manifestShortId: string | null) => ({
    id: x.id,
    name: x.name,
    agent_id: x.agent_id,
    manifest_short_id: manifestShortId,
    created_by: x.created_by,
    created_at: x.created_at,
    runner_seen_at: x.runner_seen_at,
    ask_policy: x.ask_policy,
    connection_ids: parseConnectionIds(x.connection_ids),
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
    subject: parseSubject(s.subject_ref) as {
      kind: "artifact"
      id: string
      mode?: "publish" | "propose"
    } | null,
  })

  // Any terminal turn — the runner's answer, a crash-fail, a close — pings the
  // asker's channel so an MCP ask({wait}) long-poll re-reads now instead of at
  // its timeout. A wake signal only; waiters always re-read the session.
  /**
   * A TURN THAT NEVER CAME BACK.
   *
   * An attended turn runs DETACHED (ctx.background → waitUntil on a Worker), so if the isolate
   * dies mid-turn there is nobody left to settle the session. It stays "working" for ever: no
   * answer, no error, no retry, and a surface that shows a spinner until the person gives up.
   * That happened on a preview and the cause was never reproduced — which is the point. A lane
   * where the failure mode is SILENCE cannot rely on having diagnosed every cause, because the
   * one it has not diagnosed looks exactly like a slow answer.
   *
   * Reaped on READ rather than by a scheduler, because the surface already polls this endpoint
   * while it waits: the check runs precisely when somebody is waiting, costs nothing when nobody
   * is, and needs no cron on a runtime that has no always-on process.
   *
   * The deadline is generous on purpose. The model call alone is capped at 120s and a turn may
   * make several plus tool time, so this is not a latency budget — it is the line past which a
   * turn is not slow, it is gone.
   */
  const reapIfAbandoned = async (s: SessionRecord): Promise<SessionRecord> => {
    if (!isAbandoned(s.state, s.updated_at ?? s.created_at, Date.now())) return s
    // Says so IN THE TRANSCRIPT, not just in the state. Somebody who comes back to this
    // conversation needs to know their question was dropped rather than answered badly.
    await meta
      .addSessionMessage(
        {
          id: newId("sm"),
          session_id: s.id,
          author_kind: "agent",
          author_id: "derive",
          body_md:
            "This turn stopped before it finished, so I never got you an answer. Nothing was changed. Please ask again.",
          meta: JSON.stringify({ outcome: "failed" }),
        },
        "failed",
      )
      .catch(() => {})
    const updated = await meta.getSession(s.id).catch(() => null)
    return updated ?? s
  }

  const settleWake = (s: SessionRecord, state: SessionState) =>
    bus.publish(`u:${s.asker_id}`, { type: "session.settled", session_id: s.id, state })

  // A NON-settling progress tick from a long-running (Maker) runner: the session
  // stays `working`, but the asker's use({wait}) long-poll should return the tick
  // now instead of blocking to timeout. A wake only; the waiter re-reads the
  // transcript. Distinct from settleWake so an open loop keeps waiting after a
  // progress tick but returns on the terminal settle.
  const progressWake = (s: SessionRecord) =>
    bus.publish(`u:${s.asker_id}`, { type: "session.progress", session_id: s.id })

  // A runnable session's lease: how long a claim holds it `working` before it is
  // re-served (the runner crashed / the box rebooted). Derived from the context's
  // max_run_ms (a Maker job gets hours; the default matches the runner's own
  // ~10-min budget), clamped so a bad value can't wedge or thrash the queue.
  //
  // Reclaim is at-least-once, not fenced: if a lease lapses and the session is re-served
  // while the original runner is in fact still alive, that runner's late answer still lands
  // (it authenticates as the same context agent). So a run can execute more than once and a
  // later answer wins — runners must be idempotent. A generation token on the claim would
  // make it exactly-once; deferred as the margin above makes a live run outlive its lease.
  const DEFAULT_RUN_MS = 600_000
  const MIN_LEASE_MS = 30_000
  const MAX_LEASE_MS = 6 * 60 * 60_000
  // The lease must OUTLIVE the run budget it is derived from: a run that never ticks (no
  // progress renewal) and finishes right at its budget would otherwise land on an
  // already-expired lease and be re-served — a double-run. The margin covers that final
  // answer write plus clock skew between the runner and the API box.
  const LEASE_MARGIN_MS = 60_000
  const leaseFor = (x: ContextRecord): string => {
    const ms = Math.min(Math.max(x.max_run_ms ?? DEFAULT_RUN_MS, MIN_LEASE_MS), MAX_LEASE_MS)
    return new Date(Date.now() + ms + LEASE_MARGIN_MS).toISOString()
  }

  /** A session's context + manifest, or null when either half is gone. */
  const contextOf = async (s: SessionRecord) => {
    // Contextless (default-agent) sessions resolve to null here, which every caller already
    // treats as "not found" — the fail-closed default for every agent-facing lane.
    if (!s.context_id) return null
    const x = await meta.getContext(s.context_id)
    if (!x) return null
    const manifest = await meta.getArtifactById(x.manifest_artifact_id)
    return manifest ? { context: x, manifest } : null
  }

  // Resolve the context's Brandprint: the workspace conventions merged with the
  // context CREATOR's personal ones (profile wins) — the same resolution mcp.ts does
  // for a connected agent, but keyed to the runner owner (created_by) rather than a
  // live session user. Returns undefined when no Brandprint is set, so the field is
  // simply omitted. A member the runner can't read still appears (it discovers the
  // 404 at materialize time and reports it, mirroring a failed repo clone).
  const resolveContextBrandprint = async (x: ContextRecord) => {
    const resolved = await resolveActorBrandprint(meta, x.org_id, x.created_by)
    if (resolved.collectionIds.length === 0) return undefined
    const seen = new Set<string>()
    const members: {
      short_id: string
      title: string | null
      version: number
      is_skill: boolean
    }[] = []
    for (const collectionId of resolved.collectionIds) {
      const ids = await meta.collectionArtifactIds(collectionId)
      for (const a of ids.length ? await meta.listArtifacts({ ids }) : []) {
        if (seen.has(a.short_id)) continue
        seen.add(a.short_id)
        // The brand profile rides in the collection but is not a note to materialize —
        // it's the headline read, surfaced separately (mirrors mcp.ts's bpSources filter).
        if (a.short_id === resolved.profileId) continue
        members.push({
          short_id: a.short_id,
          title: a.title,
          version: a.current_version,
          is_skill: a.current_content_type === SKILL_CONTENT_TYPE,
        })
      }
    }
    return { profile_short_id: resolved.profileId ?? null, members }
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
      summary: "Create a context (wire an agent to a manifest artifact, or auto-mint one).",
      responses: {
        201: {
          description:
            "The created context. When no agent_id was given, agent_token carries the auto-minted agent's bearer — shown only here.",
          content: {
            "application/json": {
              schema: ContextInfo.extend({ agent_token: z.string().optional() }),
            },
          },
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
          // Omit to auto-mint a MANAGED agent for this context — the context's own
          // Derive access, no roster persona, nothing to pick. Pass an id to run as
          // an existing (service) agent instead.
          agent_id: z.string().optional(),
          manifest_short_id: z.string(),
          // Same knobs (and bounds) as the MCP create_context action: per-run
          // budget and runner parallelism. Omitted → the store defaults.
          max_run_ms: z
            .number()
            .int()
            .min(30_000)
            .max(6 * 60 * 60_000)
            .optional(),
          max_concurrency: z.number().int().min(1).max(10).optional(),
          // Same bind policy as an automation's: a workspace connection needs manage,
          // a personal one only its owner.
          connection_ids: z.array(z.string().max(64)).max(20).optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      if (b.agent_id) {
        const agents = await meta.listAgents(org)
        if (!agents.some((a) => a.id === b.agent_id)) return bail(fail(c, 404, "no such agent"))
      }
      if (b.connection_ids?.length) {
        const bindErr = await connectionBindError(
          meta,
          org,
          { userId: owner, canManage: await workspaceCan(c, "manage") },
          b.connection_ids,
        )
        if (bindErr) return bail(fail(c, 400, bindErr))
      }
      const manifest = await meta.getByShortId(b.manifest_short_id)
      if (!manifest || manifest.org_id !== org || !(await authorize(c, "share", manifest)))
        return bail(fail(c, 404, "no such artifact"))
      // Auto-mint under the context-create gate (publish), deliberately below the
      // roster's manage gate: the minted agent is managed:1, caps at editor, and
      // acts on behalf of the CREATOR (created_by = owner) — the derived-cap rule
      // (min of registrant standing and agent role) means it can never exceed what
      // the creator already holds, so no privilege is conferred that `publish`
      // didn't already carry. This is what kills the "pick an agent" step.
      let agentId = b.agent_id ?? null
      let agentToken: string | null = null
      if (!agentId) {
        agentToken = `dk_agt_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`
        const mint = (name: string) =>
          meta.createAgent({
            id: newId("ag"),
            org_id: org,
            name,
            token: sha256(agentToken as string),
            role: "editor",
            created_by: owner,
            managed: 1,
          })
        // Agent names are unique per workspace; a context named like an existing
        // agent ("Analytics") must not 409 the whole create — suffix and move on.
        const minted = await mint(b.name).catch(() => mint(`${b.name} ${randomUUID().slice(0, 4)}`))
        agentId = minted.id
      }
      try {
        const created = await meta.createContext({
          id: newId("ctx"),
          org_id: org,
          name: b.name,
          agent_id: agentId,
          manifest_artifact_id: manifest.id,
          created_by: owner,
          max_run_ms: b.max_run_ms ?? null,
          ...(b.max_concurrency ? { max_concurrency: b.max_concurrency } : {}),
          connection_ids: b.connection_ids?.length ? JSON.stringify(b.connection_ids) : null,
        })
        return c.json(
          {
            ...contextJson(created, manifest.short_id),
            ...(agentToken ? { agent_token: agentToken } : {}),
          },
          201,
        )
      } catch {
        // A name-collision 409 after an auto-mint must not strand an orphaned
        // managed agent (and its live token) — unwind the mint with the create.
        if (agentToken && agentId) await meta.deleteAgent(agentId, org).catch(() => {})
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
      // Contexts with each one's manifest artifact already resolved to its short_id —
      // one round trip. Resolving the manifests was a second query keyed on the ids the
      // first returned, so it could not be batched by key; the store answers it with a
      // LEFT JOIN instead (see contextsWithManifests).
      const rows = await meta.contextsWithManifests(org)
      const contexts = rows.map((x) => contextJson(x, x.manifest_short_id))
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
                brandprint: BrandprintConfig.optional(),
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
      // source, so a manifest edit reconfigures the runner with no deploy. The resolved
      // Brandprint rides along here too — the runner's only window into workspace
      // conventions (a context has no other config channel).
      if (agent && manifest) {
        const v = await meta.getVersion(manifest.id, manifest.current_version)
        return c.json({
          ...contextJson(x, manifest.short_id),
          manifest_version: manifest.current_version,
          manifest_md: v ? await sourceText(v) : null,
          brandprint: await resolveContextBrandprint(x),
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
      method: "post",
      path: "/v1/contexts/{id}/connections",
      tags: ["Contexts"],
      summary: "Set the connections this context may use (whole-list replace).",
      request: {
        params: z.object({ id: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({ connection_ids: z.array(z.string().max(64)).max(20) }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "The context's connections after the change.",
          content: {
            "application/json": { schema: z.object({ connection_ids: z.array(z.string()) }) },
          },
        },
      },
    }),
    async (c) => {
      const x = await manageableContext(c)
      if (x instanceof Response) return bail(x)
      const b = await readJson(c, z.object({ connection_ids: z.array(z.string().max(64)).max(20) }))
      if (b instanceof Response) return bail(b)
      // Re-checked on every set, not just at create: a personal connection may have
      // changed hands or a manager may have lost the seat since the last edit.
      const bindErr = await connectionBindError(
        meta,
        x.org_id,
        {
          userId: await managementPrincipal(c),
          canManage: await workspaceCan(c, "manage"),
        },
        b.connection_ids,
      )
      if (bindErr) return bail(fail(c, 400, bindErr))
      await meta.setContextConnections(
        x.id,
        b.connection_ids.length ? JSON.stringify(b.connection_ids) : null,
      )
      return c.json({ connection_ids: b.connection_ids })
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
      const b = await readJson(
        c,
        z.object({
          body_md: z.string().trim().min(1).max(20_000),
          // Idempotency: a second ask with the same key while one is still in flight
          // (open/working) JOINS the existing session instead of opening a new one —
          // so a double "run for brand X" never runs twice. The partial unique index
          // on (context_id, dedupe_key) is the race backstop; this is the fast join.
          dedupe_key: z.string().trim().min(1).max(200).optional(),
          // WHAT this session is about. Accepts the same shapes automation targets do —
          // a bare short_id, or {kind:"artifact", id, mode} — because it is the same
          // Selector type, normalized by the same function. Absent = a plain ask, which
          // is every session that existed before this field.
          subject: z.unknown().optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      // Normalize (and validate) the subject up front: a caller who names a subject we
      // cannot read should be told now, not discover it when the answer comes back empty.
      const subject = normalizeSelector(b.subject ?? null)
      if (b.subject !== undefined && !subject)
        return bail(fail(c, 400, "subject is not a valid selector"))
      if (subject && subject.kind !== "artifact")
        return bail(fail(c, 400, "only an artifact subject is supported"))
      // A SUBJECT on the ask lane is the chat feature wearing a context, so it needs the same
      // opt-in the chat route needs. Without this, gating only /v1/artifacts/chat-session left
      // the front door locked and this one open: any member could name a doc here and spend
      // the operator's key in a workspace that never enabled chat.
      if (subject) {
        const st = await meta.getOrgSettings(x.org_id).catch(() => null)
        if (!st?.chatBeta) return bail(fail(c, 404, "chat is not enabled for this workspace"))
      }
      if (subject) {
        // Ask-access to the CONTEXT is not read-access to the DOCUMENT. Re-check the
        // artifact separately, or a session becomes a way to read anything by naming it.
        const target = await meta.getByShortId(subject.id)
        if (!target || target.current_version === 0 || !(await authorize(c, "read", target)))
          return bail(fail(c, 404, "not found"))
        // Publishing to it is a stronger grant than reading it, checked separately so a
        // reader cannot request `mode:"publish"` and have the gate be the only thing
        // standing between them and a live write.
        if (subject.mode === "publish" && !(await authorize(c, "publish", target)))
          return bail(fail(c, 403, "you cannot publish to that artifact"))
      }
      // Return an in-flight session's current state as this ask's result (the join) —
      // same shape/status as a fresh open, so a caller need not special-case it.
      const joined = async (sess: SessionRecord) =>
        c.json(
          {
            session: sessionJson(sess),
            messages: (await meta.listSessionMessages(sess.id)).map(messageJson),
          },
          201,
        )
      if (b.dedupe_key) {
        const inflight = await meta.findInflightSession(x.id, me.id, b.dedupe_key)
        if (inflight) return joined(inflight)
      }
      // PAYER guard on the ask lane. A session's chain starts at the ASKER (the person typing
      // the question bills for the answer), then owner-lend, then the workspace pool — the
      // same order routes/model-credentials.ts resolves for an in-flight session.
      //
      // Placed AFTER the dedupe join deliberately: joining an already-open session creates no
      // new work, so it must keep working even in a workspace whose plan was disconnected
      // after that session opened. Only the branch that OPENS one has to be able to pay.
      // An operator-configured gateway means THIS DEPLOY pays, so there is no chain to walk
      // and no plan to connect. Without this the guard 402s every session on exactly the
      // self-host deployments DERIVE_MODEL_BASE_URL exists to serve — the model would work
      // and the session could never open. Found by running it, not by reading it.
      if (
        !ctx.callModel &&
        !(await canPayForAgent(meta, {
          orgId: x.org_id,
          agentId: x.agent_id,
          initiator: { userId: me.id, source: "asker" },
        }))
      )
        return bail(fail(c, 402, NO_PAYER_MESSAGE))
      let session: SessionRecord
      try {
        session = await meta.createSession({
          id: newId("ses"),
          context_id: x.id,
          org_id: x.org_id,
          asker_id: me.id,
          context_version: manifest.current_version,
          dedupe_key: b.dedupe_key,
          subject_ref: subject ? JSON.stringify(subject) : null,
        })
      } catch (e) {
        // Lost the create race to this asker's own concurrent same-key ask — the unique
        // index rejected us. Return the session that won; rethrow anything else.
        const winner = b.dedupe_key
          ? await meta.findInflightSession(x.id, me.id, b.dedupe_key)
          : null
        if (winner) return joined(winner)
        throw e
      }
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

  // CHAT WITH A DOCUMENT — the zero-setup path, and the reason a session no longer needs a
  // context. No agent to register, no context to pick, nothing to configure: name the document
  // and start talking. The first message opens the session, so merely opening the Chat tab
  // creates nothing.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/chat-session",
      tags: ["Contexts"],
      summary: "Open a chat session about an artifact (no context required).",
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
      // RATE LIMIT. This lane spends the OPERATOR's model key, and had no limiter of any kind —
      // a loop against one public document could burn it with nothing in any ledger to notice
      // by. `askLimiter` already existed for exactly this shape of request and was wired up but
      // never used anywhere.
      const rl = await limited(c, askLimiter)
      if (rl) return bail(rl)
      const b = await readJson(
        c,
        z.object({
          short_id: z.string(),
          body_md: z.string().trim().min(1).max(20_000),
          // How an edit lands. Checked against real publish rights below — a reader asking
          // for `publish` gets 403 rather than having the gate be the only thing in the way.
          mode: z.enum(["publish", "propose"]).optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      // The artifact AND its workspace's settings in one round trip. The settings are keyed
      // on the org_id the artifact carries, so reading them separately was an FK chain, and
      // on the edge tier that second lookup is a flat ~80ms (see edge-pg.ts). Fetching them
      // together does NOT weaken either gate below: both still run, in the same order, on
      // the same values.
      const { artifact: art, settings } = await meta
        .artifactWithSettings(b.short_id)
        .catch(() => ({ artifact: null, settings: null }))
      if (!art || art.current_version === 0 || !(await authorize(c, "read", art)))
        return bail(fail(c, 404, "not found"))
      // BETA GATE, enforced on the SERVER as well as hidden in the UI. A flag that only
      // hides a button is not a gate: the route is reachable directly, and this is the
      // lane that spends the operator's model key.
      if (!settings?.chatBeta) return bail(fail(c, 404, "chat is not enabled for this workspace"))
      // ALLOWLIST, on top of the workspace's own opt-in. `chatBeta` is gated on `manage`, so on
      // a shared host any workspace owner could switch it on and spend the operator's key. An
      // empty list means no restriction — right for a single-tenant box, where the operator is
      // the user — so this only bites where it should.
      if (!chatAllowed(art.org_id))
        return bail(fail(c, 404, "chat is not enabled for this workspace"))
      // MEMBERSHIP, not merely read-access. `authorize(c, "read", art)` is satisfied by a viewer
      // LINK, so any signed-in stranger who was sent one could open a live session in a
      // chat-enabled workspace and spend the operator's model key — 201 and a running turn, from
      // outside the workspace entirely. Reading a shared document is not standing to run an
      // agent inside the workspace that owns it.
      //
      // Answered from the RESOLVED ACTOR where that is the same question, re-queried where it is
      // not. For a signed-in human, `actorFor` derives `orgRole` from exactly this row —
      // getMembership(art.org_id, me.id), same arguments — and it is memoized per request, so the
      // authorize() above has already paid for it; querying again made this the third read of one
      // row in a single request.
      //
      // The fallback is not defensive padding. `resolvePrincipal` checks the static operator
      // token BEFORE the session, so a request carrying both resolves to `kind: "token"` and its
      // actor says nothing about whether the HUMAN is a member. Treating that as "not a member"
      // would have quietly denied a case that works today. The guard is `userId === me.id`, so
      // the cache is only trusted when it is describing this request's user.
      const actor = await ctx.actorFor(c, art)
      const isMember =
        actor.kind === "user" && actor.userId === me.id
          ? !!actor.orgRole
          : !!(await meta.getMembership(art.org_id, me.id).catch(() => null))
      if (!isMember) return bail(fail(c, 404, "not found"))
      const wantsPublish = b.mode === "publish"
      if (wantsPublish && !(await authorize(c, "publish", art)))
        return bail(fail(c, 403, "you cannot publish to that artifact"))
      // A CONTEXTLESS session needs the relaxed `context_session` shape (nullable context_id /
      // context_version). Postgres and self-host SQLite get it automatically; D1's schema is
      // applied out of band, so a database that predates the relaxation and has not run
      // deploy/relax-context-session-d1.sql fails right here — and it used to fail as a bare
      // `NOT NULL constraint failed` 500 with no clue as to which of the two operator actions
      // was missing. Name the fix instead.
      // Session, first message and state in ONE store call. These were three sequential
      // writes — three ~80ms round trips for one logical act — and, being three loose
      // statements outside a transaction, they could also leave a session with no first
      // message if the isolate died between them. On Postgres this is now a single CTE
      // chain, so it is one trip AND atomic.
      let session: SessionRecord
      let first: SessionMessageRecord
      try {
        const created = await meta.createSessionWithMessage(
          {
            id: newId("ses"),
            // NO CONTEXT: this is the default agent, which is the absence of a packaged one.
            context_id: null,
            context_version: null,
            org_id: art.org_id,
            asker_id: me.id,
            subject_ref: JSON.stringify({
              kind: "artifact",
              id: art.short_id,
              ...(wantsPublish ? { mode: "publish" } : {}),
            }),
          },
          {
            id: newId("sm"),
            author_kind: "asker",
            author_id: me.id,
            body_md: b.body_md,
          },
          "open",
        )
        session = created.session
        first = created.message
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/NOT NULL constraint failed: context_session\.context_(id|version)/i.test(msg)) {
          log.error("chat: context_session still requires a context — run the D1 relaxation", {
            org: art.org_id,
            error: msg,
          })
          return bail(
            fail(
              c,
              503,
              "chat is not available on this deployment yet: its database still requires every " +
                "session to belong to a context. An operator needs to apply " +
                "deploy/relax-context-session-d1.sql.",
            ),
          )
        }
        throw e
      }
      // Served here, not queued — the person is waiting. Detached, so this returns now.
      // Through `background`, not a bare await: on Workers that is executionCtx.waitUntil, so
      // the turn outlives the response and a client that gives up mid-turn still gets its reply
      // in the transcript. On Node (and tests) it awaits inline, which is what keeps the suite
      // deterministic. The comments and the polling UI both describe THIS, and previously the
      // code did not do it.
      await ctx.background(serveAttended(session, me, null))
      return c.json({ session: sessionJson(session), messages: [messageJson(first)] }, 201)
    },
  )

  // ── THE WORKSPACE CHAT ───────────────────────────────────────────────────────────────────
  //
  // The same session, the same turn, one thing less: no document. What that costs is the
  // grounding a subject provides, and what it buys is reach — the turn works the whole
  // workspace through Derive's own tools instead of one file. Sibling of the route above on
  // purpose: both open a CONTEXTLESS session and serve it attended, so a conversation that
  // starts on a document and one that starts nowhere are the same object with the same
  // history, and neither needed a table.

  const ChatModel = z
    .object({
      id: z.string().describe("The provider's model id — what to send back to pick it."),
      label: z.string().describe("What to show a person."),
      is_default: z.boolean().describe("The one a turn uses when nobody chose."),
    })
    .openapi("ChatModel")

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/chat/models",
      tags: ["Contexts"],
      summary: "Models this deploy can answer an attended chat turn with.",
      responses: {
        200: {
          description: "The models, default first. Empty when no model is configured.",
          content: { "application/json": { schema: z.object({ models: z.array(ChatModel) }) } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      // Deliberately NOT gated on chatBeta: this is the deploy's model list, not a workspace's
      // capability, and it carries no workspace data. A signed-in person asking what models
      // exist learns nothing about who may use them.
      return c.json({
        models: (ctx.models?.options ?? []).map((m) => ({
          id: m.id,
          label: m.label,
          is_default: m.isDefault,
        })),
      })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/chat-session",
      tags: ["Contexts"],
      summary: "Open a chat session about the workspace (no context, no document).",
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
      const b = await readJson(
        c,
        z.object({
          workspace: z.string().describe("The workspace id this conversation is about."),
          body_md: z.string().trim().min(1).max(20_000),
          model: z
            .string()
            .max(200)
            .optional()
            .describe("A model id from /v1/chat/models; omitted = this deploy's default."),
          surface: z
            .enum(["ask"])
            .optional()
            .describe(
              'Where the question was typed. "ask" is the \u2318K palette, which loses the writer for this turn; omitted is the full chat surface. It can only ever narrow.',
            ),
        }),
      )
      if (b instanceof Response) return bail(b)
      // EVERY rung, in one call: opt-in, allowlist, membership, rate limit, budget.
      const gate = await chatGates(c, b.workspace, me.id)
      if (gate) return bail(gate)
      // A model named here must exist NOW — better a 400 the person can act on than a session
      // that opens and then answers with something they did not choose.
      if (b.model && !ctx.models?.resolve(b.model))
        return bail(fail(c, 400, `unknown model "${b.model}"`))
      const created = await meta.createSessionWithMessage(
        {
          id: newId("ses"),
          // No context (nobody packaged this) and no subject (it is about the workspace).
          context_id: null,
          context_version: null,
          org_id: b.workspace,
          asker_id: me.id,
          subject_ref: null,
        },
        { id: newId("sm"), author_kind: "asker", author_id: me.id, body_md: b.body_md },
        "open",
      )
      // Detached, exactly like the document lane: the transcript is what the surface follows,
      // so closing the tab mid-turn loses nothing.
      await ctx.background(
        serveAttended(created.session, me, null, { modelId: b.model ?? null, surface: b.surface }),
      )
      return c.json(
        { session: sessionJson(created.session), messages: [messageJson(created.message)] },
        201,
      )
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/chat-sessions",
      tags: ["Contexts"],
      summary: "Your chat conversations in a workspace, newest first.",
      request: { query: z.object({ workspace: z.string() }) },
      responses: {
        200: {
          description: "Your sessions, each with a one-line preview.",
          content: {
            "application/json": {
              schema: z.object({
                sessions: z.array(Session.extend({ preview: z.string() })),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const org = c.req.query("workspace") ?? ""
      // Membership only — no chatBeta gate. Turning the flag off must not hide a person's own
      // past conversations: they are their record, and hiding them would read as data loss.
      if (!(await meta.getMembership(org, me.id).catch(() => null)))
        return bail(fail(c, 404, "not found"))
      const sessions = await meta.listChatSessions(org, me.id, CHAT_HISTORY_PAGE)
      // Previews in ONE batched read, never a query per session.
      const msgs = sessions.length
        ? await meta.listSessionMessagesFor(sessions.map((s) => s.id))
        : []
      const firstAsk = new Map<string, string>()
      for (const m of msgs) {
        if (m.author_kind !== "asker" || firstAsk.has(m.session_id)) continue
        firstAsk.set(m.session_id, previewOf(m.body_md))
      }
      return c.json({
        sessions: sessions.map((s) => ({
          ...sessionJson(s),
          preview: firstAsk.get(s.id) ?? "",
        })),
      })
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
                context: z
                  .object({ id: z.string(), name: z.string() })
                  .nullable()
                  .describe("The packaged agent answering, or null for a chat session."),
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
      // A CONTEXTLESS chat session has no context to gate on, so it is private to its
      // asker and nobody else — including a workspace owner, who has no standing here that
      // a context would otherwise have conferred. Without this branch every poll on a chat
      // session 404s and the reply never appears, which is exactly what dogfooding caught.
      const mine = !!s && !s.context_id && s.asker_id === me.id
      const allowed =
        mine ||
        (!!s &&
          !!linked &&
          (await canAskContext(c, linked.context)) &&
          (linked.context.created_by === me.id || s.asker_id === me.id))
      if (!s || !allowed) return bail(fail(c, 404, "not found"))
      // Before the transcript is read, not after: a poll that returns "working" for a turn that
      // died ten minutes ago is the bug this exists to close.
      const live = await reapIfAbandoned(s)
      const messages = await meta.listSessionMessages(live.id)
      return c.json({
        session: sessionJson(live),
        context: linked ? { id: linked.context.id, name: linked.context.name } : null,
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
      // A contextless chat session is legitimate and has no context to resolve; only an
      // AGENT branch below needs one, and that branch is unreachable without it.
      if (!s || (!linked && s.context_id)) return bail(fail(c, 404, "not found"))
      // Authorization decides before state does: a caller with no standing gets the
      // same 404 whether the session is open or closed — 409 would leak its state.
      const closed = (): Response | null =>
        s.state === "closed" ? fail(c, 409, "session is closed") : null

      const agent = await agentFor(c)
      if (agent) {
        if (isRunBearer(c)) return bail(fail(c, 403, NOT_THIS_LANE))
        if (!linked || agent.id !== linked.context.agent_id) return bail(fail(c, 404, "not found"))
        const gone = closed()
        if (gone) return bail(gone)
        const b = await readJson(
          c,
          z.object({
            body_md: z.string().trim().min(1).max(100_000),
            meta: z.unknown().optional(),
            surface: z
              .enum(["ask"])
              .optional()
              .describe(
                'Where the question was typed. "ask" is the \u2318K palette, which loses the writer for this turn; omitted is the full chat surface. It can only ever narrow.',
              ),
            state: z.enum(["answered", "escalated", "failed"]).optional(),
            // The asker message this answer addresses (from the runner's queue
            // snapshot) — the guard against the lost-turn race below.
            answers: z.string().optional(),
            // A NON-settling progress tick from a long-running (Maker) runner: keep
            // the session `working` (still claimed) and wake use({wait}) with the
            // tick instead of settling. Ignored when a terminal `state` is also given.
            progress: z.boolean().optional(),
            // Bind the session's living RESULT artifact — a Maker publishes a
            // "building…" placeholder early and updates it as stages land, so the
            // asker gets a stable link from the first tick.
            result_artifact_id: z.string().optional(),
          }),
        )
        if (b instanceof Response) return bail(b)
        if (b.result_artifact_id) await meta.setResultArtifact(s.id, b.result_artifact_id)
        // A model run takes minutes; the asker may follow up mid-run. An answer
        // generated before that follow-up must not settle the session — it would
        // take the follow-up off the queue unanswered, permanently. When the
        // runner says which message it answered and a newer asker message exists,
        // keep the session open (the re-serve sees the full transcript) and stamp
        // the answer stale so the runner's duplicate guard knows to re-serve.
        const isProgress = b.progress === true && !b.state
        let state: SessionState = isProgress ? "working" : (b.state ?? "answered")
        let payloadMeta = isProgress
          ? { ...(typeof b.meta === "object" && b.meta ? b.meta : {}), progress: true }
          : b.meta
        if (!isProgress && b.answers !== undefined && state !== "failed") {
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
        // Progress keeps the session `working` (still the runner's turn) — wake the
        // asker's use({wait}) with the tick. A terminal state settles it. The stale-
        // answer race keeps state `open` and wakes neither: the runner still owes a
        // reply and the next claim re-serves it.
        if (isProgress) {
          // A streaming runner is alive: renew its lease so a slow-but-live run isn't
          // re-served (and double-run) at max_concurrency > 1.
          await meta.renewSessionLease(s.id, leaseFor(linked.context))
          progressWake(s)
        } else if (state !== "open") settleWake(s, state)
        return c.json({ message: messageJson(m) }, 201)
      }

      const me = await currentUser(c)
      if (!me) return bail(fail(c, 401, "unauthenticated"))
      // Re-gate on ask-access, not just session ownership: a follow-up re-opens
      // the session and the runner answers it (a fresh query against the data).
      // A member removed from the workspace/roster after opening a session must
      // not keep querying through it — canAskContext re-checks membership + policy.
      // Contextless: ownership IS the whole gate. With a context, re-check the ask grant
      // too, so someone removed from the roster cannot keep querying through an old session.
      if (s.asker_id !== me.id || (linked && !(await canAskContext(c, linked.context))))
        return bail(fail(c, 404, "not found"))
      // (Membership for the contextless CHAT lane is re-checked per turn inside serveAttended,
      // alongside the document ACL, so the refusal lands in the transcript with a reason rather
      // than as a bare 404 the asker cannot interpret. The context lane gets its equivalent from
      // canAskContext above.)
      const gone = closed()
      if (gone) return bail(gone)
      // RATE LIMIT. Every follow-up serves a full attended turn on somebody's model plan (the
      // operator's, on the chat lane), and only session CREATION was limited — so one session,
      // then an unbounded loop of follow-ups through it, was a completely unmetered way to
      // spend the key that `askLimiter` exists to protect. Same limiter, same lane, the turn
      // that was missing.
      const rl = await limited(c, askLimiter)
      if (rl) return bail(rl)
      const b = await readJson(
        c,
        z.object({
          body_md: z.string().trim().min(1).max(20_000),
          // A model switch is a per-TURN choice, not a session setting: "answer that again with
          // the bigger one" is the whole use case, and it must not rewrite what already answered.
          // Absent = whatever this conversation was last answered with (see lastModelId).
          model: z.string().max(200).optional(),
          // Per-turn for the same reason: the palette narrows ITS turns to the reading tools, and
          // the same conversation reopened on /chat is not narrowed. Only ever narrows.
          surface: z.enum(["ask"]).optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      if (b.model && !ctx.models?.resolve(b.model))
        return bail(fail(c, 400, `unknown model "${b.model}"`))
      // THE MONTHLY BUDGET, for the same reason. Dispatch enforces it on every hosted run and
      // every queued session; an attended follow-up bypassed dispatch entirely, so the one lane
      // a person can drive by hand as fast as they can type was the one lane with no ceiling.
      // Checked BEFORE the message is appended: refusing after the append would reopen the
      // session with nothing willing to serve it.
      if (await overBudget(meta, s.org_id, me.id).catch(() => false))
        return bail(fail(c, 429, "monthly model budget reached"))
      // A follow-up mid-run must NOT vacate an active claim, and reopening must not race a
      // concurrent settle. appendFollowupReopen does both in one atomic compare-and-set:
      // a `working` session stays `working` (the runner sees the new turn on re-read, and its
      // stale-turn guard re-serves it after replying); a settled/open one goes to `open`,
      // dropping the dedupe key on the settled path so it can't collide with a newer same-key
      // session. Reading live state inside the UPDATE closes the settle-vs-reopen window a
      // read-then-write would leave (which could strand the session `working` with no runner).
      const m = await meta.appendFollowupReopen({
        id: newId("sm"),
        session_id: s.id,
        author_kind: "asker",
        author_id: me.id,
        body_md: b.body_md,
      })
      // ATTENDED: someone is sitting there, so serve the turn HERE instead of queuing it for a
      // runner that may not be running. Detached — the response returns now and the TRANSCRIPT is
      // what the surface follows, so closing the tab mid-turn loses nothing.
      // The beta gate again, on the lane that actually SPENDS the key. Gating only session
      // CREATION would mean turning the flag off leaves every existing conversation running —
      // a kill switch that does not kill.
      //
      // It binds EVERY session chat can reach, which is the fix: the check used to hang off
      // `!s.context_id`, and chat also wears a context — a session opened through
      // `POST /v1/contexts/:id/sessions` with a `subject` is the chat feature with a packaged
      // agent behind it, gated on `chatBeta` at creation (see above) and then, once open,
      // serving turns forever after the flag came off. Mirroring the creation gate exactly is
      // what makes the switch actually kill: contextless OR subject-bearing needs the opt-in;
      // a plain context ask (no subject) is the pre-existing lane, predates chat, and is
      // deliberately untouched — gating it would take contexts away from every workspace that
      // never enabled chat.
      if (!s.context_id || s.subject_ref) {
        const st = await meta.getOrgSettings(s.org_id).catch(() => null)
        if (!st?.chatBeta) return c.json({ message: messageJson(m) }, 201)
      }
      await ctx.background(
        serveAttended(s, me, linked?.context.agent_id ?? null, {
          modelId: b.model ?? null,
          surface: b.surface,
        }),
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
        if (isRunBearer(c)) return bail(fail(c, 403, NOT_THIS_LANE))
        if (agent.id !== linked.context.agent_id) return bail(fail(c, 404, "not found"))
        // The asker may close mid-run; the run's eventual failure must not reopen
        // a conversation they deliberately ended.
        if (s.state === "closed") return bail(fail(c, 409, "session is closed"))
        const b = await readJson(c, z.object({ state: z.literal("failed") }))
        if (b instanceof Response) return bail(b)
        const updated = await meta.setSessionState(s.id, b.state)
        if (!updated) return bail(fail(c, 404, "not found"))
        settleWake(s, b.state)
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
      settleWake(s, b.state)
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
      // Reading this queue CLAIMS sessions (open → working), so a run's pass crossing here
      // would quietly take over the ask lane's work.
      if (isRunBearer(c)) return bail(fail(c, 403, NOT_THIS_LANE))
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
      // CLAIM the queue (open -> working) rather than a plain read: overlapping
      // polls — or a second runner — can never double-serve the same session, and a
      // crashed runner's claim self-heals once its lease lapses (claimPendingSessions
      // re-serves a `working` row past lease_until). Cap what's in-flight to the
      // context's max_concurrency so heavy Maker jobs don't pile onto one box; a
      // sequential runner claims exactly what it will work on now (default 1), so a
      // crash strands one session, not a batch.
      const limit = Math.min(20, Math.max(1, Number(c.req.query("limit")) || 10))
      const working = await meta.countWorkingSessions(x.id)
      const room = Math.max(0, (x.max_concurrency ?? 1) - working)
      const sessions =
        room === 0 ? [] : await meta.claimPendingSessions(x.id, Math.min(limit, room), leaseFor(x))
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
      // The same list the hosted claim returns. A context's reach must not depend on
      // which kind of executor picked its session up.
      const reach = await contextTools(x)
      const settings = await meta.getOrgSettings(x.org_id)
      return c.json({
        sessions: out,
        tools: reach.tools.map((t) => ({ def: t.def, ref: t.ref })),
        // The gate's inputs, which this endpoint did NOT send before — so a polling runner had
        // nothing to gate on while the hosted claim did, and the same ask could land live on one
        // executor and as a review on the other. Sending them makes the lanes symmetrical in
        // what they KNOW. Note the CLI's ask path does not consult them yet (serveSession
        // publishes directly); that half is tracked separately, and this is its prerequisite.
        flags: {
          agentKillswitch: settings.agentKillswitch,
          agentAutoEnabled: settings.agentAutoEnabled,
          credentialed: reach.credentialed,
        },
      })
    },
  )

  // The HOSTED ask lane's claim: a session-scoped capability bearer (dksess_, minted by
  // dispatch) claims EXACTLY its own session and gets the same payload the queue returns —
  // context + manifest + transcript — so the executor serves an ask exactly as a polling
  // runner does. No context id in the path: the token already names the one session it may
  // touch, and pinning to it is the whole security story.
  app.post("/v1/agent/sessions/claim", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    const scope = agentSessionScope(c)
    // Deliberately session-token ONLY: a standing agent bearer has the context queue for this,
    // and letting one claim by id would bypass the per-context concurrency cap.
    if (!scope) return fail(c, 403, "a session capability token is required")
    const s = await meta.getSession(scope)
    // No context ⇒ no owning agent ⇒ 404 (a contextless chat session is served in-process).
    const x = s?.context_id ? await meta.getContext(s.context_id) : null
    if (!s || !x || x.agent_id !== agent.id) return fail(c, 404, "not found")
    // The HOSTED lease comes from the run lifecycle clock, NOT from leaseFor(context).
    //
    // A polling runner holds a standing token that never expires, so a short lease there is
    // survivable: re-serving early costs a duplicate answer, which that lane knowingly accepts
    // (see the note on leaseFor). A hosted executor is different — it holds a capability token
    // minted for RUN_TOKEN_TTL_MS, and a lease SHORTER than that token is exactly the
    // double-write window run-lifecycle.ts exists to close. At the context default the lease
    // was 11 minutes against a 20-minute token, so at T+11 dispatch minted a second executor
    // while the first could still write for 9 minutes: two published artifacts for one ask,
    // billed twice, one of them orphaned.
    //
    // RUN_LEASE_MS is the same 25 minutes the run lane uses, satisfying the same ordering —
    // timeout 15m < token 20m < lease 25m — so a replaced executor is provably tokenless
    // before its replacement is served.
    const claimed = await meta.claimSessionById(
      scope,
      agent.id,
      new Date(Date.now() + RUN_LEASE_MS).toISOString(),
    )
    // Lost the race (a duplicate dispatch, or the asker closed it): nothing to serve, and the
    // executor exits clean rather than double-answering.
    if (!claimed) return c.json({ session: null })
    const manifest = await meta.getArtifactById(x.manifest_artifact_id)
    // The autonomy gate's inputs, resolved server-side and FRESH at claim time — exactly as the
    // runs claim resolves them, so a flipped killswitch is seen on the very next ask. An executor
    // with no flags to gate on would have to either ignore the switch or invent a policy of its
    // own, and both are worse than one more read here.
    const settings = await meta.getOrgSettings(x.org_id)
    // Resolved ONCE: the same read answers what the executor may call and whether the write
    // gate must demote this ask. Two reads could disagree.
    const reach = await contextTools(x)
    return c.json({
      session: {
        ...sessionJson(claimed),
        messages: (await meta.listSessionMessagesFor([claimed.id])).map(messageJson),
      },
      context: { id: x.id, name: x.name, manifest_short_id: manifest?.short_id ?? null },
      flags: {
        agentKillswitch: settings.agentKillswitch,
        agentAutoEnabled: settings.agentAutoEnabled,
        // Same rung as the run lane: an ask that can spend a credential files its page for
        // review instead of publishing it live (@derive/core decideWrite, rung 3).
        credentialed: reach.credentialed,
      },
      // Projected def + ref only, as the run claim is: RunTool's routing fields, and the
      // connection behind them, stay server-side.
      tools: reach.tools.map((t) => ({ def: t.def, ref: t.ref })),
    })
  })

  // Execute one of the session's tools — the ask lane's mirror of the run proxy. The
  // executor holds a capability token and no credential, so the call comes back here to
  // be re-checked against this context's list and run server-side.
  //
  // Reached today ONLY by the in-process Workers loop (lib/substrate-loop.ts) — the lane with
  // no container, which therefore cannot run code. The CLI runner deliberately does not call
  // it: `queue()` drops the tools array and serveSessionOnce ignores `claimed.tools`, because
  // a runner HAS a machine, so its contexts get their credentials delivered and use ordinary
  // libraries instead. That asymmetry is intended, not an unfinished wiring job — the endpoint
  // is not dead code, and it is also not the road new credential shapes travel (see the
  // FROZEN SURFACE note on httpTools).
  app.post("/v1/agent/sessions/:id/tool", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    if (isRunBearer(c)) return fail(c, 403, NOT_THIS_LANE)
    // A session capability bearer may act ONLY on the session it was minted for. A standing
    // agent bearer (the BYO polling runner) has no session scope, and is allowed here for
    // sessions of a context it owns — the ownership check below is what bounds it, exactly
    // as the run lane bounds a standing bearer by run.agent_id.
    const scope = agentSessionScope(c)
    const sessionId = c.req.param("id") ?? ""
    if (scope && scope !== sessionId) return fail(c, 403, "not this session's token")
    const s = await meta.getSession(sessionId)
    // A CONTEXTLESS (chat) session has no context and therefore no owning agent, so no agent
    // bearer may reach its tools — the same fail-closed rule every other agent-facing session
    // lane follows. Chat is served in-process for a signed-in human, never by a bearer.
    const x = s?.context_id ? await meta.getContext(s.context_id) : null
    if (!s || !x || x.agent_id !== agent.id || x.org_id !== agent.org_id)
      return fail(c, 404, "not found")
    const b = await readJson(
      c,
      z.object({
        tool: z.string().max(200),
        args: z.unknown().optional(),
        ref: z.string().max(200).optional(),
      }),
    )
    if (b instanceof Response) return bail(b)
    const { broker, route, tools } = await contextTools(x)
    const out = await callTool({
      meta,
      broker,
      route: route ?? undefined,
      orgId: x.org_id,
      encryptionKey: deps.encryptionKey,
      allowed: tools,
      subject: "this context",
      tool: b.tool,
      args: b.args,
      ref: b.ref,
    })
    return out.ok ? c.json({ result: out.result }) : fail(c, out.status, out.message)
  })

  return app
}
