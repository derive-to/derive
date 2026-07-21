import { type ContextRecord, newId, type SessionRecord } from "@derive/core"
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
  const { server, ctx, actingFor, askableContexts, inGrant, resolveWs, wsArg } = tc

  server.registerTool(
    "use",
    {
      description:
        "Use a context (a live data agent — discover them with find) ON YOUR USER'S BEHALF " +
        "(rate-limited): ask it a question or hand it a commission — one session. OPEN: `context` " +
        "(id or name) + `question`. FOLLOW UP: `session_id` + `question`. CHECK/RESUME: `session_id` " +
        "alone. The call waits up to `wait` seconds (default 25) for the answer; real runs often " +
        "take minutes, so a still-open response is NORMAL, not an error — re-call with the returned " +
        "session_id until it settles. For the modes and wait semantics, read derive://skills/contexts.",
      inputSchema: {
        context: z
          .string()
          .optional()
          .describe(
            "The context to use — its id or name from a find context row. Opens a NEW session; omit when passing session_id.",
          ),
        question: z
          .string()
          .trim()
          .min(1)
          .max(20_000)
          .optional()
          .describe(
            "Your question (Markdown). With `context` it opens a session; with `session_id` it is a follow-up turn. Omit it to just check a session.",
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
            "Seconds to wait for the runner's answer before returning (default 25; 0 = return at once). An expired wait leaves the session open — re-call with session_id.",
          ),
        workspace: wsArg,
      },
    },
    async ({ context, question, session_id, wait, workspace }) => {
      if (!actingFor) return err(NO_HUMAN)
      // Session WRITES are capped per acting human — each one triggers a model
      // run on the context owner's runner, so a looping agent is the realistic
      // flood. The check mode is a read and stays uncapped.
      const overAskCap = async () => {
        if (!ctx.askLimiter) return null
        const r = await ctx.askLimiter(`id:${actingFor.id}`)
        return r.ok ? null : err(`Rate limit exceeded — retry in ${r.retryAfter}s.`)
      }

      // Every mode ends here: wait out the runner while the session is open,
      // then shape the reply from a FRESH read — the event is only a wake
      // (check_requests' pattern), so a missed/raced wake is never a wrong
      // answer. The channel wakes for ANY of this human's sessions settling;
      // the loop re-checks ours and waits out the remainder.
      const reply = async (start: SessionRecord, x: ContextRecord, checkOnly: boolean) => {
        let s = start
        const deadline = Date.now() + Math.min(Math.max(wait ?? 25, 0), 50) * 1000
        while (s.state === "open" && ctx.bus.waitFor) {
          const left = deadline - Date.now()
          if (left <= 0) break
          const release = new AbortController()
          const woke = ctx.bus
            .waitFor(`u:${actingFor.id}`, ["session.settled"], left, release.signal)
            .catch(() => null)
          // Close the check-then-wait gap: the settle may have landed since the
          // last read, before our subscription existed.
          const fresh = await ctx.meta.getSession(s.id)
          if (fresh && fresh.state !== "open") {
            release.abort()
            await woke
            s = fresh
            break
          }
          const e = await woke
          s = (await ctx.meta.getSession(s.id)) ?? s
          if (!e) break // timed out — s holds one last fresh read
        }

        const transcript = await ctx.meta.listSessionMessages(s.id)
        const answerRow =
          s.state !== "open"
            ? transcript.filter((m) => m.author_kind === "agent").at(-1)
            : undefined
        // Stored as TEXT (see ports); a hand-edited row must not 500 the tool —
        // unparseable meta reads as absent, the same tolerance the route shows.
        let answerMeta: unknown = null
        if (answerRow?.meta) {
          try {
            answerMeta = JSON.parse(answerRow.meta)
          } catch {
            answerMeta = null
          }
        }
        const note =
          s.state === "open"
            ? runnerOnline(x)
              ? "Still thinking — real runs take minutes. Re-call use with this session_id (+ wait) to collect the answer."
              : "Queued, but the context's runner looks OFFLINE — it answers when it comes back. Re-call use with this session_id later."
            : s.state === "escalated"
              ? "The runner escalated this to a human — a draft went to review. Check back later."
              : s.state === "failed"
                ? "The run crashed; the context's owner sees the failure. You can ask again."
                : s.state === "closed"
                  ? "This session was closed."
                  : undefined
        const consoleUrl = `${ctx.deps.baseUrl.replace(/\/$/, "")}/contexts/${x.id}`
        return json({
          session_id: s.id,
          context: x.name,
          state: s.state,
          ...(answerRow
            ? {
                answer: {
                  body_md: clipSessionText(answerRow.body_md, ANSWER_MAX, consoleUrl),
                  meta: answerMeta,
                  created_at: answerRow.created_at,
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
        if (!question) return reply(found, linked, true)
        if (found.state === "closed")
          return err("That session is closed — open a new one by passing `context` + `question`.")
        const capped = await overAskCap()
        if (capped) return capped
        await ctx.meta.addSessionMessage(
          {
            id: newId("sm"),
            session_id: found.id,
            author_kind: "asker",
            author_id: actingFor.id,
            body_md: question,
          },
          "open",
        )
        // Re-read: the follow-up just flipped the session back to open.
        return reply((await ctx.meta.getSession(found.id)) ?? found, linked, false)
      }

      // OPEN a new session.
      if (!context)
        return err(
          "Pass `context` (+ `question`) to open a session, or `session_id` to check/resume. find surfaces the contexts you can use and your open sessions.",
        )
      if (!question) return err("Opening a session needs a `question`.")
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
      const opened = await ctx.meta.createSession({
        id: newId("ses"),
        context_id: hit.x.id,
        org_id: hit.x.org_id,
        asker_id: actingFor.id,
        context_version: hit.manifest.current_version,
      })
      await ctx.meta.addSessionMessage(
        {
          id: newId("sm"),
          session_id: opened.id,
          author_kind: "asker",
          author_id: actingFor.id,
          body_md: question,
        },
        "open",
      )
      return reply(opened, hit.x, false)
    },
  )
}
