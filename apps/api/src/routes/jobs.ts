import { refRouter } from "@derive/broker"
import { type AgentRecord, type JobRecord, normalizeSelectors, type Selector } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import {
  brokerFor,
  callTool,
  mcpAuthFor,
  parseConnectionIds,
  type SourceQuiet,
  spendableConnections,
  toolsForRun,
} from "../lib/broker"
import { readEnvironmentBindings } from "../lib/context-environment"
import { decryptSecret } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"
import { resolveJobCredential } from "../lib/job-accounts"
import {
  answerJob,
  askAgent,
  canAskAgent,
  cancelJob,
  canManageAgent,
  canSteerJob,
  followUpJob,
  jobJson,
  pullJobs,
  reportJob,
  retryJob,
} from "../lib/jobs"

// JOBS: the one unit of agent work (lib/jobs.ts). Two audiences:
//
//   people (and their MCP grants) ask an agent, follow a job, answer it, cancel or retry it;
//   runners (an agent's own bearer) pull work, report on it, and fetch the environment,
//   account, and tools the job they hold is entitled to.
//
// A runner may only touch jobs that belong to its own agent and are running under its claim.

const SelectorSchema = z.union([
  z.string(),
  z.object({ kind: z.literal("artifact"), id: z.string() }).passthrough(),
  z.object({ kind: z.literal("tag"), tag: z.string() }).passthrough(),
  z.object({ kind: z.literal("collection"), id: z.string() }).passthrough(),
])

const SubjectSchema = z.union([
  z.object({ kind: z.literal("artifact"), id: z.string() }),
  z.object({ kind: z.literal("collection"), id: z.string() }),
  z.object({ kind: z.literal("tag"), tag: z.string() }),
])

const JobNeedsSchema = z.object({
  kind: z.enum(["review", "decision", "escalation", "effect"]),
  question: z.string(),
  options: z.array(z.string()).optional(),
  review_round_id: z.string().optional(),
})

const JobEffectSchema = z.object({
  kind: z.enum(["page", "pr", "email", "rows", "other"]),
  label: z.string(),
  ref: z.string().optional(),
  version: z.number().optional(),
  url: z.string().optional(),
})

const JobResultSchema = z.object({
  effects: z.array(JobEffectSchema).optional(),
  evidence: z
    .array(z.object({ label: z.string(), url: z.string().optional(), ref: z.string().optional() }))
    .optional(),
  failure: z.object({ reason: z.string(), retryable: z.boolean() }).optional(),
  route: z
    .array(
      z.object({
        node_id: z.string(),
        attempt: z.number(),
        selected: z.array(z.string()).optional(),
        decision: z.string().optional(),
      }),
    )
    .optional(),
})

