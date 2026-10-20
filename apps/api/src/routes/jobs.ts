import { refRouter } from "@derive/broker"
import {
  type AgentRecord,
  capRole,
  DERIVE_AGENT_ID,
  type JobNeeds,
  type JobRecord,
  newId,
  normalizeSelectors,
  parseAgentSandbox,
  roleAllows,
  type Selector,
} from "@derive/core"
import {
  checkpointProblem,
  RUNNER_PROTOCOL_VERSION,
  SESSION_TMUX,
  TASK_REPO,
  taskOptions,
} from "@derive-to/cli/conversation-format"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import {
  bearerFor,
  brokerFor,
  callTool,
  mcpAuthFor,
  parseConnectionIds,
  type SourceQuiet,
  spendableConnections,
  toolsForRun,
} from "../lib/broker"
import { OVER_BUDGET } from "../lib/budget"
import { chatArrival, refusalMessage } from "../lib/chat-gate"
import { buildJobTools, JOB_TOOL_PREFIX } from "../lib/chat-tools"
import { readEnvironmentBindings } from "../lib/context-environment"
import { decryptSecret, encryptSecret, sha256 } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"
import { creatorLeft, resolveJobCredential } from "../lib/job-accounts"
import { turnAgent } from "../lib/job-command"
import { advanceGraph, graphAware } from "../lib/job-graph"
import {
  attachSession,
  machineDepsFrom,
  machinePass,
  sessionClaim,
  sessionTunnelRequest,
} from "../lib/job-machine"
import { canAskAgent, canManageAgent, canSteerJob, inboxScope } from "../lib/job-policy"
import {
  answerJob,
  askAgent,
  cancelJob,
  followUpJob,
  isServerNote,
  jobJson,
  jobOverBudget,
  overBudgetFor,
  pullJobs,
  reportJob,
  retryJob,
  waitingFor,
} from "../lib/jobs"
import { oauthScopeRole } from "../lib/oauth-agent"
import {
  continuePageAsk,
  dispatchPageTurn,
  isPageAsk,
  openPageAsk,
  type PageTurnGrant,
  SAVE_INTERRUPTED,
} from "../lib/page-ask"
import { MAX_RUN_CEILING_MS } from "../lib/run-lifecycle"
import { signWorkToken } from "../lib/run-token"
import { runtimeFailureReason } from "../lib/runtime-diagnostics"
import { relaySession } from "../lib/session-transport"
import { log } from "../log"

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
  question_id: z.string().optional(),
  target_id: z.string().optional(),
  target_version: z.number().optional(),
  question: z.string(),
  options: z.array(z.string()).optional(),
  review_round_id: z.string().optional(),
  asked_times: z.number().optional(),
  first_asked_at: z.string().optional(),
})

const JobEffectSchema = z.object({
  kind: z.enum(["page", "pr", "email", "rows", "other"]),
  label: z.string(),
  ref: z.string().optional(),
  version: z.number().optional(),
  url: z.string().optional(),
})

const JobResultSchema = z.object({
  claim_ledger_version: z.literal(1).optional(),
  attempt_offset: z.number().int().nonnegative().optional(),
  git: z
    .object({
      repo: z.string().max(300),
      branch: z.string().max(300).nullable(),
      commit: z.string().max(64).nullable(),
    })
    .optional()
    .describe("Where the latest turn left the task's repository."),
  compute: z
    .array(
      z.object({
        turn: z.string(),
        provider: z.enum(["ortam", "boat"]),
        sandbox_id: z.string(),
        started_at: z.string(),
        stopped_at: z.string(),
        billable_seconds: z.number().nonnegative().nullable(),
        cost_micro_usd: z.number().int().nonnegative().nullable(),
      }),
    )
    .optional(),
  runs: z
    .array(
      z.object({
        attempt: z.number().int().nonnegative(),
        provider: z.string().max(80),
        model: z.string().max(200),
        runner_version: z.string().max(80).optional(),
        harness_version: z.string().max(100).nullable().optional(),
        skill: z
          .object({ short_id: z.string().max(64), version: z.number().int().positive() })
          .optional(),
        input_tokens: z.number().int().nonnegative().nullable(),
        cached_input_tokens: z.number().int().nonnegative().nullable(),
        output_tokens: z.number().int().nonnegative().nullable(),
        duration_ms: z.number().int().nonnegative(),
        model_cost_micro_usd: z.number().int().nonnegative().nullable(),
        harness_estimate_micro_usd: z.number().int().nonnegative().nullable().optional(),
        api_estimate_micro_usd: z.number().int().nonnegative().nullable().optional(),
        price_version: z.string().nullable().optional(),
        turn_id: z.string().optional(),
        actor_id: z.string().nullable().optional(),
      }),
    )
    .max(600)
    .optional(),
  effects: z.array(JobEffectSchema).optional(),
  evidence: z
    .array(z.object({ label: z.string(), url: z.string().optional(), ref: z.string().optional() }))
    .optional(),
  failure: z.object({ reason: z.string(), retryable: z.boolean() }).optional(),
  superseded_by: z.string().optional(),
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
    chat_context: z
      .object({
        selection: z.string().nullable(),
        model_id: z.string().nullable(),
        saving: z.boolean(),
      })
      .nullable(),
    agent_id: z.string(),
    kind: z.enum(["ask", "scheduled", "graph", "node"]),
    status: z.enum(["queued", "running", "needs_you", "succeeded", "failed", "cancelled", "lost"]),
    machine_phase: z
      .enum([
        "creating",
        "provisioning",
        "starting",
        "ready",
        "launching",
        "running",
        "stopping",
        "parked",
        "deleting",
        "released",
      ])
      .nullable()
      .optional()
      .describe("Where the task's cloud machine is. `parked`: stopped with its files, resumable."),
    machine_waiting: z
      .string()
      .nullable()
      .optional()
      .describe("Why the machine is waiting to start, in the provider's words (a start limit)."),
    task: z
      .object({ session: z.boolean().optional(), repo: z.string().optional() })
      .describe("How the task runs: an interactive session, and the repository it works in."),
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
    report_short_id: z.string().nullable().describe("The job's report page, once it has one."),
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
    model: z.object({ id: z.string(), label: z.string() }).nullable(),
    tools: z.array(z.string()),
    created_at: z.string(),
  })
  .openapi("JobMessage")

