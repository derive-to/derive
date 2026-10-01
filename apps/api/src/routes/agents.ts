import { randomUUID } from "node:crypto"
import {
  type AgentRecord,
  capRole,
  JOB_OPEN_STATUSES,
  newId,
  normalizeSelectors,
  type Role,
  type TriggerRecord,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { connectionBindError } from "../lib/broker"
import { readEnvironmentBindings } from "../lib/context-environment"
import { sha256 } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"
import { machineWorkspaces, retireSandbox } from "../lib/job-machine"
import { canAskAgent, cancelJob, canManageAgent } from "../lib/jobs"
import { previousOccurrence } from "../lib/schedule"

/** Agent registry (Admin-managed) + the agent's pull inbox of @mentions. The Agent +
 *  ConnectedAgent response schemas are the single source for the web client's types
 *  (generated from the OpenAPI spec). The agent inbox endpoints (bearer-authed, consumed
 *  by agents not the web UI) stay plain routes. */
export const agentRoutes = (ctx: AppContext) => {
  const { meta, deps, agentFor, privateOwnerId, requireUser, requireWorkspace } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const parseIds = (raw: string | null): string[] => {
    try {
      const v = raw ? (JSON.parse(raw) as unknown) : []
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
    } catch {
      return []
    }
  }
  const agentJson = (a: AgentRecord, extra: { instructions_short_id?: string | null } = {}) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    managed: a.managed === 1,
    created_by: a.created_by,
    created_at: a.created_at,
    description: a.description,
    instructions_short_id: extra.instructions_short_id ?? null,
    machine: a.machine,
    provider: a.provider,
    model: a.model,
    ask_policy: a.ask_policy,
    write_policy: a.write_policy,
    paused: a.paused_at !== null,
    seen_at: a.seen_at,
    max_run_ms: a.max_run_ms,
    max_concurrency: a.max_concurrency,
    connection_ids: parseIds(a.connection_ids_json),
    environment_names: Object.keys(readEnvironmentBindings(a.environment_json)),
    account_id: a.account_id,
  })

  const triggerJson = (t: TriggerRecord) => ({
    id: t.id,
    agent_id: t.agent_id,
    kind: t.kind,
    cron: t.cron,
    tz: t.tz,
    on_event: t.on_event,
    instruction: t.instruction,
    subject: t.subject_json ? (JSON.parse(t.subject_json) as unknown as object) : null,
    enabled: t.enabled === 1,
    revision: t.revision,
    created_at: t.created_at,
  })

  /** The short id of an agent's instructions artifact, for the wire. */
  const instructionsShortId = async (a: AgentRecord): Promise<string | null> =>
    a.instructions_artifact_id
      ? ((await meta.getArtifactById(a.instructions_artifact_id).catch(() => null))?.short_id ??
        null)
      : null

  // A workspace-registered agent, without its token hash.
  const Agent = z
    .object({
      id: z.string(),
      name: z.string(),
      role: z
        .enum(["viewer", "commenter", "editor", "owner"])
        .describe(
          "Permission level; commenter comments only, editor can write, owner never allowed. Defaults to editor, capped at the creator's seat.",
        ),
      managed: z
        .boolean()
        .describe(
          "Auto-minted for one context at creation — the context's Derive access, not a user-named persona. Hidden from the roster UI.",
        ),
      created_by: z
        .string()
        .nullable()
        .describe("The user who registered the agent — who it publishes and bills on behalf of."),
      created_at: z.string(),
      description: z.string().nullable().describe("One line: what this agent does."),
      instructions_short_id: z
        .string()
        .nullable()
        .describe("The artifact it reads before every job. Null for a connected tool."),
      machine: z
        .enum(["owner", "derive"])
        .describe("Where its jobs run: the owner's runner or MCP session, or a Derive sandbox."),
      provider: z.enum(["claude-code", "codex"]).describe("Which coding agent runs its jobs."),
      model: z.string().nullable(),
      ask_policy: z.enum(["workspace", "invited"]),
      write_policy: z
        .enum(["publish", "review"])
        .describe(
          "publish: its writes go live like a person's. review: they still go live, and every new version it writes to an existing page opens a review round for the person it acts for.",
        ),
      paused: z.boolean(),
      seen_at: z.string().nullable().describe("When its runner last pulled work."),
      max_run_ms: z.number().nullable(),
      max_concurrency: z.number(),
      connection_ids: z.array(z.string()).describe("Sources it can reach."),
      environment_names: z
        .array(z.string())
        .describe("Environment variable names bound to credentials. Never values."),
      account_id: z.string().nullable(),
    })
    .openapi("Agent")

  const Trigger = z
    .object({
      id: z.string(),
      agent_id: z.string(),
      kind: z.enum(["schedule", "event"]),
      cron: z.string().nullable(),
      tz: z.string().nullable(),
      on_event: z.string().nullable(),
      instruction: z.string(),
      subject: z
        .union([
          z.object({ kind: z.literal("artifact"), id: z.string() }),
          z.object({ kind: z.literal("collection"), id: z.string() }),
          z.object({ kind: z.literal("tag"), tag: z.string() }),
        ])
        .nullable(),
      enabled: z.boolean(),
      revision: z.number(),
      created_at: z.string(),
    })
    .openapi("AgentTrigger")

  // An OAuth agent the signed-in user authorized to act on their behalf.
  const ConnectedAgent = z
    .object({
      clientId: z
        .string()
        .describe("OAuth client id of the authorized agent (e.g. an MCP client like Claude)"),
      clientName: z.string(),
      scopes: z.array(z.string()).describe("The OAuth scopes this agent was granted"),
      grantedAt: z.string(),
    })
    .openapi("ConnectedAgent")

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/agents",
      tags: ["Agents"],
      summary: "List the workspace's agents. Every member sees them, like the work they do.",
      responses: {
        200: {
          description: "The workspace's agents.",
          content: {
            "application/json": {
              schema: z.object({
                agents: z.array(
                  Agent.extend({
                    triggers: z.array(Trigger),
                    last_job_at: z
                      .string()
                      .nullable()
                      .describe("When it last had work, among the workspace's recent jobs."),
                  }),
                ),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)
      const agents = await meta.listAgents(org)
      // What the Agents screen groups by, in two queries rather than one per agent: each
      // agent's schedules, and when it last had work.
      const triggers = await meta.listTriggers(org)
      const recent = await meta.listJobs({ orgId: org, limit: 200 })
      const lastJob = new Map<string, string>()
      for (const j of recent) if (!lastJob.has(j.agent_id)) lastJob.set(j.agent_id, j.created_at)
      // Every agent's instructions page, in one lookup rather than one per agent.
      const pageIds = [
        ...new Set(agents.map((a) => a.instructions_artifact_id).filter((x): x is string => !!x)),
      ]
      const pages = pageIds.length ? await meta.getArtifactsByIds(pageIds).catch(() => []) : []
      const shortOf = new Map(pages.map((p) => [p.id, p.short_id]))
      return c.json({
        agents: agents.map((a) => ({
          ...agentJson(a, {
            instructions_short_id: a.instructions_artifact_id
              ? (shortOf.get(a.instructions_artifact_id) ?? null)
              : null,
          }),
          triggers: triggers.filter((t) => t.agent_id === a.id).map(triggerJson),
          last_job_at: lastJob.get(a.id) ?? null,
        })),
      })
    },
  )

  /** Who is managing `agent` in this request, or null. A signed-in person or an owner-scope
   *  grant manages what canManageAgent allows (their own agents, or any as workspace owner). A
   *  narrower grant, such as the publish grant a coding session creates agents with, manages
   *  only the agents its person created. */
  const managerOf = async (
    c: Parameters<typeof requireUser>[0],
    agent: AgentRecord | null | undefined,
  ): Promise<string | null> => {
    if (!agent) return null
    const full = await ctx.managementPrincipal(c)
    if (full) return (await canManageAgent(meta, agent, full)) ? full : null
    const who = await ctx.actingHuman(c)
    const caller = await ctx.agentFor(c)
    if (!who || !caller?.id.startsWith("oauth:") || caller.org_id !== agent.org_id) return null
    if (!(await ctx.workspaceCan(c, "publish"))) return null
    return (await canManageAgent(meta, agent, who.id)) && agent.created_by === who.id
      ? who.id
      : null
  }

  /** Refuse a definition the manager could not grant: a role above their own seat, or
   *  connections they may not attach (a teammate's personal ones; workspace ones without
   *  manage). The agent acts with these, so they are checked where they are set. */
  const definitionError = async (
    c: Parameters<typeof requireUser>[0],
    org: string,
    manager: string | null,
    b: { role?: unknown; connection_ids?: string[] },
  ): Promise<string | null> => {
    if (typeof b.role === "string" && manager) {
      const seat = (await meta.getMembership(org, manager).catch(() => null))?.role
      if (!seat || capRole(b.role as Role, seat) !== b.role)
        return "an agent's role cannot be above your own"
    }
    if (b.connection_ids?.length)
      return connectionBindError(
        meta,
        org,
        { userId: manager, canManage: await ctx.workspaceCan(c, "manage") },
        b.connection_ids,
      )
    return null
  }

  const openJobs = (orgId: string, agentId: string) =>
    meta.listJobs({ orgId, agentId, status: [...JOB_OPEN_STATUSES], limit: 200 })

  // What an agent's definition may say, on create and on edit. Everything optional on edit.
  const AgentFields = z.object({
    name: z.string().trim().min(1).max(80),
    role: z.enum(["viewer", "commenter", "editor"]),
    description: z.string().trim().max(280).nullable(),
    instructions_short_id: z.string().min(1).max(64).nullable(),
    machine: z.enum(["owner", "derive"]),
    provider: z.enum(["claude-code", "codex"]),
    model: z.string().trim().min(1).max(120).nullable(),
    ask_policy: z.enum(["workspace", "invited"]),
    write_policy: z.enum(["publish", "review"]),
    connection_ids: z.array(z.string().min(1).max(64)).max(20),
    max_run_ms: z
      .number()
      .int()
      .min(30_000)
      .max(6 * 60 * 60_000)
      .nullable(),
    max_concurrency: z.number().int().min(1).max(10),
  })
  const ScheduleInput = z.object({
    cron: z.string().trim().min(1).max(120),
    tz: z.string().trim().min(1).max(64).default("UTC"),
    instruction: z.string().trim().min(1).max(20_000),
    subject: z.unknown().optional(),
  })

  /** The artifact an agent's instructions live in, if the caller may read it and it is in this
   *  workspace. */
  const instructionsFor = async (
    c: Parameters<typeof requireUser>[0],
    org: string,
    shortId: string,
  ) => {
    const art = await ctx.requireArtifact(c, "read", { shortId })
    if (art instanceof Response) return null
    return art.org_id === org ? art : null
  }
  const validCron = (cron: string, tz: string) => {
    try {
      previousOccurrence(cron, tz, new Date())
      return previousOccurrence(cron, tz, new Date()) !== null
    } catch {
      return false
    }
  }

  // Create an agent. Its key is returned ONCE here; only its SHA-256 hash is stored, so a
  // database leak cannot expose usable credentials. An agent on the owner's machine also gets the
  // one command that starts its runner. Any publishing member may create an agent; it acts on
  // their behalf. Owner is never allowed as an agent's role.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/agents",
      tags: ["Agents"],
      summary: "Create an agent and mint its key (returned once).",
      responses: {
        201: {
          description: "The created agent, its key (shown only here), and how to run it.",
          content: {
            "application/json": {
              schema: Agent.extend({
                token: z.string(),
                runner_command: z.string().nullable(),
                trigger: Trigger.nullable(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "publish")
      if (org instanceof Response) return bail(org)
      const b = await readJson(
        c,
        AgentFields.partial().extend({
          name: z.string().refine((s) => s.trim() !== "", "name required"),
          role: z.unknown().optional(),
          schedule: ScheduleInput.optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      const name = b.name.trim()
      const asked: Role | null =
        b.role === "viewer" || b.role === "commenter" || b.role === "editor" ? b.role : null
      let instructionsId: string | null = null
      if (b.instructions_short_id) {
        const art = await instructionsFor(c, org, b.instructions_short_id)
        if (!art)
          return bail(fail(c, 400, "instructions must be a page in this workspace you can read"))
        instructionsId = art.id
      }
      const creator = (await privateOwnerId(c)) ?? null
      const refused = await definitionError(c, org, creator, b)
      if (refused) return bail(fail(c, 400, refused))
      // No role named: an editor, so it can publish the reports its jobs produce, capped at its
      // creator's own seat (a commenter's agent comments). A role named above that seat was
      // refused just above. Nobody to cap by: a commenter.
      const seat = creator
        ? (await meta.getMembership(org, creator).catch(() => null))?.role
        : undefined
      const role: Role = asked ?? (seat ? capRole("editor", seat) : "commenter")
      if (b.machine === "derive" && !machineWorkspaces(deps.runtime).has(org))
        return bail(
          fail(c, 400, "Derive machines are not turned on for this workspace; use machine: owner"),
        )
      if (b.schedule && !validCron(b.schedule.cron, b.schedule.tz))
        return bail(fail(c, 400, "schedule.cron is not a valid cron expression for that timezone"))
      const token = `dk_agt_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`
      let agent: AgentRecord
      try {
        agent = await meta.createAgent({
          id: newId("ag"),
          org_id: org,
          name,
          token: sha256(token),
          role,
          // The agent acts on behalf of whoever created it: their id keys attribution
          // (author_id) and ownership at publish. privateOwnerId so a creation from an OAuth
          // session attributes to the GRANTOR, not to nobody.
          created_by: creator,
          description: b.description ?? null,
          instructions_artifact_id: instructionsId,
          machine: b.machine ?? "owner",
          provider: b.provider ?? "claude-code",
          model: b.model ?? null,
          ask_policy: b.ask_policy ?? "workspace",
          write_policy: b.write_policy ?? "publish",
          connection_ids_json: b.connection_ids?.length ? JSON.stringify(b.connection_ids) : null,
          max_run_ms: b.max_run_ms ?? null,
          max_concurrency: b.max_concurrency ?? 1,
        })
      } catch {
        return bail(fail(c, 409, "an agent with that name already exists"))
      }
      const trigger = b.schedule
        ? await meta.createTrigger({
            id: newId("trg"),
            org_id: org,
            agent_id: agent.id,
            kind: "schedule",
            cron: b.schedule.cron,
            tz: b.schedule.tz,
            instruction: b.schedule.instruction,
            subject_json: b.schedule.subject
              ? JSON.stringify(normalizeSelectors([b.schedule.subject])[0] ?? null)
              : null,
          })
        : null
      const server = deps.baseUrl?.replace(/\/+$/, "") ?? "https://derive.to"
      const runner_command =
        agent.machine === "owner"
          ? `DERIVE_TOKEN=${token} npx -y @derive-to/cli runner serve --agent ${agent.id} --server ${server}`
          : null
      // The only place the raw key is ever exposed.
      return c.json(
        {
          ...agentJson(agent, { instructions_short_id: b.instructions_short_id ?? null }),
          token,
          runner_command,
          trigger: trigger ? triggerJson(trigger) : null,
        },
        201,
      )
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/agents/{id}",
      tags: ["Agents"],
      summary: "One agent, with its schedules. Any member of its workspace can read it.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The agent.",
          content: {
            "application/json": {
              schema: Agent.extend({
                triggers: z.array(Trigger),
                can_ask: z.boolean(),
                can_manage: z.boolean(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const who = await ctx.actingHuman(c)
      if (!who) return bail(fail(c, 401, "unauthenticated"))
      const org = await requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)
      const agent = await meta.getAgent(c.req.param("id"))
      if (!agent || agent.org_id !== org || !(await meta.getMembership(org, who.id)))
        return bail(fail(c, 404, "agent not found"))
      return c.json({
        ...agentJson(agent, {
          instructions_short_id: await instructionsShortId(agent),
        }),
        triggers: (await meta.listTriggers(agent.org_id, agent.id)).map(triggerJson),
        can_ask: await canAskAgent(meta, agent, who.id),
        can_manage: (await managerOf(c, agent)) !== null,
      })
    },
  )

  // Edit an agent: its creator or a workspace owner.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/agents/{id}",
      tags: ["Agents"],
      summary: "Edit an agent (its creator or a workspace owner).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The updated agent.",
          content: { "application/json": { schema: Agent } },
        },
      },
    }),
    async (c) => {
      const agent = await meta.getAgent(c.req.param("id"))
      const who = await managerOf(c, agent)
      if (!agent || !who) return bail(fail(c, 404, "agent not found"))
      const org = agent.org_id
      const b = await readJson(
        c,
        AgentFields.partial().extend({
          paused: z.boolean().optional(),
          account_id: z.string().min(1).max(64).nullable().optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      let instructions_artifact_id: string | null | undefined
      if (b.instructions_short_id !== undefined) {
        if (b.instructions_short_id === null) instructions_artifact_id = null
        else {
          const art = await instructionsFor(c, org, b.instructions_short_id)
          if (!art)
            return bail(fail(c, 400, "instructions must be a page in this workspace you can read"))
          instructions_artifact_id = art.id
        }
      }
      const refused = await definitionError(c, org, who, b)
      if (refused) return bail(fail(c, 400, refused))
      if (b.machine === "derive" && !machineWorkspaces(deps.runtime).has(org))
        return bail(
          fail(c, 400, "Derive machines are not turned on for this workspace; use machine: owner"),
        )
      // An agent may run on its manager's own account or a shared one, never a teammate's.
      if (b.account_id) {
        const acct = await meta.getAccount(b.account_id)
        if (
          !acct ||
          acct.org_id !== org ||
          (acct.user_id !== who && acct.user_id !== "__workspace__")
        )
          return bail(fail(c, 400, "account must be yours or a shared workspace account"))
      }
      let updated: AgentRecord | null
      try {
        updated = await meta.updateAgent(agent.id, org, {
          name: b.name,
          role: b.role,
          description: b.description,
          instructions_artifact_id,
          machine: b.machine,
          provider: b.provider,
          model: b.model,
          ask_policy: b.ask_policy,
          write_policy: b.write_policy,
          connection_ids_json:
            b.connection_ids === undefined
              ? undefined
              : b.connection_ids.length
                ? JSON.stringify(b.connection_ids)
                : null,
          max_run_ms: b.max_run_ms,
          max_concurrency: b.max_concurrency,
          account_id: b.account_id,
          paused_at:
            b.paused === undefined ? undefined : b.paused ? new Date().toISOString() : null,
        })
      } catch {
        return bail(fail(c, 409, "an agent with that name already exists"))
      }
      if (!updated) return bail(fail(c, 404, "agent not found"))
      return c.json(
        agentJson(updated, {
          instructions_short_id: await instructionsShortId(updated),
        }),
      )
    },
  )

  // ---- Schedules --------------------------------------------------------------------------

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/agents/{id}/triggers",
      tags: ["Agents"],
      summary: "Add a schedule to an agent.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        201: { description: "The schedule.", content: { "application/json": { schema: Trigger } } },
      },
    }),
    async (c) => {
      const agent = await meta.getAgent(c.req.param("id"))
      const who = await managerOf(c, agent)
      if (!agent || !who) return bail(fail(c, 404, "agent not found"))
      const b = await readJson(c, ScheduleInput)
      if (b instanceof Response) return bail(b)
      if (!validCron(b.cron, b.tz))
        return bail(fail(c, 400, "cron is not a valid cron expression for that timezone"))
      const t = await meta.createTrigger({
        id: newId("trg"),
        org_id: agent.org_id,
        agent_id: agent.id,
        kind: "schedule",
        cron: b.cron,
        tz: b.tz,
        instruction: b.instruction,
        subject_json: b.subject ? JSON.stringify(normalizeSelectors([b.subject])[0] ?? null) : null,
      })
      return c.json(triggerJson(t), 201)
    },
  )

  const triggerOwner = async (c: Parameters<typeof requireUser>[0]) => {
    const t = await meta.getTrigger(c.req.param("id") ?? "")
    const agent = t ? await meta.getAgent(t.agent_id) : null
    if (!t || !agent || !(await managerOf(c, agent))) return fail(c, 404, "schedule not found")
    return t
  }

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/triggers/{id}",
      tags: ["Agents"],
      summary: "Change or pause a schedule.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "The schedule.", content: { "application/json": { schema: Trigger } } },
      },
    }),
    async (c) => {
      const t = await triggerOwner(c)
      if (t instanceof Response) return bail(t)
      const b = await readJson(
        c,
        ScheduleInput.partial().extend({ enabled: z.boolean().optional() }),
      )
      if (b instanceof Response) return bail(b)
      const cron = b.cron ?? t.cron ?? ""
      const tz = b.tz ?? t.tz ?? "UTC"
      if ((b.cron || b.tz) && !validCron(cron, tz))
        return bail(fail(c, 400, "cron is not a valid cron expression for that timezone"))
      const updated = await meta.updateTrigger(t.id, t.org_id, {
        cron: b.cron,
        tz: b.tz,
        instruction: b.instruction,
        subject_json:
          b.subject === undefined
            ? undefined
            : JSON.stringify(normalizeSelectors([b.subject])[0] ?? null),
        enabled: b.enabled === undefined ? undefined : b.enabled ? 1 : 0,
      })
      if (!updated) return bail(fail(c, 404, "schedule not found"))
      return c.json(triggerJson(updated))
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/triggers/{id}",
      tags: ["Agents"],
      summary: "Remove a schedule.",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "Removed." } },
    }),
    async (c) => {
      const t = await triggerOwner(c)
      if (t instanceof Response) return bail(t)
      await meta.deleteTrigger(t.id, t.org_id)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/agents/{id}/rotate",
      tags: ["Agents"],
      summary:
        "Replace an agent's key (its creator or a workspace owner); the old one dies at once.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The agent, plus its NEW bearer token (shown only here).",
          content: { "application/json": { schema: Agent.extend({ token: z.string() }) } },
        },
      },
    }),
    async (c) => {
      const target = await meta.getAgent(c.req.param("id"))
      if (!target || !(await managerOf(c, target))) return bail(fail(c, 404, "agent not found"))
      const org = target.org_id
      // Same mint shape as registration; only the hash is stored. Identity, role,
      // hosting, and attribution are untouched — rotation is a credential event,
      // never an identity event.
      const token = `dk_agt_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`
      const rotated = await meta.rotateAgentToken(c.req.param("id"), org, sha256(token))
      if (!rotated) return bail(fail(c, 404, "agent not found"))
      return c.json({
        ...agentJson(rotated, {
          instructions_short_id: await instructionsShortId(rotated),
        }),
        token,
      })
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/agents/{id}",
      tags: ["Agents"],
      summary: "Delete an agent (its creator or a workspace owner).",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "The agent was deleted." } },
    }),
    async (c) => {
      const target = await meta.getAgent(c.req.param("id"))
      if (!target || !(await managerOf(c, target))) return bail(fail(c, 404, "agent not found"))
      const org = target.org_id
      const id = target.id
      await retireSandbox(deps.runtime, deps.runtimeFetch, target)
      // Scope the delete to the caller's workspace: deleteAgent is keyed by
      // (id, org) so an Admin can't delete another workspace's agent by id.
      await meta.deleteAgent(id, org)
      // Its open work and its schedules have nobody left to serve them.
      for (let open = await openJobs(org, id); open.length; open = await openJobs(org, id)) {
        let moved = 0
        // No announce: the agent row is gone, so there is nobody to say it on behalf of.
        for (const j of open) if (await cancelJob({ meta, bus: ctx.backplane }, j)) moved++
        if (moved === 0) break
      }
      for (const t of await meta.listTriggers(org, id)) await meta.deleteTrigger(t.id, org)
      // Drop it from the owner-lend list so stale ids don't accumulate in org settings.
      const settings = await meta.getOrgSettings(org)
      if (settings.ownerLendAgents?.includes(id))
        await meta.setOrgSettings(org, {
          ...settings,
          ownerLendAgents: settings.ownerLendAgents.filter((a) => a !== id),
        })
      return c.body(null, 204)
    },
  )

  // ---- Connected agents (delegation provenance + revocation) --------------
  // The OAuth agents the SIGNED-IN USER has authorized to act on their behalf (MCP clients
  // like Claude that went through the browser consent) — distinct from workspace-registered
  // agents above. Listing + one-tap revocation make delegation legible and reversible: the
  // human can always see what may act as them and cut it off. Scoped to the caller's own
  // grants, never another user's.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/me/connected-agents",
      tags: ["Agents"],
      summary: "List the OAuth agents the signed-in user authorized to act on their behalf.",
      responses: {
        200: {
          description: "The caller's connected agents.",
          content: {
            "application/json": { schema: z.object({ agents: z.array(ConnectedAgent) }) },
          },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      return c.json({ agents: await meta.listUserGrants(me.id) })
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/me/connected-agents/{clientId}",
      tags: ["Agents"],
      summary: "Revoke a connected agent's authorization.",
      request: { params: z.object({ clientId: z.string() }) },
      responses: { 204: { description: "The grant was revoked (idempotent)." } },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      await meta.revokeUserGrant(me.id, c.req.param("clientId"))
      return c.body(null, 204)
    },
  )

  // The agent's pull inbox: mentions awaiting a response. Auth = the agent's own bearer
  // token; consumed by agents, not the web UI — plain routes (not in the spec).
  app.get("/v1/agent/inbox", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20))
    const mentions = await meta.listPendingAgentMentions(agent.id, limit)
    return c.json({
      agent: agentJson(agent),
      mentions: mentions.map((m) => ({
        id: m.id,
        artifact: m.artifact_short_id,
        comment_id: m.comment_id,
        thread_id: m.thread_id,
        body: m.body,
        author: m.author,
        created_at: m.created_at,
      })),
    })
  })

  app.post("/v1/agent/mentions/:id/ack", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    const ok = await meta.ackAgentMention(agent.id, c.req.param("id"))
    return ok ? c.json({ ok: true }) : fail(c, 404, "not found")
  })

  return app
}
