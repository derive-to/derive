// RUN SIDE of `use`. There is no separate runner tool: serving a context is a mode of
// `use`, dispatched by ownership. TWO principals can run a context: its REGISTERED
// dk_agt_ agent (agent_id === agent.id), and — OWNER-RUN — a human OAuth grant whose
// user holds the manage-grade (owner) seat in the context's workspace, so the person who
// wired a context up serves it from the session they already have, no second token.
// `use({context})` (no instruction) PULLS queued work; `use({session_id, answer})` posts
// the AGENT turn (with optional progress/state/result). A give always carries an
// instruction and a check never carries `answer`, so the modes stay unambiguous; a
// context/session that isn't yours to run returns null and `use` falls through to the
// give path, and every other grant's surface is unchanged.
import {
  type ContextRecord,
  capRole,
  newId,
  roleAllows,
  type SessionMessageRecord,
  type SessionRecord,
  type SessionState,
} from "@derive/core"
import type { ToolContext } from "../mcp-tool-context"
import { clipSessionText, ENTRY_MAX, err, json } from "../mcp-util"

type ToolResult = ReturnType<typeof json> | ReturnType<typeof err>

/** The runner (agent-you-run) half of `use`, dispatched by ownership. Returns a tool
 *  result when the call is a runner op (REPORT/PULL on a context this connection is the
 *  agent for), or null when it isn't — `use` then handles it as a normal asker call. */