const JobTurn = z.object({
  id: z.string(),
  ordinal: z.number(),
  actor_id: z.string().nullable(),
  body_md: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "needs_you", "cancelled"]),
  body_result_md: z.string().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  resumable: z.boolean(),
  execution: z.object({
    provider: z.enum(["codex", "claude-code"]),
    model: z.string().nullable(),
    effort: z.string().nullable().optional(),
    account_id: z.string().nullable(),
    agent_name: z.string().optional(),
    skill: z.object({ artifact_id: z.string(), version: z.number() }).nullable(),
    sandbox: z
      .object({
        provider: z.enum(["boat", "ortam"]),
        connection_id: z.string().nullable(),
        account_id: z.string().nullable(),
      })
      .optional(),
  }),
})
const WaitingFor = z
  .object({
    machine: z.literal("owner"),
    owner: z.string().nullable().describe("Whose machine: the agent's creator."),
    seen_at: z.string().nullable().describe("When that runner last polled; null if never."),
  })
  .nullable()
  .describe("Set when nothing will pick this task up until a runner comes back.")

const JobDetail = Job.extend({
  messages: z.array(JobMessage),
  turns: z.array(JobTurn).optional(),
  events: z
    .array(
      z.object({
        turn_id: z.string(),
        seq: z.number(),
        kind: z.string(),
        label: z.string().nullable().optional(),
        created_at: z.string(),
      }),
    )
    .optional(),
}).openapi("JobDetail")

