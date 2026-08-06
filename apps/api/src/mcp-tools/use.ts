import { type ContextRecord, newId, type SessionRecord } from "@derive/core"
import { z } from "zod"
import { cardForWire } from "../lib/builder-card"
import { canPayForAgent, NO_PAYER_MESSAGE } from "../lib/payer"
import type { ToolContext } from "../mcp-tool-context"
import { ANSWER_MAX, clipSessionText, ENTRY_MAX, err, json, runnerOnline } from "../mcp-util"
import { ownerRunsOrg, runnerDispatch } from "./use-runner"

// USE A CONTEXT — query a workspace's live data agents ------------------------
// Contexts are askable agent setups (a registered agent wired to a manifest, answering
// through an owner-run runner). `use` is the agent-side surface, acting FOR the
// connection's on-behalf human: the human's own ask-grant (membership + ask_policy/
// roster, re-checked per call via canUserAskContext) is the ONLY gate, so an agent can
// reach exactly what its human can, and nothing more. Discovery is `find` (contexts ride
// the browse/search results); a connection with no known human is refused at call time.
// Management lives on `automate` (create_context), owner grants only; rewire/delete
// deliberately stay REST. (askableContexts / runnerOnline live in mcp-tool-context /
// mcp-util — shared with find's context rows.)

const NO_HUMAN =
  "Using a context opens a session on a human's behalf, and this connection has no acting human. " +
  "Reconnect with an OAuth login (or a token registered by a user) to use one."

export function registerUseTool(tc: ToolContext): void {
  const { server, ctx, actingFor, askableContexts, inGrant, resolveWs, wsArg } = tc

  // (Listing the askable contexts now lives in `find` — they ride the browse/search rows.)

  server.registerTool(
    "use",
    {
      description:
        "Give a context WORK (rate-limited): `context`+`instruction` opens a session, `session_id`+`instruction` follows up, `session_id` alone checks. Real runs take minutes, so a still-working response is NORMAL — re-call until it settles. See derive://skills/contexts.",
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
            "'With this context, do this' (Markdown) — a question or a task, always naming the target.",
          ),
        session_id: z
          .string()
          .optional()
          .describe(
            "An existing session of yours (from an earlier use, or a find context row) to follow up on or check.",
          ),
        wait: z.coerce
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("Seconds to wait for a tick or the answer (default 25; 0 returns at once)."),
        dedupe_key: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "OPEN mode: an idempotency key — a second use with the same key JOINS the in-flight session.",
          ),
        answer: z
          .string()
          .trim()
          .min(1)
          .max(20_000)
          .optional()
          .describe("RUN mode: your reply on a session you run."),
        progress: z
          .boolean()
          .optional()
          .describe(
            "RUN mode: a non-settling progress tick; streams `answer` without ending the session.",
          ),
        state: z
          .enum(["answered", "escalated", "failed"])
          .optional()
          .describe("RUN mode: the terminal state. Omit for a plain answered result."),
        result_artifact_id: z
          .string()
          .optional()
          .describe(
            "RUN mode: the session's result artifact short_id — the stable link the requester sees.",
          ),
        answers: z
          .string()
          .optional()
          .describe("RUN mode: the requester-message id this addresses."),
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
      // RUN MODE — dispatched by ownership: a registered agent on a context it is the
      // AGENT FOR (needs no acting human — it acts as itself), or OWNER-RUN, a grant
      // whose human holds the owner seat in the context's workspace. runnerDispatch
      // handles REPORT/PULL and returns a result, or null when this isn't a runner op,
      // so it falls through to the give path below and every other grant's surface is
      // unchanged. (See mcp-tools/use-runner.ts.)
      {
        const ran = await runnerDispatch(tc, {
          context,
          instruction,
          session_id,
          answer,
          progress,
          state,
          result_artifact_id,
          answers,
          workspace,
        })
        if (ran) return ran
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
            const parsed = JSON.parse(row.meta) as { card?: unknown }
            // A builder card is stored WHOLE — the manifest source, the document already
            // published for it — and stripped wherever it reaches a caller (lib/builder-card.ts,
            // the same call messageJson in routes/contexts.ts makes). A builder session names no
            // context, so it cannot be reached through `use` today; this holds the rule at the
            // boundary rather than on that argument staying true.
            return parsed?.card ? { ...parsed, card: cardForWire(parsed.card) } : parsed
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
        // A queue with no live runner is a dead end for most askers — but its OWNER can
        // just serve it (owner-run), so steer them there instead of telling them to wait.
        // Registered agents keep the wait text: their bare use({context}) pull only
        // reaches contexts they are the agent for.
        const note =
          s.state === "open"
            ? runnerOnline(x)
              ? "Queued — re-call use with this session_id (+ wait) to collect the answer."
              : (await ownerRunsOrg(tc, x.org_id))
                ? `Queued, and no runner is polling this context's queue — but you own this workspace, so you can serve it yourself: use({context: "${x.name}"}) with no instruction pulls the queued work (see derive://skills/contexts).`
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
        const linked = found?.context_id ? await ctx.meta.getContext(found.context_id) : null
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
        // A follow-up mid-run must NOT vacate an active claim, and reopening must not race a
        // concurrent settle. appendFollowupReopen does both in one atomic compare-and-set: a
        // `working` session stays working (the runner sees the turn on re-read, and its
        // stale-turn guard re-serves it after replying), so a second runner can't claim it;
        // a settled/open one goes to `open`, dropping the dedupe key on the settled path so it
        // can't collide with a newer same-key session. Reading live state inside the UPDATE
        // closes the window a read-then-write would leave (stranding it `working`, no runner).
        await ctx.meta.appendFollowupReopen({
          id: newId("sm"),
          session_id: found.id,
          author_kind: "asker",
          author_id: actingFor.id,
          body_md: instruction,
        })
        // Re-read: the follow-up flipped the session (working stays working; else open).
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
        const inflight = await ctx.meta.findInflightSession(hit.x.id, actingFor.id, dedupe_key)
        if (inflight) return reply(inflight, hit.x, false)
      }
      // PAYER guard, mirroring the REST ask (routes/contexts.ts): the asker pays, then
      // owner-lend, then the pool. After the dedupe join for the same reason — joining an
      // open session creates no new work.
      if (
        !(await canPayForAgent(ctx.meta, {
          orgId: hit.x.org_id,
          agentId: hit.x.agent_id,
          initiator: { userId: actingFor.id, source: "asker" },
        }))
      )
        return err(NO_PAYER_MESSAGE)
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
        // Lost the create race to this asker's own concurrent same-key ask — the partial
        // unique index rejected us; join the winner. Rethrow anything else.
        const winner = dedupe_key
          ? await ctx.meta.findInflightSession(hit.x.id, actingFor.id, dedupe_key)
          : null
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
