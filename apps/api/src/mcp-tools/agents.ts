import { z } from "zod"
import type { ToolContext } from "../mcp-tool-context"
import { err, json } from "../mcp-util"

// AGENTS, ASK, JOBS, PULL: the agent model over MCP (lib/jobs.ts, routes/agents.ts,
// routes/jobs.ts). Every call goes through the REST handlers in-process under this
// connection's own bearer, so who may create, ask, manage, or run an agent is decided in one
// place. Creation is MCP-only: a coding session makes the agent here, and anything that needs
// a person in a browser comes back as a link.

type Method = "GET" | "POST" | "PATCH" | "DELETE"

const OPEN = new Set(["queued", "running"])

/** Call a route and unwrap it: the parsed body, or the route's own refusal as a tool error. */
async function call(
  tc: ToolContext,
  org: string,
  path: string,
  method: Method = "GET",
  body?: unknown,
): Promise<
  { ok: true; status: number; body: Record<string, unknown> } | { ok: false; error: string }
> {
  if (!tc.requestApi) return { ok: false, error: "This connection cannot reach agents." }
  const res = await tc.requestApi(path, method, body, org)
  if (res.status === 204) return { ok: true, status: 204, body: {} }
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok)
    return { ok: false, error: String(parsed.error ?? `Request failed (${res.status}).`) }
  return { ok: true, status: res.status, body: parsed }
}

const ScheduleArg = z
  .object({
    cron: z.string(),
    tz: z.string().optional(),
    instruction: z.string(),
  })
  .nullable()
  .optional()
  .describe("Cron schedule; null removes it.")

const SubjectArg = z
  .object({
    kind: z.enum(["artifact", "collection", "tag"]),
    id: z.string().optional(),
    tag: z.string().optional(),
  })
  .optional()
  .describe("What the work is about.")

export function registerAgentsTool(tc: ToolContext): void {
  const { server, resolveWs, wsArg, ctx } = tc
  server.registerTool(
    "agents",
    {
      description:
        "List, create, update, or delete agents. create returns runner_command (owner machine) and needs_browser links for steps a person must do. See derive://skills/agents.",
      annotations: {
        title: "Agents",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        action: z.enum(["list", "get", "create", "update", "delete"]),
        agent: z.string().optional().describe("Agent id."),
        name: z.string().optional(),
        description: z.string().optional(),
        instructions: z
          .string()
          .nullable()
          .optional()
          .describe("short_id of the instructions page. Publish it first."),
        machine: z.enum(["owner", "derive"]).optional(),
        provider: z.enum(["claude-code", "codex"]).optional(),
        model: z.string().nullable().optional(),
        schedule: ScheduleArg,
        sources: z.array(z.string()).optional().describe("Connection ids."),
        ask_policy: z.enum(["workspace", "invited"]).optional(),
        write_policy: z
          .enum(["publish", "review"])
          .optional()
          .describe(
            "review: each new version it writes to an existing page asks its person for review.",
          ),
        account_id: z.string().nullable().optional(),
        paused: z.boolean().optional(),
        workspace: wsArg,
      },
    },
    async (a) => {
      const t = await resolveWs(a.workspace)
      if ("error" in t) return err(t.error)
      const org = t.org
      if (a.action === "list") {
        const r = await call(tc, org, "/v1/agents")
        if (!r.ok) return err(r.error)
        // Hidden managed agents (one per imported paper) run nothing and are never asked.
        const agents = (r.body.agents as { id: string; managed?: boolean }[]).filter(
          (x) => !x.id.startsWith("oauth:") && !x.managed,
        )
        return json({ agents })
      }
      if (a.action === "create") {
        if (!a.name) return err("create needs a name.")
        const r = await call(tc, org, "/v1/agents", "POST", {
          name: a.name,
          description: a.description,
          instructions_short_id: a.instructions ?? undefined,
          machine: a.machine,
          provider: a.provider,
          model: a.model ?? undefined,
          ask_policy: a.ask_policy,
          write_policy: a.write_policy,
          connection_ids: a.sources,
          schedule: a.schedule ?? undefined,
        })
        if (!r.ok) return err(r.error)
        const created = r.body as { id: string; machine: string; token: string }
        const base = ctx.deps.baseUrl?.replace(/\/+$/, "") ?? "https://derive.to"
        const needs_browser: { kind: string; url: string }[] = []
        if (created.machine === "derive") {
          const acc = await call(tc, org, "/v1/accounts")
          if (acc.ok && !(acc.body.accounts as unknown[]).length)
            needs_browser.push({
              kind: "account_signin",
              url: `${base}/agents/${created.id}?tab=settings`,
            })
        }
        return json({
          ...r.body,
          ...(needs_browser.length ? { needs_browser } : {}),
          note:
            created.machine === "owner"
              ? "The key is shown once. Run runner_command on the machine that should do the work, or pull from this session."
              : "The key is shown once. Derive runs this agent; nothing to start.",
        })
      }
      if (!a.agent) return err(`${a.action} needs agent (an id from list).`)
      const path = `/v1/agents/${encodeURIComponent(a.agent)}`
      if (a.action === "get") {
        const r = await call(tc, org, path)
        return r.ok ? json(r.body) : err(r.error)
      }
      if (a.action === "delete") {
        const r = await call(tc, org, path, "DELETE")
        return r.ok ? json({ deleted: a.agent }) : err(r.error)
      }
      const patch = {
        name: a.name,
        description: a.description,
        instructions_short_id: a.instructions,
        machine: a.machine,
        provider: a.provider,
        model: a.model,
        ask_policy: a.ask_policy,
        write_policy: a.write_policy,
        connection_ids: a.sources,
        account_id: a.account_id,
        paused: a.paused,
      }
      const r = await call(tc, org, path, "PATCH", patch)
      if (!r.ok) return err(r.error)
      if (a.schedule !== undefined) {
        const cur = await call(tc, org, path)
        if (!cur.ok) return err(cur.error)
        const existing = (cur.body.triggers as { id: string; kind: string }[] | undefined)?.find(
          (x) => x.kind === "schedule",
        )
        const s =
          a.schedule === null
            ? existing
              ? await call(tc, org, `/v1/triggers/${existing.id}`, "DELETE")
              : ({ ok: true, status: 204, body: {} } as const)
            : existing
              ? await call(tc, org, `/v1/triggers/${existing.id}`, "PATCH", a.schedule)
              : await call(tc, org, `${path}/triggers`, "POST", a.schedule)
        if (!s.ok) return err(`Saved the agent, but not its schedule: ${s.error}`)
      }
      const fresh = await call(tc, org, path)
      return fresh.ok ? json(fresh.body) : json(r.body)
    },
  )
}