/** What an ask returns: the task, and whose machine it is waiting for, if any. */
const JobAsked = JobDetail.extend({ waiting_for: WaitingFor }).openapi("JobAsked")

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
  const jobDeps = graphAware({
    meta,
    cloud: { secret: deps.encryptionKey, config: deps.runtime },
    bus: ctx.backplane,
    blobs: ctx.blobs,
    announce: ctx.announceJob,
  })
  const wakeCloud = async (c: Context, job: JobRecord) => {
    if (!meta.jobExecution || job.kind === "graph" || job.attended === 1) return
    const agent = await meta.getAgent(job.agent_id)
    if (agent?.machine !== "derive") return
    const machine = machineDepsFrom(meta, {
      secret: deps.encryptionKey,
      server: deps.baseUrl,
      config: deps.runtime,
      fetcher: deps.runtimeFetch,
      bus: ctx.backplane,
      announce: ctx.announceJob,
    })
    if (machine) await ctx.afterResponse(c, () => machinePass(machine))
  }
  const turnsFor = async (job: JobRecord) =>
    ((await meta.jobExecution?.turns(job.id, job.org_id)) ?? []).map((turn) => {
      const choice = JSON.parse(turn.execution_json) as import("@derive/core").JobExecution
      return {
        id: turn.id,
        ordinal: turn.ordinal,
        actor_id: turn.actor_id,
        body_md: turn.body_md,
        status: turn.status,
        body_result_md: turn.body_result_md,
        started_at: turn.started_at,
        finished_at: turn.finished_at,
        resumable: !!turn.session_id && turn.has_checkpoint,
        execution: {
          provider: choice.provider,
          model: choice.model,
          effort: choice.effort ?? null,
          account_id: choice.account_id,
          agent_name: choice.agent_name,
          skill: choice.skill,
          sandbox: choice.sandbox,
        },
      }
    })

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
    model:
      (JSON.parse(m.meta_json ?? "{}") as { model?: { id: string; label: string } }).model ?? null,
    tools: (JSON.parse(m.meta_json ?? "{}") as { tools?: string[] }).tools ?? [],
    progress:
      !!m.meta_json && (JSON.parse(m.meta_json) as { progress?: boolean }).progress === true,
    created_at: m.created_at,
  })

  /** Jobs as the API shows them: the row, plus its report page's short id (one lookup). */
  const shown = async (jobs: JobRecord[]) => {
    const ids = [...new Set(jobs.map((j) => j.report_artifact_id).filter((x): x is string => !!x))]
    const arts = ids.length ? await meta.getArtifactsByIds(ids) : []
    const short = new Map(arts.map((a) => [a.id, a.short_id]))
    return jobs.map((j) => ({
      ...jobJson(j),
      report_short_id: j.report_artifact_id ? (short.get(j.report_artifact_id) ?? null) : null,
    }))
  }
  const showOne = async (j: JobRecord) =>
    (await shown([j]))[0] as Awaited<ReturnType<typeof shown>>[number]

  /** The person behind a request and whether they may see this job's workspace. Jobs are
   *  visible to every member of the agent's workspace: the work an agent does for one person
   *  is work the team can see, like the pages it publishes. The exception is the built-in
   *  Derive's jobs (an @Derive thread in Slack): that answer was read with the asker's own
   *  permissions, so only the asker sees it. */
  const personFor = async (c: Context) => {
    const who = await actingHuman(c)
    if (!who) return fail(c, 401, "unauthenticated")
    return who
  }
  const privateTo = (j: JobRecord, whoId: string) =>
    j.agent_id !== DERIVE_AGENT_ID || j.asked_by === whoId
  const visibleJob = async (c: Context, id: string): Promise<JobRecord | Response> => {
    const who = await personFor(c)
    if (who instanceof Response) return who
    // The active workspace, which a grant scoped to other workspaces cannot name.
    const org = await ctx.requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const job = await meta.getJob(id)
    if (
      !job ||
      job.org_id !== org ||
      !privateTo(job, who.id) ||
      !(await meta.getMembership(org, who.id))
    )
      return fail(c, 404, "not found")
    return job
  }

  const sessionAccess = async (c: Context, id: string) => {
    const job = await visibleJob(c, id)
    if (job instanceof Response) return job
    const who = await personFor(c)
    if (who instanceof Response) return who
    const grant = await ctx.oauthGrant(c)
    if (job.asked_by !== who.id || (!!(await agentFor(c)) && !grant))
      return fail(c, 403, "Only the person who started this session can attach to it")
    const membership = await meta.getMembership(job.org_id, who.id)
    if (
      !membership ||
      !roleAllows(membership.role, "publish") ||
      (grant && !roleAllows(grant.scopeRole, "publish"))
    )
      return fail(c, 403, "SSH access requires derive:publish or derive:manage authorization")
    const claim = sessionClaim(job)
    if (!claim) return fail(c, 409, "This session is not running. Resume it first.")
    const machine = machineDepsFrom(meta, {
      secret: deps.encryptionKey,
      server: deps.baseUrl,
      config: deps.runtime,
      fetcher: deps.runtimeFetch,
    })
    if (!machine) return fail(c, 503, "Cloud compute is not enabled on this server")
    const consent =
      grant && !ctx.isMintedApiToken(c)
        ? (await meta.listUserGrants(who.id)).find((row) => row.clientId === grant.clientId)
        : null
    if (
      grant &&
      !ctx.isMintedApiToken(c) &&
      (!consent || !roleAllows(oauthScopeRole(consent.scopes), "publish"))
    )
      return fail(c, 403, "This session's authorization was revoked")
    const expiresAt = Math.min(
      Date.parse(claim.deadlineAt),
      ctx.mintedApiExpiresAt(c) ?? Number.POSITIVE_INFINITY,
    )
    const consentStamp = JSON.stringify(consent)
    const claimStamp = JSON.stringify(claim)
    const stillAllowed = async () => {
      if (Date.now() >= expiresAt) return false
      const current = await meta.getJob(job.id)
      const membership = await meta.getMembership(job.org_id, who.id)
      if (
        !current ||
        current.org_id !== job.org_id ||
        current.agent_id !== job.agent_id ||
        current.asked_by !== who.id ||
        JSON.stringify(sessionClaim(current)) !== claimStamp ||
        !membership ||
        !roleAllows(membership.role, "publish")
      )
        return false
      if (consent && grant) {
        const [grants, bound] = await Promise.all([
          meta.listUserGrants(who.id),
          meta.getOAuthClientWorkspaces(who.id, grant.clientId),
        ])
        if (
          JSON.stringify(grants.find((row) => row.clientId === grant.clientId)) !== consentStamp ||
          (bound.length > 0 && !bound.includes(job.org_id))
        )
          return false
      }
      return true
    }
    return { job, machine, claim, expiresAt, stillAllowed }
  }

  // ---- The built-in Derive, asked from a page (lib/page-ask.ts) ---------------------------

  /** The page a built-in ask is about: readable by the asker, in the active workspace. Anything
   *  else is not found, the same answer an agent ask gives. */
  const readablePage = async (c: Context, org: string, id: string) => {
    const byId = await meta.getArtifactById(id).catch(() => null)
    const page = await ctx.requireArtifact(c, "read", { shortId: byId?.short_id ?? id })
    if (page instanceof Response || page.org_id !== org)
      return fail(c, 404, "no such page you can read in this workspace")
    return page
  }

  /** Every rung a built-in turn walks before it spends (lib/chat-gate.ts), as HTTP. The rate
   *  limit is the request's own (Retry-After included); the rest is the shared gate. */
  const deriveGate = async (
    c: Context,
    org: string,
    userId: string,
    modelId?: string | null,
  ): Promise<PageTurnGrant | Response> => {
    const caller = await agentFor(c)
    if (caller && (caller.org_id !== org || !roleAllows(caller.role, "publish")))
      return fail(c, 403, "this grant cannot start work")
    const rl = await ctx.limited(c, ctx.askLimiter)
    if (rl) return rl
    const { catalog, slots } = await ctx.modelsFor(c)
    const gate = await chatArrival(
      { meta, models: catalog ?? undefined, chatAllowlist: ctx.chatAllowlist },
      { org, userId, modelId: modelId ?? slots.chat ?? null },
    )
    if (gate.ok) return gate
    return gate.reason === "not_member"
      ? fail(c, 404, "not found")
      : gate.reason === "over_budget"
        ? fail(c, 402, OVER_BUDGET)
        : gate.reason === "rate_limited"
          ? fail(c, 429, refusalMessage(gate.reason))
          : fail(c, 503, refusalMessage(gate.reason))
  }

  /** Who the turn speaks to, by name. */
  const askerOf = async (id: string) => ({
    id,
    name: (await meta.getUsers([id]).catch(() => []))[0]?.name ?? null,
  })

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
          mine: z
            .string()
            .optional()
            .describe("1: only jobs you asked, or on agents you manage (the inbox)."),
          report: z
            .string()
            .optional()
            .describe("A report page's short id: the job that report is for."),
          subject: z
            .string()
            .optional()
            .describe("A page's short id: only the jobs you asked about that page."),
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
      let reportArtifactId: string | undefined
      if (q.report) {
        const art = await meta.getByShortId(q.report).catch(() => null)
        if (!art || art.org_id !== org) return c.json({ jobs: [] })
        reportArtifactId = art.id
      }
      // A subject is stored as the asker named it: by short id, or (leniently) by artifact id.
      // It lists the caller's own asks only: what the Ask panel resumes is a conversation you
      // had, and an owner's `mine` (every job) would otherwise crowd it out.
      let subjectJson: string[] | undefined
      let askedBy: string | undefined
      if (q.subject) {
        const who = await actingHuman(c)
        if (!who) return bail(fail(c, 401, "unauthenticated"))
        const art = await meta.getByShortId(q.subject).catch(() => null)
        if (!art || art.org_id !== org) return c.json({ jobs: [] })
        subjectJson = [art.short_id, art.id].map((id) => JSON.stringify({ kind: "artifact", id }))
        askedBy = who.id
      }
      // `mine`: jobs you asked, or on agents you manage (canManageAgent's rule, read with one
      // membership lookup). A workspace owner manages every agent, so every job is theirs.
      let askedByOrAgent: { askedBy: string; agentIds: string[] } | undefined
      if (q.mine === "1") {
        const who = await actingHuman(c)
        if (!who) return bail(fail(c, 401, "unauthenticated"))
        const scope = await inboxScope(meta, org, who.id)
        if (!scope) return c.json({ jobs: [] })
        if (scope !== "all") askedByOrAgent = scope
      }
      const jobs = await meta.listJobs({
        orgId: org,
        agentId: q.agent || undefined,
        status: split(q.status, STATUSES),
        kind: split(q.kind, KINDS),
        parentId: q.parent || undefined,
        reportArtifactId,
        subjectJson,
        askedBy,
        askedByOrAgent,
        viewer: (await actingHuman(c))?.id ?? "",
        before: q.before || undefined,
        limit: Math.min(200, Number(q.limit) || 50),
      })
      return c.json({ jobs: await shown(jobs) })
    },
  )

  app.get("/v1/chat/models", async (c) => {
    const org = await ctx.requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const who = await actingHuman(c)
    if (!who || !(await meta.getMembership(org, who.id))) return fail(c, 404, "not found")
    const { catalog, slots } = await ctx.modelsFor(c)
    return c.json({
      options: catalog?.options ?? [],
      default_id: slots.chat ?? catalog?.resolve(null)?.id ?? null,
    })
  })

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
          content: { "application/json": { schema: JobAsked } },
        },
        200: {
          description: "An open job already holding this dedupe key.",
          content: { "application/json": { schema: JobAsked } },
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
          model_id: z.string().trim().min(1).max(200).nullish(),
          selection: z.string().trim().min(1).max(8000).optional(),
          base_version: z.number().int().positive().optional(),
          // A Derive-machine task only: run interactively for the asker to attach to, and the
          // repository to check out first.
          session: z.boolean().optional(),
          repo: z.string().regex(TASK_REPO).optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      // The built-in Derive has no agent row and nothing to pull its work: it is asked about a
      // page, by a person, and this request serves the turn after it responds.
      if (b.agent_id === DERIVE_AGENT_ID) {
        if (await agentFor(c)) return bail(fail(c, 404, "no such agent you can ask"))
        const about = b.subject ? normalizeSelectors([b.subject])[0] : null
        if (about && about.kind !== "artifact")
          return bail(fail(c, 400, "Chat can scope to this workspace or one artifact"))
        if (b.selection && !about) return bail(fail(c, 400, "A selection needs an artifact"))
        const org = await ctx.requireWorkspace(c, "read")
        if (org instanceof Response) return bail(org)
        const page = about?.kind === "artifact" ? await readablePage(c, org, about.id) : null
        if (page instanceof Response) return bail(page)
        if (page && b.base_version && page.current_version !== b.base_version)
          return bail(fail(c, 409, "This artifact changed. Refresh before asking."))
        const grant = await deriveGate(c, org, who.id, b.model_id)
        if (grant instanceof Response) return bail(grant)
        const job = await openPageAsk(ctx, {
          org,
          askerId: who.id,
          page,
          question: b.instruction,
          selection: b.selection,
          modelId: b.model_id,
        })
        const asker = await askerOf(who.id)
        await dispatchPageTurn(ctx, c, job, asker, page, grant)
        const messages = (await meta.listJobMessages(job.id)).map(messageJson)
        return c.json(
          { ...(await showOne((await meta.getJob(job.id)) ?? job)), messages, waiting_for: null },
          201,
        )
      }
      const agent = await meta.getAgent(b.agent_id)
      const caller = await agentFor(c)
      if (!agent || !(await canAskAgent(meta, agent, who.id, caller)))
        return bail(fail(c, 404, "no such agent you can ask"))
      // A session is attached to over a Derive machine's SSH; a team's own box has its own tools
      // for that. Repositories work on both.
      if (b.session && agent.machine !== "derive")
        return bail(fail(c, 400, "Interactive sessions need an agent that runs on Derive"))
      // A workspace past its monthly model budget takes no new work. Checked before anything
      // is written, so a refused ask leaves no job behind. A dedupe key naming an open job
      // still finds it: that work is already asked for.
      const open = b.dedupe_key
        ? await meta.findOpenJobByDedupe(agent.id, who.id, b.dedupe_key)
        : null
      if (agent.machine !== "derive" && !open && (await overBudgetFor(meta, agent, who.id)))
        return bail(fail(c, 402, OVER_BUDGET))
      const subject: Selector | null = b.subject
        ? (normalizeSelectors([b.subject])[0] ?? null)
        : null
      // A page as the subject: it must be in the agent's workspace, and the asker must be able
      // to read it, so asking can never hand an agent a page its asker could not open. The id
      // is a short id (or, leniently, an artifact id).
      if (subject?.kind === "artifact") {
        const byId = await meta.getArtifactById(subject.id).catch(() => null)
        const shortId = byId?.short_id ?? subject.id
        const page = await ctx.requireArtifact(c, "read", { shortId })
        if (page instanceof Response || page.org_id !== agent.org_id)
          return bail(fail(c, 404, "no such page you can read in this agent's workspace"))
      }
      const { job, created } = await askAgent(jobDeps, {
        agent,
        askedBy: who.id,
        instruction: b.instruction,
        subject,
        dedupeKey: b.dedupe_key ?? null,
        task: { ...(b.session ? { session: true } : {}), ...(b.repo ? { repo: b.repo } : {}) },
      })
      const messages = (await meta.listJobMessages(job.id)).map(messageJson)
      const body = {
        ...(await showOne(job)),
        messages,
        turns: await turnsFor(job),
        events: (await meta.jobExecution?.events(job.id, job.org_id)) ?? [],
        // Said here, not on every job: the asker is the one who can do something about it.
        // A dedupe hit that is already running or asking waits for nobody's machine.
        waiting_for:
          job.status === "queued"
            ? (await creatorLeft(meta, agent))
              ? { machine: "owner" as const, owner: agent.created_by, seen_at: agent.seen_at }
              : waitingFor(agent)
            : null,
      }
      if (created) await wakeCloud(c, job)
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
      return c.json({
        ...(await showOne(job)),
        messages,
        turns: await turnsFor(job),
        events: (await meta.jobExecution?.events(job.id, job.org_id)) ?? [],
      })
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
      // A built-in page ask continues as another turn on the same job. Only its asker sees it
      // (visibleJob), and it meets every gate an ask does, page access included: a page they
      // lost access to since is not read again on their behalf.
      if (isPageAsk(job)) {
        // Asked by a person on the page, never driven by an agent's token: the same refusal
        // the opening ask gives.
        if (await agentFor(c)) return bail(fail(c, 404, "not found"))
        if (["running", "cancelled", "lost", "needs_you"].includes(job.status))
          return bail(fail(c, 409, "Derive is still answering; wait for it to finish"))
        const b = await readJson(c, z.object({ body_md: z.string().trim().min(1).max(20_000) }))
        if (b instanceof Response) return bail(b)
        const about = JSON.parse(job.subject_json ?? "{}") as { id?: string }
        const page = about.id ? await readablePage(c, job.org_id, about.id) : null
        if (page instanceof Response) return bail(page)
        const grant = await deriveGate(
          c,
          job.org_id,
          who.id,
          (JSON.parse(job.meta_json ?? "{}") as { model_id?: string }).model_id,
        )
        if (grant instanceof Response) return bail(grant)
        const next = await continuePageAsk(ctx, job, who.id, b.body_md)
        if (!next) return bail(fail(c, 409, "Derive is already answering; wait for it to finish"))
        const asker = await askerOf(who.id)
        await dispatchPageTurn(ctx, c, next, asker, page, grant)
        const messages = (await meta.listJobMessages(job.id)).map(messageJson)
        return c.json({ ...(await showOne((await meta.getJob(job.id)) ?? next)), messages })
      }
      const agent = await meta.getAgent(job.agent_id)
      if (!agent || !(await canSteerJob(meta, agent, job, who.id, await agentFor(c))))
        return bail(
          fail(c, 403, "only the person who asked, or the agent's manager, can follow up"),
        )
      if (job.status === "cancelled") return bail(fail(c, 409, "this job was cancelled; ask again"))
      if (!(agent.machine === "derive" && meta.jobExecution) && (await reopensOverBudget(job)))
        return bail(fail(c, 402, OVER_BUDGET))
      const b = await readJson(
        c,
        z.object({
          body_md: z.string().trim().min(1).max(20_000),
          dedupe_key: z.string().max(200).optional(),
          // Cloud tasks: stop the running turn and take this message now, instead of after it.
          interrupt: z.boolean().optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      const next = await followUpJob(jobDeps, job, who.id, b.body_md, b.dedupe_key, b.interrupt)
      await wakeCloud(c, next)
      const messages = (await meta.listJobMessages(job.id)).map(messageJson)
      return c.json({
        ...(await showOne(next)),
        messages,
        turns: await turnsFor(next),
        events: (await meta.jobExecution?.events(next.id, next.org_id)) ?? [],
      })
    },
  )

  /** A write that reopens a settled job is new work, so it meets the same budget an ask does,
   *  billed to the payer it opened with. A graph itself spends nothing; its steps meet
   *  the budget when they open. */
  const reopensOverBudget = async (job: JobRecord) =>
    job.status !== "running" &&
    job.status !== "queued" &&
    job.kind !== "graph" &&
    (await jobOverBudget(meta, job))

  const personAction = (
    path: string,
    summary: string,
    act: (
      job: JobRecord,
      c: Context,
      whoId: string,
    ) => Promise<JobRecord | null | { error: string }>,
    reopens = false,
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
        const caller = await agentFor(c)
        if (
          isPageAsk(job)
            ? job.asked_by !== who.id ||
              (!!caller && (caller.org_id !== job.org_id || !roleAllows(caller.role, "publish")))
            : !agent || !(await canSteerJob(meta, agent, job, who.id, caller))
        )
          return bail(
            fail(c, 403, "only the person who asked, or the agent's manager, can do that"),
          )
        if (
          reopens &&
          !(agent?.machine === "derive" && meta.jobExecution) &&
          (await reopensOverBudget(job))
        )
          return bail(fail(c, 402, OVER_BUDGET))
        const out = await act(job, c, who.id)
        if (!out) return bail(fail(c, 409, "this job cannot do that from where it is"))
        if ("error" in out) return bail(fail(c, 400, out.error))
        await wakeCloud(c, out)
        return c.json(await showOne(out))
      },
    )
  personAction("/v1/jobs/{id}/cancel", "Cancel an open job (and its children).", (job, c, whoId) =>
    cancelJob(jobDeps, job, whoId, c.req.header("Idempotency-Key")),
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/jobs/{id}/attach",
      tags: ["Jobs"],
      summary: "Let your SSH key into your running interactive session's machine.",
      request: {
        params: z.object({ id: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                public_key: z
                  .string()
                  .trim()
                  .regex(/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+( \S+)?$/)
                  .describe("An OpenSSH public key. Private keys are refused."),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Where to connect. Attach with `tmux attach -t derive` once connected.",
          content: {
            "application/json": {
              schema: z.union([
                z.object({
                  host: z.string(),
                  port: z.number(),
                  user: z.string(),
                  host_key: z.string().nullable().describe("Pin this in known_hosts."),
                  tmux_session: z.string(),
                }),
                z.object({
                  transport: z.literal("websocket"),
                  user: z.literal("ortam"),
                  host_key: z.string(),
                  certificate: z.string(),
                  certificate_expires_at: z.iso.datetime(),
                  tunnel_path: z.string(),
                  claim: z.iso.datetime(),
                  tmux_session: z.string(),
                }),
              ]),
            },
          },
        },
      },
    }),
    async (c) => {
      const access = await sessionAccess(c, c.req.param("id") ?? "")
      if (access instanceof Response) return bail(access)
      if (!(await access.stillAllowed()))
        return bail(fail(c, 409, "This session changed. Attach again."))
      const out = await attachSession(access.machine, access.job, c.req.valid("json").public_key)
      if (!out.ok) return bail(fail(c, out.status, out.error))
      if (!(await access.stillAllowed()))
        return bail(fail(c, 409, "This session changed. Attach again."))
      // Who opened a terminal on the session, and when, stays on the task. Only its starter can.
      const starter = access.job.asked_by ?? ""
      await meta.addJobMessage({
        id: newId("jm"),
        job_id: access.job.id,
        author_kind: "agent",
        author_id: access.job.agent_id,
        body_md: `${(await meta.getUsers([starter]))[0]?.name ?? "Its starter"} opened a terminal on this session.`,
        meta_json: JSON.stringify({ progress: true, server: true, attached_by: starter }),
      })
      if (out.transport === "websocket")
        return c.json({
          transport: out.transport,
          user: out.user,
          host_key: out.host_key,
          certificate: out.certificate,
          certificate_expires_at: out.certificate_expires_at,
          tunnel_path: `/v1/jobs/${access.job.id}/ssh`,
          claim: access.claim.startedAt,
          tmux_session: SESSION_TMUX,
        })
      return c.json({
        host: out.host,
        port: out.port,
        user: out.user,
        host_key: out.host_key,
        tmux_session: SESSION_TMUX,
      })
    },
  )
  app.get("/v1/jobs/:id/ssh", async (c) => {
    const access = await sessionAccess(c, c.req.param("id"))
    if (access instanceof Response) return bail(access)
    if (c.req.header("x-derive-job-claim") !== access.claim.startedAt)
      return bail(fail(c, 409, "This session changed. Attach again."))
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket" || c.req.raw.url.includes("?"))
      return bail(
        fail(c, 400, "Use an authenticated WebSocket connection without query parameters"),
      )
    const transport = deps.sessionTransport
    if (!transport) return bail(fail(c, 503, "SSH tunnels are not enabled on this server"))
    if (!(await access.stillAllowed()))
      return bail(fail(c, 409, "This session changed. Attach again."))
    const request = await sessionTunnelRequest(access.machine, access.job)
    if (!request) return bail(fail(c, 409, "This machine has no SSH tunnel"))
    const upstream = await transport.connect(
      new Request(request, { signal: AbortSignal.any([request.signal, c.req.raw.signal]) }),
      c,
    )
    const relay = relaySession(upstream, access.stillAllowed, access.expiresAt)
    const signal = c.req.raw.signal
    signal.addEventListener("abort", relay.close, { once: true })
    const unwatch = transport.watchDisconnect?.(c, relay.close)
    if (signal.aborted) relay.close()
    try {
      if (!(await relay.authorize()))
        return bail(fail(c, 409, "This session changed. Attach again."))
      return await transport.accept(c, relay.ready, relay.close)
    } catch (error) {
      relay.close()
      throw error
    } finally {
      signal.removeEventListener("abort", relay.close)
      unwatch?.()
    }
  })
  personAction(
    "/v1/jobs/{id}/retry",
    "Run a failed or lost job again.",
    async (job, c, whoId) => {
      if (!isPageAsk(job)) return retryJob(jobDeps, job, whoId, c.req.header("Idempotency-Key"))
      if (job.status !== "failed" && job.status !== "lost") return null
      if (JSON.parse(job.meta_json ?? "{}").saving === true) return { error: SAVE_INTERRUPTED }
      const about = JSON.parse(job.subject_json ?? "{}") as { id?: string }
      const page = about.id ? await readablePage(c, job.org_id, about.id) : null
      if (page instanceof Response) return { error: "The scoped artifact is no longer accessible." }
      const grant = await deriveGate(
        c,
        job.org_id,
        whoId,
        (JSON.parse(job.meta_json ?? "{}") as { model_id?: string }).model_id,
      )
      if (grant instanceof Response)
        return { error: "The chat cannot run. Check access, budget, and model availability." }
      const next = await continuePageAsk(
        ctx,
        job,
        whoId,
        "Retry the last request. Re-read the artifact. Do not repeat any successful writes recorded in this chat.",
      )
      if (next) await dispatchPageTurn(ctx, c, next, { id: whoId, name: null }, page, grant)
      return next
    },
    true,
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
          question_id: z.string().min(1).optional(),
          dedupe_key: z.string().min(1).max(200).optional(),
        }),
      )
      if (b instanceof Response) return { error: "answer needs text or an option" }
      if (isPageAsk(job)) {
        if (job.status !== "needs_you")
          return { error: "This question is no longer waiting for an answer." }
        const needs = JSON.parse(job.needs_json ?? "{}") as JobNeeds
        if (!b.question_id || needs.question_id !== b.question_id)
          return { error: "This question changed. Refresh before answering." }
        if (b.option && !needs.options?.includes(b.option))
          return { error: "Choose one of the displayed options." }
        const text = [b.option ? `Decision: ${b.option}` : "", b.text?.trim() ?? ""]
          .filter(Boolean)
          .join("\n\n")
        if (!text) return { error: "Answer needs text or an option." }
        const about = JSON.parse(job.subject_json ?? "{}") as { id?: string }
        const page = about.id ? await readablePage(c, job.org_id, about.id) : null
        if (page instanceof Response)
          return { error: "You can no longer read the scoped artifact." }
        if (page && needs.target_version !== page.current_version)
          return {
            error:
              "The artifact changed while you answered. Start a new chat from the current version.",
          }
        const grant = await deriveGate(
          c,
          job.org_id,
          whoId,
          (JSON.parse(job.meta_json ?? "{}") as { model_id?: string }).model_id,
        )
        if (grant instanceof Response)
          return {
            error: "This chat cannot continue. Check access, model availability, and budget.",
          }
        const next = await continuePageAsk(ctx, job, whoId, text)
        if (!next) return { error: "An answer was already accepted. Refresh this chat." }
        await dispatchPageTurn(ctx, c, next, { id: whoId, name: null }, page, grant)
        return next
      }
      return answerJob(jobDeps, job, whoId, b)
    },
    true,
  )

  // ---- Runners -----------------------------------------------------------------------------
  //
  // Plain routes (runner protocol, not the product API). The bearer is the agent itself.

  /** The agent a runner acts as for `agentId`: the agent's own key, or a person's own coding
   *  session (an MCP grant) running an `owner`-machine agent they manage. That second door is
   *  the MCP `pull` tool; it goes through these same routes so the fences live in one place. */
  const runnerFor = async (
    c: Context,
    agentId: string,
    forJob: string | null = null,
  ): Promise<AgentRecord | Response> => {
    const a = await agentFor(c)
    if (!a) return fail(c, 401, "an agent key is required")
    // A job token runs exactly its one job: never a pull, never another job's routes.
    const scope = ctx.agentJobScope(c)
    if (scope && (scope !== forJob || a.id !== agentId))
      return fail(c, 403, "this token is scoped to another job")
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
    const agent = await runnerFor(c, job.agent_id, job.id)
    if (agent instanceof Response) return agent.status === 403 ? fail(c, 404, "not found") : agent
    if (job.org_id !== agent.org_id) return fail(c, 404, "not found")
    if (job.status !== "running") return fail(c, 409, "this job is not running")
    const claim = c.req.header("x-derive-claim") ?? c.req.query("claim")
    if (claim !== job.started_at) return fail(c, 409, "this claim has been superseded")
    const turn = meta.jobExecution
      ? await meta.jobExecution.claimed(job.id, job.org_id, job.started_at ?? "")
      : null
    if (turn) {
      if (turn.actor_id && !(await canSteerJob(meta, agent, job, turn.actor_id)))
        return fail(c, 403, "The person who started this turn no longer has access.")
      const member = turn.actor_id ? await meta.getMembership(job.org_id, turn.actor_id) : null
      if (turn.actor_id && !member)
        return fail(c, 403, "The person who started this turn no longer has access.")
      return {
        agent: {
          ...turnAgent(agent, JSON.parse(turn.execution_json)),
          role: member ? capRole(agent.role, member.role) : agent.role,
          created_by: turn.actor_id ?? agent.created_by,
        },
        job,
      }
    }
    return { agent, job }
  }

  /** What a runner needs to do one job, besides secrets: the transcript, the agent's
   *  instructions, and the tools its sources grant. */
  const payload = async (agent: AgentRecord, jobs: JobRecord[]) => {
    const work = jobs[0]
    const turn =
      work?.started_at && meta.jobExecution
        ? await meta.jobExecution.claim(work.id, work.org_id, work.started_at)
        : null
    const execution = turn
      ? (JSON.parse(turn.execution_json) as import("@derive/core").JobExecution)
      : null
    if (execution) agent = turnAgent(agent, execution)
    if (turn?.actor_id && work) {
      const member = await meta.getMembership(work.org_id, turn.actor_id)
      if (!member) throw new Error("The turn actor no longer has access")
      agent = { ...agent, role: capRole(agent.role, member.role), created_by: turn.actor_id }
    }
    let instructions: {
      short_id: string
      version: number
      body_md: string
      bundle: boolean
    } | null = null
    if (agent.instructions_artifact_id) {
      const art = await meta.getArtifactById(agent.instructions_artifact_id).catch(() => null)
      const skillVersion = execution?.skill?.version ?? art?.current_version
      const v = art && skillVersion ? await meta.getVersion(art.id, skillVersion) : null
      const body = v ? await ctx.sourceText(v) : null
      // File-only skills have no preview entry; the runner loads SKILL.md from the bundle.
      if (art && v && (body != null || art.kind === "bundle"))
        instructions = {
          short_id: art.short_id,
          version: skillVersion ?? art.current_version,
          body_md: body ?? "",
          bundle: art.kind === "bundle",
        }
    }
    const connIds = parseConnectionIds(agent.connection_ids_json)
    const quiet: SourceQuiet[] = []
    let tools: { def: unknown; ref: string }[] = []
    if (connIds.length && jobs.length) {
      // The agent's creator's personal broker plan, else the workspace pool's: the agent acts
      // on their behalf.
      const broker = await brokerFor(
        meta,
        agent.org_id,
        agent.created_by,
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
    // A Derive machine's model has no Derive login, so Derive's own tools ride the same shim,
    // run in-process as the agent (lib/chat-tools.ts buildJobTools).
    if (agent.machine === "derive" && jobs.length) {
      const own = await buildJobTools(ctx, agent)
      for (const t of own?.tools ?? [])
        tools.push({
          def: { name: JOB_TOOL_PREFIX + t.name, description: t.description, params: t.params },
          ref: "derive",
        })
    }
    // The model's credential for this claim's source tools. The runner keeps its own key out of
    // the model's environment, so the model calls a source with this instead: it reaches only
    // `POST /v1/jobs/<this job>/tool`, and dies when the job settles or is reclaimed. That
    // liveness check is what ends it, so the expiry is only a ceiling, set past the longest
    // run a lease allows (progress ticks renew the lease, never this token).
    const toolToken = async (j: JobRecord) =>
      deps.encryptionKey && j.started_at
        ? signWorkToken(
            "jobtool",
            deps.encryptionKey,
            `${j.id}~${Date.parse(j.started_at)}`,
            agent.id,
            agent.org_id,
            Date.parse(j.started_at) + MAX_RUN_CEILING_MS,
          )
        : null
    return Promise.all(
      jobs.map(async (j) => ({
        ...(await showOne(j)),
        tool_token: await toolToken(j),
        // The transcript the model reads: what people and the agent said. Notes the server
        // wrote about the job itself (held for budget) are for the people watching it.
        messages: (await meta.listJobMessages(j.id))
          .filter((m) => !isServerNote(m))
          .map(messageJson),
        instructions,
        execution: {
          provider: agent.provider,
          model: agent.model,
          effort: agent.effort,
          agent_name: agent.name,
          // The runner runs this before the harness; a failure spends no model tokens.
          check: parseAgentSandbox(agent.sandbox_json).check ?? null,
          ...taskOptions(j.meta_json),
        },
        protocol_version: RUNNER_PROTOCOL_VERSION,
        ...(turn
          ? {
              turn: {
                id: turn.id,
                ordinal: turn.ordinal,
                body_md: turn.body_md,
                // No earlier turn finished (each was interrupted or failed before answering),
                // so there is no conversation to continue: the runner starts one.
                fresh:
                  turn.ordinal > 1 &&
                  !(await meta.jobExecution?.turns(j.id, j.org_id))?.some(
                    (t) =>
                      t.ordinal < turn.ordinal &&
                      (t.has_checkpoint || t.status === "succeeded" || t.status === "needs_you"),
                  ),
                previous: await (async () => {
                  const previous = await meta.jobExecution?.checkpoint(j.id, j.org_id, turn.ordinal)
                  if (!previous?.session_id || !previous.checkpoint_enc || !deps.encryptionKey)
                    return null
                  const checkpoint = decryptSecret(previous.checkpoint_enc, deps.encryptionKey)
                  if (checkpoint === previous.checkpoint_enc) return null
                  return { session_id: previous.session_id, checkpoint: JSON.parse(checkpoint) }
                })(),
              },
            }
          : {}),
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
    const agent = await runnerFor(c, held.agent_id, held.id)
    if (agent instanceof Response) return agent.status === 403 ? fail(c, 404, "not found") : agent
    const b = await readJson(
      c,
      z.object({
        started_at: z.string().nullable(),
        protocol_version: z.literal(RUNNER_PROTOCOL_VERSION).optional(),
        turn_id: z.string().max(64).optional(),
        session_id: z.string().max(200).nullish(),
        checkpoint: z
          .object({
            version: z.literal(1),
            provider: z.enum(["codex", "claude-code"]),
            session_id: z.string().max(200),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            files: z.record(z.string(), z.string().max(8_000_000)),
          })
          .refine(
            (v) => Object.keys(v.files).length <= 10 && JSON.stringify(v).length <= 8_500_000,
            "The checkpoint exceeds its supported size",
          )
          .nullish(),
        status: z.enum(["succeeded", "failed", "needs_you", "progress"]),
        body_md: z.string().max(200_000).nullish(),
        result: JobResultSchema.omit({ compute: true, attempt_offset: true }).nullish(),
        needs: JobNeedsSchema.nullish(),
        cost_micro_usd: z.number().int().nonnegative().nullish(),
        retryable: z.boolean().optional(),
        meta: z.record(z.string(), z.unknown()).nullish(),
        report_artifact_id: z.string().nullish(),
        report_short_id: z.string().max(64).nullish(),
        events: z
          .array(
            z.object({
              seq: z.number().int().min(1).max(500),
              kind: z.enum([
                "command_execution",
                "file_change",
                "mcp_tool_call",
                "web_search",
                "plan_update",
                "tool_use",
              ]),
              label: z.string().max(160).optional(),
            }),
          )
          .max(100)
          .optional(),
      }),
    )
    if (b instanceof Response) return b
    // A report page must be one this agent made (its first version is the agent's), in the
    // job's workspace: pointing a job at a teammate's page would show it to everyone watching
    // the job, and the next turn would write over it. Runners name it by the short id their
    // publish returned.
    const { report_short_id, checkpoint, events, ...reportFields } = b
    if (b.turn_id && b.protocol_version !== RUNNER_PROTOCOL_VERSION)
      return fail(c, 409, "This runner needs an update before it can report cloud turns.")
    if (checkpoint) {
      const problem = checkpointProblem(checkpoint)
      if (problem || sha256(JSON.stringify(checkpoint.files)) !== checkpoint.sha256)
        return fail(c, 400, problem ?? "The checkpoint checksum does not match.")
    }
    if (checkpoint && (!deps.encryptionKey || checkpoint.session_id !== b.session_id))
      return fail(c, 400, "The checkpoint does not match this conversation.")
    const report = {
      ...reportFields,
      ...(checkpoint && deps.encryptionKey
        ? {
            checkpoint_enc: encryptSecret(JSON.stringify(checkpoint), deps.encryptionKey),
          }
        : {}),
    }
    if (report_short_id || report.report_artifact_id) {
      const art = report_short_id
        ? await meta.getByShortId(report_short_id).catch(() => null)
        : await meta.getArtifactById(report.report_artifact_id ?? "").catch(() => null)
      const first = art ? await meta.getVersion(art.id, 1).catch(() => null) : null
      if (!art || art.org_id !== agent.org_id || first?.agent_id !== agent.id)
        return fail(c, 400, "a report must be a page this agent made")
      // A report is the job's record, private to the workspace (members open it, no link,
      // listed nowhere) when it is first attached, whatever the runner published it as: an
      // older runner made its report pages with the workspace's sharing defaults. Sharing it
      // further afterwards is a person's choice, so a later attach of the same page keeps it.
      report.report_artifact_id = art.id
    }
    if (events?.length && b.turn_id && b.started_at && held.status === "running") {
      if (!(await meta.jobExecution?.append(held.id, held.org_id, b.turn_id, b.started_at, events)))
        return fail(c, 409, "This event stream belongs to an old claim.")
    }
    const out = await reportJob(jobDeps, agent, c.req.param("id"), report)
    if ("error" in out) return fail(c, out.status as 404 | 409, out.error)
    if (
      report.report_artifact_id &&
      held.report_artifact_id !== report.report_artifact_id &&
      out.job.report_artifact_id === report.report_artifact_id
    )
      await meta.setAccess(report.report_artifact_id, "member", "none", "none", null)
    if (b.status !== "progress") await wakeCloud(c, out.job)
    // A graph step settled: move its graph on now rather than at the next tick.
    if (out.job.parent_id && out.job.status !== "running") {
      const parent = await meta.getJob(out.job.parent_id)
      if (parent?.kind === "graph")
        await advanceGraph(jobDeps, parent).catch((e) =>
          log.warn("graph advance deferred", { job: parent.id, reason: runtimeFailureReason(e) }),
        )
    }
    return c.json({ job: await showOne(out.job) })
  })

  // The one job a Derive machine's runner was launched for, shaped like a pull's entry.
  app.get("/v1/jobs/:id/work", async (c) => {
    c.header("Cache-Control", "no-store")
    const job = await meta.getJob(c.req.param("id"))
    if (!job) return fail(c, 404, "not found")
    const agent = await runnerFor(c, job.agent_id, job.id)
    if (agent instanceof Response) return agent.status === 403 ? fail(c, 404, "not found") : agent
    if (!ctx.agentJobScope(c)) return fail(c, 403, "a job token is required")
    if (job.status !== "running") return fail(c, 409, "this job is not running")
    if (c.req.query("protocol_version") !== String(RUNNER_PROTOCOL_VERSION))
      return fail(c, 409, "This sandbox runner needs an update before the task can start.")
    const [work] = await payload(agent, [job])
    return c.json({ job: work })
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

  // The task's repository credential: an installation token for that one repository, minted
  // from a GitHub connection bound to the agent whose account owns it. It lives about an hour
  // and only for this claim; the runner hands it to git and the harness, never to disk.
  app.get("/v1/jobs/:id/git", async (c) => {
    c.header("Cache-Control", "no-store")
    const held = await heldJob(c)
    if (held instanceof Response) return held
    const { agent, job } = held
    const repo = taskOptions(job.meta_json).repo
    if (!repo) return fail(c, 404, "This task has no repository")
    if (!deps.encryptionKey) return fail(c, 503, "Secret encryption is not configured")
    const [full = "", ref = null] = repo.split("@")
    const [owner = "", name = ""] = full.split("/")
    const github = (
      await spendableConnections(meta, agent.org_id, parseConnectionIds(agent.connection_ids_json))
    ).find(
      (cn) => cn.kind === "github_app" && cn.scopes_label?.toLowerCase() === owner.toLowerCase(),
    )
    if (!github)
      return fail(c, 409, `Bind a GitHub connection for ${owner} to this agent to work in ${full}.`)
    try {
      const token = await bearerFor(meta, github, deps.encryptionKey, "code-write", name)
      return c.json({ repo: full, ref, token })
    } catch (error) {
      // An App without Contents: write still reads: the task checks out and works, and only a
      // push fails, with GitHub's own answer.
      const token = await bearerFor(meta, github, deps.encryptionKey, "contents-read", name).catch(
        () => null,
      )
      if (token) return c.json({ repo: full, ref, token, read_only: true })
      return fail(c, 409, `GitHub refused a token for ${full}: ${(error as Error).message}`)
    }
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

  // The account id and ciphertext are pinned; a stale refresh cannot replace a reconnect.
  // authz-exempt: heldJob pins this write to the authenticated live claim.
  app.post("/v1/jobs/:id/account", async (c) => {
    c.header("Cache-Control", "no-store")
    const held = await heldJob(c)
    if (held instanceof Response) return held
    if (!deps.encryptionKey) return fail(c, 503, "Secret encryption is not configured")
    const b = await readJson(
      c,
      z.object({
        account_id: z.string(),
        credential_version: z.string().length(64),
        secret: z.string().min(8).max(20000),
      }),
    )
    if (b instanceof Response) return b
    const current = await resolveJobCredential(
      meta,
      deps.encryptionKey,
      held.agent,
      held.job,
      "codex",
    )
    if (
      !current.credential ||
      current.credential.kind !== "login" ||
      current.account_id !== b.account_id ||
      current.credential_version !== b.credential_version
    )
      return c.json({ refreshed: false })
    const account = await meta.getAccount(b.account_id)
    if (!account?.secret_enc || sha256(account.secret_enc) !== b.credential_version)
      return c.json({ refreshed: false })
    const login = z.object({
      tokens: z.object({ access_token: z.string().min(8), account_id: z.string().min(1) }),
    })
    try {
      const before = login.parse(JSON.parse(current.credential.value))
      const after = login.parse(JSON.parse(b.secret))
      if (before.tokens.account_id !== after.tokens.account_id)
        return fail(c, 400, "Account identity changed")
    } catch {
      return fail(c, 400, "Invalid login")
    }
    const updated = await meta.updateAccount(
      account.id,
      account.org_id,
      {
        secret_enc: encryptSecret(b.secret, deps.encryptionKey),
        status: "ready",
      },
      account.secret_enc,
    )
    return c.json({ refreshed: !!updated })
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
    if (agent.machine === "derive" && b.tool.startsWith(JOB_TOOL_PREFIX)) {
      const own = await buildJobTools(ctx, agent)
      if (!own) return fail(c, 403, "this agent's creator no longer has a seat here")
      const result = await own.execute(b.tool.slice(JOB_TOOL_PREFIX.length), b.args ?? {})
      return c.json({ result })
    }
    const connIds = parseConnectionIds(agent.connection_ids_json)
    if (connIds.length === 0) return fail(c, 403, "this agent has no sources")
    const broker = await brokerFor(
      meta,
      agent.org_id,
      agent.created_by,
      deps.encryptionKey,
      deps.allowEchoStub,
    )
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