export async function runnerDispatch(
  tc: ToolContext,
  args: {
    context?: string
    instruction?: string
    session_id?: string
    answer?: string
    progress?: boolean
    state?: "answered" | "escalated" | "failed"
    result_artifact_id?: string
    answers?: string
    workspace?: string
  },
): Promise<ToolResult | null> {
  const { ctx, agent, actingFor, ownerId, scopeForCap, registered, inGrant, resolveWs } = tc
  const { context, instruction, session_id, answer, progress, state, result_artifact_id, answers } =
    args

  // OWNER-RUN: does this connection's human hold the manage-grade (owner) seat in `org`?
  // Grants only — a registered agent runs by agent_id, never by seat. The default
  // workspace's role is already membership-capped; a roamed one re-caps from the grant's
  // scope against live membership, the same rule as resolveWs / the X-Derive-Workspace
  // re-home. Exactly the people who could rewire the context anyway.
  const ownerRunsOrg = async (org: string): Promise<boolean> => {
    if (registered || !actingFor) return false
    if (org === agent.org_id) return roleAllows(agent.role, "manage")
    if (!ownerId || !inGrant(org)) return false
    const m = await ctx.meta.getMembership(org, ownerId)
    return !!m && roleAllows(capRole(scopeForCap, m.role), "manage")
  }
  // The agent turn's author: the registered agent, or the owner-run human — the
  // transcript says who actually did the work.
  const runnerId = registered ? agent.id : (actingFor?.id ?? agent.id)

  // A claimed session's lease — how long it holds `working` before re-serve (crash /
  // reboot). From the context's max_run_ms, clamped like the REST queue's leaseFor, plus a
  // margin so the lease OUTLIVES the run budget: a run that never ticks and finishes right at
  // budget must not land on an already-expired lease and be re-served (a double-run).
  const leaseFor = (x: ContextRecord): string => {
    const ms = Math.min(Math.max(x.max_run_ms ?? 600_000, 30_000), 6 * 60 * 60_000)
    return new Date(Date.now() + ms + 60_000).toISOString()
  }
  // A context THIS connection RUNS, by id or name. A registered agent runs exactly the
  // contexts it is the agent for (agent_id === agent.id is the whole gate). A grant
  // runs by OWNER-RUN: the context is resolved where a give would look (the named or
  // default workspace) and the human must hold the manage-grade seat there. Null when
  // not yours to run.
  const runnableContext = async (ref: string): Promise<ContextRecord | null> => {
    const trimmed = ref.trim()
    if (registered) {
      const byId = await ctx.meta.getContext(trimmed)
      if (byId && byId.agent_id === agent.id) return byId
      const lc = trimmed.toLowerCase()
      const rows = await ctx.meta.listContexts(agent.org_id)
      return rows.find((x) => x.agent_id === agent.id && x.name.toLowerCase() === lc) ?? null
    }
    if (!actingFor) return null
    const t = await resolveWs(args.workspace)
    if ("error" in t || !roleAllows(t.role, "manage")) return null
    const byId = await ctx.meta.getContext(trimmed)
    if (byId && byId.org_id === t.org) return byId
    const lc = trimmed.toLowerCase()
    const rows = await ctx.meta.listContexts(t.org)
    return rows.find((x) => x.name.toLowerCase() === lc) ?? null
  }
  // SERVE: claim (open -> working) up to 10 runnable sessions and return each with its
  // transcript. Claiming leases each so overlapping runs never double-answer one; the
  // in-flight count is capped by the context's max_concurrency (default 1).
  const runnerServe = async (x: ContextRecord) => {
    // Liveness IS this poll — stamp at most once a minute; a failed stamp must not
    // break the claim (the work comes first).
    const now = Date.now()
    if (!x.runner_seen_at || now - new Date(x.runner_seen_at).getTime() > 60_000)
      await ctx.meta.touchContextSeen(x.id, new Date(now).toISOString()).catch(() => {})
    const working = await ctx.meta.countWorkingSessions(x.id)
    const room = Math.max(0, (x.max_concurrency ?? 1) - working)
    const sessions =
      room === 0 ? [] : await ctx.meta.claimPendingSessions(x.id, Math.min(10, room), leaseFor(x))
    const consoleUrl = `${ctx.deps.baseUrl.replace(/\/$/, "")}/contexts/${x.id}`
    const bySession = new Map<string, SessionMessageRecord[]>()
    for (const m of await ctx.meta.listSessionMessagesFor(sessions.map((s) => s.id))) {
      const arr = bySession.get(m.session_id)
      if (arr) arr.push(m)
      else bySession.set(m.session_id, [m])
    }
    return json({
      context: x.name,
      claimed: sessions.length,
      ...(room === 0 && working > 0
        ? {
            note: "At the context's concurrency cap — answer an in-flight session before claiming more.",
          }
        : {}),
      sessions: sessions.map((s) => ({
        session_id: s.id,
        state: s.state,
        lease_until: s.lease_until,
        ...(s.result_artifact_id ? { result_artifact_id: s.result_artifact_id } : {}),
        messages: (bySession.get(s.id) ?? []).map((m) => ({
          id: m.id,
          author: m.author_kind,
          body_md: clipSessionText(m.body_md, ENTRY_MAX, consoleUrl),
          created_at: m.created_at,
        })),
      })),
    })
  }
  // ANSWER: post the runner's turn on a claimed session — the answer (settles), a progress
  // tick (progress:true, stays `working`, streams to the asker), an escalation, or a crash.
  // Mirrors the REST messages agent branch, including the stale-turn guard.
  const runnerAnswer = async (
    s: SessionRecord,
    x: ContextRecord,
    o: {
      body: string
      progress?: boolean
      state?: "answered" | "escalated" | "failed"
      result_artifact_id?: string
      answers?: string
    },
  ) => {
    if (s.state === "closed") return err("That session is closed — nothing to answer.")
    if (o.result_artifact_id) await ctx.meta.setResultArtifact(s.id, o.result_artifact_id)
    const isProgress = o.progress === true && !o.state
    let sstate: SessionState = isProgress ? "working" : (o.state ?? "answered")
    let payloadMeta: Record<string, unknown> | undefined = isProgress
      ? { progress: true }
      : undefined
    // A run takes minutes; an asker follow-up may land mid-run. An answer generated before
    // it must not settle the session (it would strand the follow-up). When the runner names
    // the message it answered and a newer asker message exists, keep it open and stamp the
    // answer stale — the next serve re-serves the full transcript.
    if (!isProgress && o.answers !== undefined && sstate !== "failed") {
      const transcript = await ctx.meta.listSessionMessages(s.id)
      const lastAsker = transcript.filter((t) => t.author_kind === "asker").at(-1)
      if (lastAsker && lastAsker.id !== o.answers) {
        sstate = "open"
        payloadMeta = { stale: true }
      }
    }
    const m = await ctx.meta.addSessionMessage(
      {
        id: newId("sm"),
        session_id: s.id,
        author_kind: "agent",
        author_id: runnerId,
        body_md: o.body,
        meta: payloadMeta === undefined ? null : JSON.stringify(payloadMeta),
      },
      sstate,
    )
    // Wake the asker's use({wait}): progress streams; a terminal state collects the answer.
    // The stale race keeps it `open` and wakes neither (the runner still owes).
    if (isProgress) {
      // A streaming runner is alive: renew its lease so a slow-but-live run isn't re-served
      // (and double-run) at max_concurrency > 1.
      await ctx.meta.renewSessionLease(s.id, leaseFor(x))
      ctx.bus.publish(`u:${s.asker_id}`, { type: "session.progress", session_id: s.id })
    } else if (sstate !== "open")
      ctx.bus.publish(`u:${s.asker_id}`, {
        type: "session.settled",
        session_id: s.id,
        state: sstate,
      })
    const base = ctx.deps.baseUrl.replace(/\/$/, "")
    return json({
      session_id: s.id,
      context: x.name,
      state: sstate,
      message_id: m.id,
      ...(sstate === "open"
        ? {
            note: "A newer asker message landed mid-run — kept open and this answer marked stale; a fresh use({context}) serve re-serves it.",
          }
        : {}),
      ...(o.result_artifact_id ? { result_url: `${base}/artifacts/${o.result_artifact_id}` } : {}),
    })
  }

  // REPORT on a session you run — your `answer` is the agent turn. `answer` is runner
  // vocabulary (a follow-up is `instruction`), so a session that isn't yours to run
  // falls through to the check path unchanged.
  if (session_id && answer !== undefined) {
    const s = await ctx.meta.getSession(session_id)
    const x = s ? await ctx.meta.getContext(s.context_id) : null
    if (s && x && (registered ? x.agent_id === agent.id : await ownerRunsOrg(x.org_id)))
      return runnerAnswer(s, x, { body: answer, progress, state, result_artifact_id, answers })
  }
  // PULL your queued work: a context you run + NO instruction (a give always has one, so a
  // bare context can only mean "I'm the agent — hand me my sessions").
  if (context && instruction === undefined && !session_id) {
    const owned = await runnableContext(context)
    if (owned) return runnerServe(owned)
  }
  return null // not a runner op — `use` handles it as a normal asker call
}