export function registerAskTool(tc: ToolContext): void {
  const { server, resolveWs, wsArg, ctx, ownerId } = tc
  server.registerTool(
    "ask",
    {
      description:
        "Ask an agent for work, or follow up on a job (job_id). Waits up to `wait` seconds for it to settle. See derive://skills/agents.",
      annotations: {
        title: "Ask an agent",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        agent: z.string().optional().describe("Agent id."),
        instruction: z.string(),
        job_id: z.string().optional().describe("Follow up on this job."),
        subject: SubjectArg,
        dedupe_key: z
          .string()
          .optional()
          .describe("Returns the open job with this key instead of a new one."),
        wait: tc
          .num("wait", { int: true, min: 0, max: 50 })
          .optional()
          .describe("Seconds, default 25."),
        workspace: wsArg,
      },
    },
    async (a) => {
      const t = await resolveWs(a.workspace)
      if ("error" in t) return err(t.error)
      if (!ownerId) return err("Asking an agent needs a person's connection.")
      let r: Awaited<ReturnType<typeof call>>
      if (a.job_id) {
        r = await call(tc, t.org, `/v1/jobs/${encodeURIComponent(a.job_id)}/messages`, "POST", {
          body_md: a.instruction,
        })
      } else {
        if (!a.agent) return err("ask needs agent (an id from agents list) or job_id.")
        const subject = a.subject
          ? a.subject.kind === "tag"
            ? { kind: "tag", tag: a.subject.tag ?? a.subject.id }
            : { kind: a.subject.kind, id: a.subject.id }
          : undefined
        r = await call(tc, t.org, "/v1/jobs", "POST", {
          agent_id: a.agent,
          instruction: a.instruction,
          subject,
          dedupe_key: a.dedupe_key,
        })
      }
      if (!r.ok) return err(r.error)
      let job = r.body as { id: string; status: string }
      // Wait out the runner while the job is open. The event is only a wake: every exit
      // re-reads, so a missed or raced wake is never a wrong answer.
      const deadline = Date.now() + (a.wait ?? 25) * 1000
      while (OPEN.has(job.status) && ctx.bus.waitFor) {
        const left = deadline - Date.now()
        if (left <= 0) break
        const release = new AbortController()
        const woke = ctx.bus
          .waitFor(`u:${ownerId}`, ["job.settled", "job.progress"], left, release.signal)
          .catch(() => null)
        const fresh = await call(tc, t.org, `/v1/jobs/${job.id}`)
        if (fresh.ok) job = fresh.body as typeof job
        if (!OPEN.has(job.status)) {
          release.abort()
          await woke
          break
        }
        const e = (await woke) as { type?: string; job_id?: string } | null
        const again = await call(tc, t.org, `/v1/jobs/${job.id}`)
        if (again.ok) job = again.body as typeof job
        if (!e || (e.type === "job.progress" && e.job_id === job.id)) break
      }
      return json({
        ...job,
        ...(OPEN.has(job.status)
          ? { note: "Still open. Check it with jobs({job_id}) or ask again with job_id and wait." }
          : {}),
      })
    },
  )
}