const Job = z
  .object({
    id: z.string(),
    agent_id: z.string(),
    kind: z.enum(["ask", "scheduled", "graph", "node"]),
    status: z.enum(["queued", "running", "needs_you", "succeeded", "failed", "cancelled", "lost"]),
    instruction: z.string(),
    asked_by: z.string().nullable(),
    attended: z.boolean(),
    parent_id: z.string().nullable(),
    node_id: z.string().nullable(),
    trigger_id: z.string().nullable(),
    subject: SubjectSchema.nullable(),
    needs: JobNeedsSchema.nullable(),
    result: JobResultSchema,
    scheduled_for: z.string().nullable(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    lease_until: z.string().nullable(),
    attempt: z.number(),
    cost_micro_usd: z.number().nullable(),
    report_artifact_id: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Job")

const JobMessage = z
  .object({
    id: z.string(),
    author_kind: z.enum(["asker", "agent"]),
    author_id: z.string(),
    body_md: z.string(),
    progress: z.boolean(),
    created_at: z.string(),
  })
  .openapi("JobMessage")

const JobDetail = Job.extend({ messages: z.array(JobMessage) }).openapi("JobDetail")

const STATUSES = [
  "queued",
  "running",
  "needs_you",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
] as const
const KINDS = ["ask", "scheduled", "graph", "node"] as const

export const jobRoutes = (ctx: AppContext) => {
  const { meta, deps, agentFor, actingHuman } = ctx
  const app = new OpenAPIHono<BlankEnv>()
  const jobDeps = { meta, bus: ctx.backplane }

  const messageJson = (m: {
    id: string
    author_kind: "asker" | "agent"
    author_id: string
    body_md: string
    meta_json: string | null
    created_at: string
  }) => ({
    id: m.id,
    author_kind: m.author_kind,
    author_id: m.author_id,
    body_md: m.body_md,
    progress:
      !!m.meta_json && (JSON.parse(m.meta_json) as { progress?: boolean }).progress === true,
    created_at: m.created_at,
  })

  /** The person behind a request and whether they may see this job's workspace. Jobs are
   *  visible to every member of the agent's workspace: the work an agent does for one person
   *  is work the team can see, like the pages it publishes. */
  const personFor = async (c: Context) => {
    const who = await actingHuman(c)
    if (!who) return fail(c, 401, "unauthenticated")
    return who
  }
  const visibleJob = async (c: Context, id: string): Promise<JobRecord | Response> => {
    const who = await personFor(c)
    if (who instanceof Response) return who
    // The active workspace, which a grant scoped to other workspaces cannot name.
    const org = await ctx.requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const job = await meta.getJob(id)
    if (!job || job.org_id !== org || !(await meta.getMembership(org, who.id)))
      return fail(c, 404, "not found")
    return job
  }

  // ---- People ---------------------------------------------------------------------------

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/jobs",
      tags: ["Jobs"],
      summary: "List jobs in the active workspace, newest first.",
      request: {
        query: z.object({
          agent: z.string().optional(),
          status: z.string().optional().describe("Comma-separated statuses."),
          kind: z.string().optional().describe("Comma-separated kinds."),
          parent: z.string().optional(),
          before: z.string().optional().describe("Keyset cursor: created_at of the last row seen."),
          limit: z.string().optional(),
        }),
      },
      responses: {
        200: {
          description: "Jobs.",
          content: { "application/json": { schema: z.object({ jobs: z.array(Job) }) } },
        },
      },
    }),
    async (c) => {
      const org = await ctx.requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)
      const q = c.req.query()
      const split = <T extends string>(v: string | undefined, allowed: readonly T[]) =>
        v
          ? v.split(",").filter((s): s is T => (allowed as readonly string[]).includes(s))
          : undefined
      const jobs = await meta.listJobs({
        orgId: org,
        agentId: q.agent || undefined,
        status: split(q.status, STATUSES),
        kind: split(q.kind, KINDS),
        parentId: q.parent || undefined,
        before: q.before || undefined,
        limit: Math.min(200, Number(q.limit) || 50),
      })
      return c.json({ jobs: jobs.map(jobJson) })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/jobs",
      tags: ["Jobs"],
      summary:
        "Ask an agent to do something. Opens a job (or returns the open one for a dedupe key).",
      responses: {
        201: {
          description: "The new job.",
          content: { "application/json": { schema: JobDetail } },
        },
        200: {
          description: "An open job already holding this dedupe key.",
          content: { "application/json": { schema: JobDetail } },
        },
      },
    }),
    async (c) => {
      const who = await personFor(c)
      if (who instanceof Response) return bail(who)
      const b = await readJson(
        c,
        z.object({
          agent_id: z.string().min(1),
          instruction: z.string().trim().min(1).max(20_000),
          subject: SelectorSchema.nullish(),
          dedupe_key: z.string().min(1).max(200).nullish(),
        }),
      )
      if (b instanceof Response) return bail(b)
      const agent = await meta.getAgent(b.agent_id)
      if (!agent || !(await canAskAgent(meta, agent, who.id)))
        return bail(fail(c, 404, "no such agent you can ask"))
      // A bearer agent may ask another agent in its own workspace only.
      const caller = await agentFor(c)
      if (caller && caller.org_id !== agent.org_id)
        return bail(fail(c, 404, "no such agent you can ask"))
      const subject: Selector | null = b.subject
        ? (normalizeSelectors([b.subject])[0] ?? null)
        : null
      const { job, created } = await askAgent(jobDeps, {
        agent,
        askedBy: who.id,
        instruction: b.instruction,
        subject,
        dedupeKey: b.dedupe_key ?? null,
      })
      const messages = (await meta.listJobMessages(job.id)).map(messageJson)
      const body = { ...jobJson(job), messages }
      return created ? c.json(body, 201) : c.json(body, 200)
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/jobs/{id}",
      tags: ["Jobs"],
      summary: "One job with its transcript.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "The job.", content: { "application/json": { schema: JobDetail } } },
      },
    }),
    async (c) => {
      const job = await visibleJob(c, c.req.param("id"))
      if (job instanceof Response) return bail(job)
      const messages = (await meta.listJobMessages(job.id)).map(messageJson)
      return c.json({ ...jobJson(job), messages })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/jobs/{id}/messages",
      tags: ["Jobs"],
      summary: "Write to a job. Running: appended for the next turn. Settled: the job reopens.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "The job.", content: { "application/json": { schema: JobDetail } } },
      },
    }),
    async (c) => {
      const job = await visibleJob(c, c.req.param("id"))
      if (job instanceof Response) return bail(job)
      const who = await personFor(c)
      if (who instanceof Response) return bail(who)
      const agent = await meta.getAgent(job.agent_id)
      if (!agent || !(await canSteerJob(meta, agent, job, who.id)))
        return bail(
          fail(c, 403, "only the person who asked, or the agent's manager, can follow up"),
        )
      if (job.status === "cancelled") return bail(fail(c, 409, "this job was cancelled; ask again"))
      const b = await readJson(c, z.object({ body_md: z.string().trim().min(1).max(20_000) }))
      if (b instanceof Response) return bail(b)
      const next = await followUpJob(jobDeps, job, who.id, b.body_md)
      const messages = (await meta.listJobMessages(job.id)).map(messageJson)
      return c.json({ ...jobJson(next), messages })
    },
  )

  const personAction = (
    path: string,
    summary: string,
    act: (
      job: JobRecord,
      c: Context,
      whoId: string,
    ) => Promise<JobRecord | null | { error: string }>,
  ) =>
    app.openapi(
      createRoute({
        method: "post",
        path,
        tags: ["Jobs"],
        summary,
        request: { params: z.object({ id: z.string() }) },
        responses: {
          200: { description: "The job.", content: { "application/json": { schema: Job } } },
        },
      }),
      async (c) => {
        const job = await visibleJob(c, c.req.param("id") ?? "")
        if (job instanceof Response) return bail(job)
        const who = await personFor(c)
        if (who instanceof Response) return bail(who)
        const agent = await meta.getAgent(job.agent_id)
        if (!agent || !(await canSteerJob(meta, agent, job, who.id)))
          return bail(
            fail(c, 403, "only the person who asked, or the agent's manager, can do that"),
          )
        const out = await act(job, c, who.id)
        if (!out) return bail(fail(c, 409, "this job cannot do that from where it is"))
        if ("error" in out) return bail(fail(c, 400, out.error))
        return c.json(jobJson(out))
      },
    )
  personAction("/v1/jobs/{id}/cancel", "Cancel an open job (and its children).", (job) =>
    cancelJob(jobDeps, job),
  )
  personAction("/v1/jobs/{id}/retry", "Run a failed or lost job again.", (job) =>
    retryJob(jobDeps, job),
  )
  personAction(
    "/v1/jobs/{id}/answer",
    "Answer a job that is waiting on a person.",
    async (job, c, whoId) => {
      const b = await readJson(
        c,
        z.object({
          text: z.string().max(20_000).optional(),
          option: z.string().max(200).optional(),
        }),
      )
      if (b instanceof Response) return { error: "answer needs text or an option" }
      return answerJob(jobDeps, job, whoId, b)
    },
  )

  // ---- Runners -----------------------------------------------------------------------------
  //
  // Plain routes (runner protocol, not the product API). The bearer is the agent itself.

  /** The agent a runner acts as for `agentId`: the agent's own key, or a person's own coding
   *  session (an MCP grant) running an `owner`-machine agent they manage. That second door is
   *  the MCP `pull` tool; it goes through these same routes so the fences live in one place. */
  const runnerFor = async (c: Context, agentId: string): Promise<AgentRecord | Response> => {
    const a = await agentFor(c)
    if (!a) return fail(c, 401, "an agent key is required")
    // A capability token minted for one old-lane run or session is not a runner for the
    // agent's other work.
    if (ctx.agentRunScope(c) || ctx.agentSessionScope(c) || ctx.agentWorkflowScope(c))
      return fail(c, 403, "this token is scoped to other work")
    if (a.id === agentId && !a.id.startsWith("oauth:")) return a
    if (a.id.startsWith("oauth:")) {
      // Only the agent's own creator's session may run it: whoever runs a job holds the
      // credential and environment it runs with.
      const who = await actingHuman(c)
      const target = await meta.getAgent(agentId)
      if (
        who &&
        target &&
        target.machine === "owner" &&
        target.org_id === a.org_id &&
        target.created_by === who.id &&
        (await canManageAgent(meta, target, who.id))
      )
        return target
    }
    return fail(c, 403, "a runner works only its own agent's jobs")
  }
  /** The job this runner holds right now, or the refusal. */
  const heldJob = async (
    c: Context,
  ): Promise<{ agent: AgentRecord; job: JobRecord } | Response> => {
    const job = await meta.getJob(c.req.param("id") ?? "")
    if (!job) return fail(c, 404, "not found")
    const agent = await runnerFor(c, job.agent_id)
    if (agent instanceof Response) return agent.status === 403 ? fail(c, 404, "not found") : agent
    if (job.org_id !== agent.org_id) return fail(c, 404, "not found")
    if (job.status !== "running") return fail(c, 409, "this job is not running")
    const claim = c.req.header("x-derive-claim") ?? c.req.query("claim")
    if (claim !== job.started_at) return fail(c, 409, "this claim has been superseded")
    return { agent, job }
  }

  /** What a runner needs to do one job, besides secrets: the transcript, the agent's
   *  instructions, and the tools its sources grant. */
  const payload = async (agent: AgentRecord, jobs: JobRecord[]) => {
    let instructions: { short_id: string; version: number; body_md: string } | null = null
    if (agent.instructions_artifact_id) {
      const art = await meta.getArtifactById(agent.instructions_artifact_id).catch(() => null)
      const v = art ? await meta.getVersion(art.id, art.current_version) : null
      const body = v ? await ctx.sourceText(v) : null
      if (art && body != null)
        instructions = { short_id: art.short_id, version: art.current_version, body_md: body }
    }
    const connIds = parseConnectionIds(agent.connection_ids_json)
    const quiet: SourceQuiet[] = []
    let tools: { def: unknown; ref: string }[] = []
    if (connIds.length && jobs.length) {
      const broker = await brokerFor(
        meta,
        agent.org_id,
        null,
        deps.encryptionKey,
        deps.allowEchoStub,
      )
      const route = refRouter(broker, mcpAuthFor(meta, agent.org_id, deps.encryptionKey))
      tools = (
        await toolsForRun(meta, broker, agent.org_id, connIds, route, deps.encryptionKey, quiet)
      ).map((t) => ({
        def: t.def,
        ref: t.ref,
      }))
    }
    return Promise.all(
      jobs.map(async (j) => ({
        ...jobJson(j),
        messages: (await meta.listJobMessages(j.id)).map(messageJson),
        instructions,
        execution: { provider: agent.provider, model: agent.model },
        tools,
        ...(quiet.length ? { sources_quiet: quiet } : {}),
      })),
    )
  }

  app.post("/v1/agents/:id/pull", async (c) => {
    const agent = await runnerFor(c, c.req.param("id"))
    if (agent instanceof Response) return agent
    const b = await readJson(
      c,
      z.object({ limit: z.number().int().min(1).max(20).optional() }).default({}),
    )
    if (b instanceof Response) return b
    const jobs = await pullJobs(jobDeps, agent, { limit: b.limit ?? 10 })
    return c.json({ jobs: await payload(agent, jobs) })
  })

  app.post("/v1/jobs/:id/report", async (c) => {
    const held = await meta.getJob(c.req.param("id"))
    if (!held) return fail(c, 404, "not found")
    const agent = await runnerFor(c, held.agent_id)
    if (agent instanceof Response) return agent.status === 403 ? fail(c, 404, "not found") : agent
    const b = await readJson(
      c,
      z.object({
        started_at: z.string().nullable(),
        status: z.enum(["succeeded", "failed", "needs_you", "progress"]),
        body_md: z.string().max(200_000).nullish(),
        result: JobResultSchema.nullish(),
        needs: JobNeedsSchema.nullish(),
        cost_micro_usd: z.number().int().nonnegative().nullish(),
        retryable: z.boolean().optional(),
        meta: z.record(z.string(), z.unknown()).nullish(),
        report_artifact_id: z.string().nullish(),
      }),
    )
    if (b instanceof Response) return b
    const out = await reportJob(jobDeps, agent, c.req.param("id"), b)
    if ("error" in out) return fail(c, out.status as 404 | 409, out.error)
    return c.json({ job: jobJson(out.job) })
  })

  app.get("/v1/jobs/:id/environment", async (c) => {
    c.header("Cache-Control", "no-store")
    const held = await heldJob(c)
    if (held instanceof Response) return held
    const { agent, job } = held
    const bindings = readEnvironmentBindings(agent.environment_json)
    const ids = [...new Set(Object.values(bindings))]
    if (!ids.length) return c.json({ environment: {} })
    if (!deps.encryptionKey) return fail(c, 503, "Secret encryption is not configured")
    const byId = new Map(
      (await spendableConnections(meta, agent.org_id, ids)).map((cn) => [cn.id, cn]),
    )
    const environment: Record<string, string> = {}
    for (const [name, id] of Object.entries(bindings)) {
      const cn = byId.get(id)
      if (cn?.kind !== "secret" || !cn.secret_enc)
        return fail(c, 409, `Environment variable ${name} is unavailable`)
      const value = decryptSecret(cn.secret_enc, deps.encryptionKey)
      if (value === cn.secret_enc)
        return fail(c, 503, `Environment variable ${name} could not be decrypted`)
      environment[name] = value
    }
    return c.json({ environment })
  })

  app.get("/v1/jobs/:id/account", async (c) => {
    c.header("Cache-Control", "no-store")
    const held = await heldJob(c)
    if (held instanceof Response) return held
    const { agent, job } = held
    const provider = c.req.query("provider") === "codex" ? "codex" : agent.provider
    const cred = await resolveJobCredential(meta, deps.encryptionKey, agent, job, provider)
    return c.json(cred)
  })

  // authz-exempt: heldJob gates on the runner owning this job (agent key or managing grant).
  app.post("/v1/jobs/:id/tool", async (c) => {
    const held = await heldJob(c)
    if (held instanceof Response) return held
    const { agent, job } = held
    const b = await readJson(
      c,
      z.object({
        tool: z.string().max(200),
        args: z.unknown().optional(),
        ref: z.string().max(200).optional(),
      }),
    )
    if (b instanceof Response) return b
    const connIds = parseConnectionIds(agent.connection_ids_json)
    if (connIds.length === 0) return fail(c, 403, "this agent has no sources")
    const broker = await brokerFor(meta, agent.org_id, null, deps.encryptionKey, deps.allowEchoStub)
    const route = refRouter(broker, mcpAuthFor(meta, agent.org_id, deps.encryptionKey))
    const allowed = await toolsForRun(meta, broker, agent.org_id, connIds, route)
    const out = await callTool({
      meta,
      broker,
      route,
      orgId: agent.org_id,
      encryptionKey: deps.encryptionKey,
      allowed,
      subject: "this job",
      tool: b.tool,
      args: b.args,
      ref: b.ref,
    })
    return out.ok ? c.json({ result: out.result }) : fail(c, out.status, out.message)
  })

  return app
}
