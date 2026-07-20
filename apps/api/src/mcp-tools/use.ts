import {
  type ContextRecord,
  newId,
  type SessionMessageRecord,
  type SessionRecord,
  type SessionState,
} from "@derive/core"
import { z } from "zod"
import type { ToolContext } from "../mcp-tool-context"
import { err, json, runnerOnline } from "../mcp-util"

// USE A CONTEXT — query a workspace's live data agents ------------------------
// Contexts are askable agent setups (a registered agent wired to a manifest, answering
// through an owner-run runner). `use` is the agent-side surface, acting FOR the
// connection's on-behalf human: the human's own ask-grant (membership + ask_policy/
// roster, re-checked per call via canUserAskContext) is the ONLY gate, so an agent can
// reach exactly what its human can, and nothing more. Discovery is `find` (contexts ride
// the browse/search results); a connection with no known human is refused at call time.
// Management (create/rewire/delete) deliberately has no MCP path. (askableContexts /
// runnerOnline live in mcp-tool-context / mcp-util — shared with find's context rows.)

const NO_HUMAN =
  "Using a context opens a session on a human's behalf, and this connection has no acting human. " +
  "Reconnect with an OAuth login (or a token registered by a user) to use one."

// Session messages are uncapped short of the write path's 100k/message, so a
// maximal check-mode reply is megabytes through the calling agent's context.
// Bound it like every read here (truncate-and-steer): a generous cap on the
// answer, a tight one per transcript entry — together they stay under clip()'s
// MAX_CHARS ceiling — and the steer names the console, which always holds the
// full transcript.
const ANSWER_MAX = 40_000
const ENTRY_MAX = 1_500
const clipSessionText = (s: string, max: number, consoleUrl: string): string =>
  s.length > max
    ? `${s.slice(0, max)}\n\n…[truncated ${s.length - max} of ${s.length} chars — full transcript in the console: ${consoleUrl}]`
    : s