export function registerJobsTool(tc: ToolContext): void {
  const { server, resolveWs, wsArg } = tc
  server.registerTool(
    "jobs",
    {
      description:
        "List or inspect agent jobs; cancel, retry, or answer one. See derive://skills/agents.",
      annotations: {
        title: "Jobs",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        job_id: z.string().optional().describe("Omit to list."),
        action: z.enum(["cancel", "retry", "answer"]).optional(),
        text: z.string().optional(),
        option: z.string().optional().describe("One of needs.options."),
        agent: z.string().optional(),
        status: z
          .array(
            z.enum(["queued", "running", "needs_you", "succeeded", "failed", "cancelled", "lost"]),
          )
          .optional(),
        workspace: wsArg,
      },
    },
    async (a) => {
      const t = await resolveWs(a.workspace)
      if ("error" in t) return err(t.error)
      if (a.job_id) {
        const id = encodeURIComponent(a.job_id)
        const r = a.action
          ? await call(
              tc,
              t.org,
              `/v1/jobs/${id}/${a.action}`,
              "POST",
              a.action === "answer" ? { text: a.text, option: a.option } : {},
            )
          : await call(tc, t.org, `/v1/jobs/${id}`)
        return r.ok ? json(r.body) : err(r.error)
      }
      if (a.action) return err(`${a.action} needs job_id.`)
      const q = new URLSearchParams()
      if (a.agent) q.set("agent", a.agent)
      if (a.status?.length) q.set("status", a.status.join(","))
      q.set("limit", "50")
      const r = await call(tc, t.org, `/v1/jobs?${q}`)
      return r.ok ? json(r.body) : err(r.error)
    },
  )
}

export function registerPullTool(tc: ToolContext): void {
  const { server, resolveWs, wsArg, registered, agent: self } = tc
  server.registerTool(
    "pull",
    {
      description:
        "Run an owner agent from this session: claim its jobs, then send report for each, echoing started_at. See derive://skills/agents.",
      annotations: {
        title: "Pull agent work",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        agent: z.string().optional().describe("Defaults to this agent key's own."),
        limit: tc.num("limit", { int: true, min: 1, max: 20 }).optional(),
        report: z
          .object({
            job_id: z.string(),
            started_at: z.string(),
            status: z.enum(["succeeded", "failed", "needs_you", "progress"]),
            body_md: z.string().optional(),
            needs: z
              .object({
                kind: z.enum(["review", "decision", "escalation"]).default("decision"),
                question: z.string(),
                options: z.array(z.string()).optional(),
              })
              .optional(),
            cost_micro_usd: tc.num("cost_micro_usd", { int: true, min: 0 }).optional(),
            retryable: z.boolean().optional(),
            report_artifact_id: z.string().optional(),
          })
          .optional()
          .describe("Settle or tick a pulled job."),
        workspace: wsArg,
      },
    },
    async (a) => {
      const t = await resolveWs(a.workspace)
      if ("error" in t) return err(t.error)
      if (a.report) {
        const { job_id, ...rest } = a.report
        const r = await call(
          tc,
          t.org,
          `/v1/jobs/${encodeURIComponent(job_id)}/report`,
          "POST",
          rest,
        )
        return r.ok ? json(r.body) : err(r.error)
      }
      const id = a.agent ?? (registered ? self.id : undefined)
      if (!id) return err("pull needs agent (an id from agents list).")
      const r = await call(tc, t.org, `/v1/agents/${encodeURIComponent(id)}/pull`, "POST", {
        limit: a.limit,
      })
      if (!r.ok) return err(r.error)
      const jobs = r.body.jobs as unknown[]
      return json(
        jobs.length
          ? r.body
          : {
              jobs,
              note: "Nothing queued. Pull again later; each pull also counts as the agent being online.",
            },
      )
    },
  )
}