export function registerUseTool(tc: ToolContext): void {
  const { server, ctx, agent, actingFor, registered, askableContexts, inGrant, resolveWs, wsArg } =
    tc

  // RUN SIDE of `use`. There is no separate runner tool: being a context's agent is a
  // mode of `use`. `use({context})` (no instruction) on a context whose agent is this
  // connection PULLS its queued work; `use({session_id, answer})` on such a session posts
  // the AGENT turn (with optional progress/state/result). Only a registered dk_agt_ agent
  // owns a context, so these paths are unreachable for a human's OAuth grant — dispatch
  // is by ownership, so a context/session that isn't yours falls through to the give
  // path and never changes the human surface.

  // A claimed session's lease — how long it holds `working` before re-serve (crash /
  // reboot). From the context's max_run_ms, clamped like the REST queue's leaseFor.
  const leaseFor = (x: ContextRecord): string => {
    const ms = Math.min(Math.max(x.max_run_ms ?? 600_000, 30_000), 6 * 60 * 60_000)
    return new Date(Date.now() + ms).toISOString()
  }
  // A context THIS connection RUNS, by id or name — a context is owned by exactly one
  // agent, so agent_id === agent.id is the whole gate. Null when not yours to run.
  const runnableContext = async (ref: string): Promise<ContextRecord | null> => {
    const trimmed = ref.trim()
    const byId = await ctx.meta.getContext(trimmed)
    if (byId && byId.agent_id === agent.id) return byId
    const lc = trimmed.toLowerCase()
    const rows = await ctx.meta.listContexts(agent.org_id)
    return rows.find((x) => x.agent_id === agent.id && x.name.toLowerCase() === lc) ?? null
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
  // ANSWER: post the runner's turn on a claimed session — the answer (settles), a
  // progress tick (progress:true, stays `working`, streams to the asker), an escalation,
  // or a crash. Mirrors the REST messages agent branch, including the stale-turn guard.
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
    let state: SessionState = isProgress ? "working" : (o.state ?? "answered")
    let payloadMeta: Record<string, unknown> | undefined = isProgress
      ? { progress: true }
      : undefined
    // A run takes minutes; an asker follow-up may land mid-run. An answer generated
    // before it must not settle the session (it would strand the follow-up). When the
    // runner names the message it answered and a newer asker message exists, keep it
    // open and stamp the answer stale — the next serve re-serves the full transcript.
    if (!isProgress && o.answers !== undefined && state !== "failed") {
      const transcript = await ctx.meta.listSessionMessages(s.id)
      const lastAsker = transcript.filter((t) => t.author_kind === "asker").at(-1)
      if (lastAsker && lastAsker.id !== o.answers) {
        state = "open"
        payloadMeta = { stale: true }
      }
    }
    const m = await ctx.meta.addSessionMessage(
      {
        id: newId("sm"),
        session_id: s.id,
        author_kind: "agent",
        author_id: agent.id,
        body_md: o.body,
        meta: payloadMeta === undefined ? null : JSON.stringify(payloadMeta),
      },
      state,
    )
    // Wake the asker's use({wait}): progress streams; a terminal state collects the
    // answer. The stale race keeps it `open` and wakes neither (the runner still owes).
    if (isProgress)
      ctx.bus.publish(`u:${s.asker_id}`, { type: "session.progress", session_id: s.id })
    else if (state !== "open")
      ctx.bus.publish(`u:${s.asker_id}`, { type: "session.settled", session_id: s.id, state })
    const base = ctx.deps.baseUrl.replace(/\/$/, "")
    return json({
      session_id: s.id,
      context: x.name,
      state,
      message_id: m.id,
      ...(state === "open"
        ? {
            note: "A newer asker message landed mid-run — kept open and this answer marked stale; a fresh use({context}) serve re-serves it.",
          }
        : {}),
      ...(o.result_artifact_id ? { result_url: `${base}/artifacts/${o.result_artifact_id}` } : {}),
    })
  }

  // (Listing the askable contexts now lives in `find` — they ride the browse/search rows.)

  server.registerTool(
    "use",
    {
      description:
        "Use a context (a live agent wired to data + tools — discover them with find) ON YOUR " +
        "USER'S BEHALF (rate-limited): give it an INSTRUCTION and it works one session. GIVE: " +
        "`context` (id or name) + `instruction` — 'with this context, do this' (a question OR a " +
        "task; always name the target, e.g. 'for Airbnb'). FOLLOW UP: `session_id` + `instruction`. " +
        "CHECK/RESUME: `session_id` alone. The call waits up to `wait` seconds (default 25) for the " +
        "result; real runs take minutes and STREAM, so a still-working response is NORMAL — re-call " +
        "with the returned session_id until it settles. RUN a context you are the agent for: " +
        "`use({context})` with no instruction PULLS your queued work; `use({session_id, answer})` " +
        "reports back (+ `progress` / `state` / `result_artifact_id`). For the modes and the runner " +
        "loop, read derive://skills/contexts.",
      inputSchema: {
        context: z
          .string()
          .optional()
          .describe(
            "The context to use — its id or name from a find context row. Opens a NEW session; omit when passing session_id.",
          ),
        instruction: z
          .string()
          .trim()
          .min(1)
          .max(20_000)
          .optional()
          .describe(
            "'With this context, do this' (Markdown) — a question OR a task, always naming the target (e.g. 'for Airbnb'). With `context` it opens a session; with `session_id` it is a follow-up turn. Omit it to just check a session (or, if you RUN the context, to pull your queued work).",
          ),
        session_id: z
          .string()
          .optional()
          .describe(
            "An existing session of yours (from an earlier use, or a find context row) to follow up on or check.",
          ),
        wait: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe(
            "Seconds to wait for a progress tick or the answer before returning (default 25; 0 = return at once). A long job streams — re-call with the returned session_id to keep watching; a still-working reply is normal.",
          ),
        dedupe_key: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "OPEN mode only: an idempotency key. A second use with the same key while one is still in flight JOINS the existing session instead of opening a new one — so a double 'run for X' never runs the job twice.",
          ),
        answer: z
          .string()
          .trim()
          .min(1)
          .max(20_000)
          .optional()
          .describe(
            "RUN mode only: your reply on a session you run — the result, or a note. Pass with `session_id` (the context must be one you are the agent for). Add `progress`/`state`/`result_artifact_id` to shape the turn.",
          ),
        progress: z
          .boolean()
          .optional()
          .describe(
            "RUN mode only: a non-settling progress tick — keep the session working and stream this `answer` to the requester. Ignored when `state` is also set.",
          ),
        state: z
          .enum(["answered", "escalated", "failed"])
          .optional()
          .describe(
            "RUN mode only: the terminal state. Omit for a plain result (answered) or with progress:true. escalated = you sent a draft to human review; failed = the run crashed.",
          ),
        result_artifact_id: z
          .string()
          .optional()
          .describe(
            "RUN mode only: bind/refresh the session's result artifact (its short_id) — the stable link the requester sees. Publish a 'building…' page early, update it as stages land.",
          ),
        answers: z
          .string()
          .optional()
          .describe(
            "RUN mode only: the requester-message id (from your pull snapshot) this addresses — the guard against settling over a follow-up that landed mid-run.",
          ),
        workspace: wsArg,
      },
    },
    async ({
      context,
      instruction,
      session_id,
      wait,
      dedupe_key,
      answer,
      progress,
      state,
      result_artifact_id,
      answers,
      workspace,
    }) => {
      // RUN MODE — a registered agent acting on a context it is the AGENT FOR needs no
      // acting human (it acts as itself). The two directions read themselves: you REPORT
      // with `answer`, you're GIVEN an `instruction`. Dispatched by ownership, so a
      // context/session that isn't yours to run falls straight through to the give path
      // below and the human surface is unchanged.
      if (registered) {
        // REPORT on a session you run — your `answer` is the agent turn.
        if (session_id && answer !== undefined) {
          const s = await ctx.meta.getSession(session_id)
          const x = s ? await ctx.meta.getContext(s.context_id) : null
          if (s && x && x.agent_id === agent.id)
            return runnerAnswer(s, x, {
              body: answer,
              progress,
              state,
              result_artifact_id,
              answers,
            })
        }
        // PULL your queued work: a context you run + NO instruction (a give always has one,
        // so a bare context can only mean "I'm the agent — hand me my sessions").
        if (context && instruction === undefined && !session_id) {
          const owned = await runnableContext(context)
          if (owned) return runnerServe(owned)
        }
      }
      if (!actingFor) return err(NO_HUMAN)
      // Session WRITES are capped per acting human — each one triggers a model
      // run on the context owner's runner, so a looping agent is the realistic
      // flood. The check mode is a read and stays uncapped.
      const overAskCap = async () => {
        if (!ctx.askLimiter) return null
        const r = await ctx.askLimiter(`id:${actingFor.id}`)
        return r.ok ? null : err(`Rate limit exceeded — retry in ${r.retryAfter}s.`)
      }

      // Every mode ends here: wait out the runner while the session is NOT settled,
      // returning EARLY on a progress tick (a Maker job streams — don't block to
      // timeout), then shape the reply from a FRESH read. The event is only a wake,
      // so a missed/raced one is never a wrong answer. The channel wakes for ANY of
      // this human's sessions; the loop re-checks ours and waits out the remainder.
      const isSettled = (st: string) =>
        st === "answered" || st === "escalated" || st === "failed" || st === "closed"
      const reply = async (start: SessionRecord, x: ContextRecord, checkOnly: boolean) => {
        let s = start
        const deadline = Date.now() + Math.min(Math.max(wait ?? 25, 0), 50) * 1000
        while (!isSettled(s.state) && ctx.bus.waitFor) {
          const left = deadline - Date.now()
          if (left <= 0) break
          const release = new AbortController()
          const woke = ctx.bus
            .waitFor(
              `u:${actingFor.id}`,
              ["session.settled", "session.progress"],
              left,
              release.signal,
            )
            .catch(() => null)
          // Close the check-then-wait gap: a settle/progress may have landed since
          // the last read, before our subscription existed.
          const fresh = await ctx.meta.getSession(s.id)
          if (fresh) s = fresh
          if (isSettled(s.state)) {
            release.abort()
            await woke
            break
          }
          const e = await woke
          s = (await ctx.meta.getSession(s.id)) ?? s
          if (isSettled(s.state)) break
          if (!e) break // timed out — s holds one last fresh read
          // A progress tick for OUR session: return it now (the runner is streaming).
          // A wake for a DIFFERENT session loops on and waits out the remainder.
          if (e.type === "session.progress" && e.session_id === s.id) break
        }

        const transcript = await ctx.meta.listSessionMessages(s.id)
        const lastAgent = transcript.filter((m) => m.author_kind === "agent").at(-1)
        // The last agent message is the ANSWER once settled, or the latest PROGRESS
        // tick while `working`. Stored as TEXT (see ports); a hand-edited row must not
        // 500 the tool — unparseable meta reads as absent.
        const parseMeta = (row?: { meta: string | null }): unknown => {
          if (!row?.meta) return null
          try {
            return JSON.parse(row.meta)
          } catch {
            return null
          }
        }
        const answerRow = isSettled(s.state) ? lastAgent : undefined
        const progressRow = s.state === "working" ? lastAgent : undefined
        const base = ctx.deps.baseUrl.replace(/\/$/, "")
        const consoleUrl = `${base}/contexts/${x.id}`
        // The living result artifact (a Maker binds a "building…" page early and
        // updates it as stages land) — a stable link from the first tick.
        const resultUrl = s.result_artifact_id
          ? `${base}/artifacts/${s.result_artifact_id}`
          : undefined
        const note =
          s.state === "open"
            ? runnerOnline(x)
              ? "Queued — re-call use with this session_id (+ wait) to collect the answer."
              : "Queued, but the context's runner looks OFFLINE — it answers when it comes back. Re-call use with this session_id later."
            : s.state === "working"
              ? "In progress — the runner is working. Re-call use with this session_id (+ wait) to keep watching; the result link fills in as it goes."
              : s.state === "escalated"
                ? "The runner escalated this to a human — a draft went to review. Check back later."
                : s.state === "failed"
                  ? "The run crashed; the context's owner sees the failure. You can ask again."
                  : s.state === "closed"
                    ? "This session was closed."
                    : undefined
        return json({
          session_id: s.id,
          context: x.name,
          state: s.state,
          ...(resultUrl ? { result_url: resultUrl } : {}),
          ...(answerRow
            ? {
                answer: {
                  body_md: clipSessionText(answerRow.body_md, ANSWER_MAX, consoleUrl),
                  meta: parseMeta(answerRow),
                  created_at: answerRow.created_at,
                },
              }
            : {}),
          ...(progressRow
            ? {
                progress: {
                  body_md: clipSessionText(progressRow.body_md, ENTRY_MAX, consoleUrl),
                  created_at: progressRow.created_at,
                },
              }
            : {}),
          ...(checkOnly
            ? {
                transcript: transcript.slice(-20).map((m) => ({
                  author: m.author_kind,
                  body_md: clipSessionText(m.body_md, ENTRY_MAX, consoleUrl),
                  created_at: m.created_at,
                })),
              }
            : {}),
          ...(note ? { note } : {}),
        })
      }

      // CHECK or FOLLOW UP an existing session.
      if (session_id) {
        if (context)
          return err(
            "Pass `context` OR `session_id`, not both — a follow-up already knows its context.",
          )
        const found = await ctx.meta.getSession(session_id)
        const linked = found ? await ctx.meta.getContext(found.context_id) : null
        // Ownership + the LIVE grant, re-checked per call (a human removed from
        // the workspace/roster loses ask-through-agent the moment they lose
        // ask-directly), and the OAuth grant's workspace clamp. Any miss reads
        // the same as a missing id — a session's existence never leaks.
        const allowed =
          !!found &&
          !!linked &&
          found.asker_id === actingFor.id &&
          inGrant(linked.org_id) &&
          (await ctx.canUserAskContext(actingFor.id, linked))
        if (!found || !linked || !allowed)
          return err(
            `No session "${session_id}" you can reach. find (a context row) shows your open sessions.`,
          )
        if (!instruction) return reply(found, linked, true)
        if (found.state === "closed")
          return err(
            "That session is closed — open a new one by passing `context` + `instruction`.",
          )
        const capped = await overAskCap()
        if (capped) return capped
        await ctx.meta.addSessionMessage(
          {
            id: newId("sm"),
            session_id: found.id,
            author_kind: "asker",
            author_id: actingFor.id,
            body_md: instruction,
          },
          "open",
        )
        // Re-read: the follow-up just flipped the session back to open.
        return reply((await ctx.meta.getSession(found.id)) ?? found, linked, false)
      }

      // GIVE: open a new session with an instruction.
      if (!context)
        return err(
          "Pass `context` (+ `instruction`) to open a session, or `session_id` to check/resume. find surfaces the contexts you can use and your open sessions.",
        )
      if (!instruction)
        return err("Opening a session needs an `instruction` — 'with this context, do this'.")
      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)
      const rows = await askableContexts(t.org, actingFor.id)
      const ref = context.trim()
      const hit =
        rows.find((r) => r.x.id === ref) ??
        rows.find((r) => r.x.name.toLowerCase() === ref.toLowerCase())
      // Naming the askable set leaks nothing (each entry is askable by this
      // human, by definition); with nothing askable there is nothing to name.
      if (!hit)
        return err(
          rows.length
            ? `No context "${context}" you can ask here. You can ask: ${rows.map((r) => r.x.name).join(", ")}.`
            : "No contexts you can ask in this workspace.",
        )
      if (!hit.manifest)
        return err(`Context "${hit.x.name}" has lost its manifest and can't be asked.`)
      const capped = await overAskCap()
      if (capped) return capped
      // Idempotency: a same-key ask still in flight JOINS the existing session
      // rather than opening a new one — a double "run for brand X" never runs twice.
      if (dedupe_key) {
        const inflight = await ctx.meta.findInflightSession(hit.x.id, dedupe_key)
        if (inflight) return reply(inflight, hit.x, false)
      }
      let opened: SessionRecord
      try {
        opened = await ctx.meta.createSession({
          id: newId("ses"),
          context_id: hit.x.id,
          org_id: hit.x.org_id,
          asker_id: actingFor.id,
          context_version: hit.manifest.current_version,
          dedupe_key,
        })
      } catch (e) {
        // Lost the create race to a concurrent same-key ask — the partial unique
        // index rejected us; join the winner. Rethrow anything else.
        const winner = dedupe_key ? await ctx.meta.findInflightSession(hit.x.id, dedupe_key) : null
        if (winner) return reply(winner, hit.x, false)
        throw e
      }
      await ctx.meta.addSessionMessage(
        {
          id: newId("sm"),
          session_id: opened.id,
          author_kind: "asker",
          author_id: actingFor.id,
          body_md: instruction,
        },
        "open",
      )
      return reply(opened, hit.x, false)
    },
  )
}
