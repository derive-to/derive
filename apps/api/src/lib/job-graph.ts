import {
  type AgentRecord,
  type BlobStore,
  isJobOpen,
  type JobRecord,
  type JobResult,
  jobResult,
  type MetaStore,
  newId,
  type WorkflowDiagramDefinition,
  type WorkflowNodeDefinition,
  workflowDefinitionOf,
} from "@derive/core"
import { log } from "../log"
import { agentWritesOff } from "./agent-writes"
import {
  askAgent,
  canAskAgent,
  cancelJob,
  type JobDeps,
  noteHeldForBudget,
  overBudgetFor,
} from "./jobs"
import { runtimeFailureReason } from "./runtime-diagnostics"

// GRAPHS ON JOBS: an agent whose instructions page carries a `derive.workflow/v1` definition is
// a graph. Asking it (or its schedule firing) opens a `graph` job that the server walks: each
// context node becomes a child job for the agent it names, a human node puts the graph at
// needs_you with the authored options, a terminal node ends its branch. No model call routes
// the graph: a node with a choice of next step asks its own agent to name one in its reply
// (`ROUTE: <node>`), and a person's answer picks at a human node. The walk is recorded in the
// graph's result.route, and runners never claim a graph job (claimJobs skips them).
//
// The definition is pinned to the instructions page version the graph started on, so an edit
// mid-run changes the next run, not this one.

export interface GraphDeps extends JobDeps {
  blobs: BlobStore
}

type Route = NonNullable<JobResult["route"]>[number] & { job_id?: string }
interface GraphMeta {
  artifact_id: string
  version: number
  diagram_id: string
  /** When this run started: children from an earlier run of the same job are not this run's. */
  since: string
  /** What this run was asked: the instruction, or the follow-up that reopened it. */
  ask?: string
  /** The human node the graph is waiting on, if any. */
  waiting?: string
  /** Steps where branches meet, waiting for their last branch to finish. */
  pending?: string[]
  /** Until when a pass holds the graph (see PASS_HOLD_MS). */
  pass_until?: string
}

/** A graph job holds no machine; its lease only keeps reclaim off it and is renewed each pass. */
const GRAPH_LEASE_MS = 24 * 60 * 60_000
const ROUTE_LINE = /^\s*ROUTE:\s*(\S+)\s*$/im

const parse = <T>(s: string | null): T | null => {
  if (!s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

// Parsed definitions by page version. A version's bytes never change, so this only grows stale
// by being bounded.
const parsed = new Map<string, ReturnType<typeof workflowDefinitionOf>>()

/** The workflow definition on an agent's instructions page, or null when it is not a graph. */
export async function graphOf(
  deps: GraphDeps,
  agent: AgentRecord,
  version?: number,
): Promise<{ diagram: WorkflowDiagramDefinition; version: number; purpose: string } | null> {
  if (!agent.instructions_artifact_id) return null
  const art = await deps.meta.getArtifactById(agent.instructions_artifact_id).catch(() => null)
  if (!art) return null
  const n = version ?? art.current_version
  const key = `${art.id}@${n}`
  let checked = parsed.get(key)
  if (checked === undefined) {
    const v = await deps.meta.getVersion(art.id, n)
    const bytes = v ? await deps.blobs.get(v.blob_key) : null
    if (!bytes) return null
    checked = workflowDefinitionOf(new TextDecoder().decode(bytes))
    if (parsed.size > 500) parsed.clear()
    parsed.set(key, checked)
  }
  const diagram = checked?.definition?.diagrams[0]
  if (!checked?.definition || checked.errors.length || !diagram) return null
  return { diagram, version: n, purpose: checked.definition.purpose }
}

/** The agent a node's `context_ref` names: an agent id or name, or a Context's id or name (whose
 *  agent row the cutover made the agent), in the graph's own workspace. */
async function nodeAgent(meta: MetaStore, orgId: string, ref: string): Promise<AgentRecord | null> {
  // A managed agent (the hidden principal of an imported paper) is never a step's agent.
  const agents = (await meta.listAgents(orgId)).filter((a) => a.managed !== 1)
  const direct = agents.find((a) => a.id === ref) ?? agents.find((a) => a.name === ref)
  if (direct) return direct
  const ctx =
    (await meta.getContext(ref).catch(() => null)) ??
    (await meta.listContexts(orgId).catch(() => [])).find((c) => c.name === ref) ??
    null
  return ctx?.org_id === orgId ? (agents.find((a) => a.id === ctx.agent_id) ?? null) : null
}

const nodeOf = (d: WorkflowDiagramDefinition, id: string) => d.nodes.find((n) => n.id === id)
const routesFrom = (d: WorkflowDiagramDefinition, id: string) =>
  d.routes.filter((r) => r.from === id)

/** How many times a node may run: its loop's max_attempts, else once. */
const attemptCap = (d: WorkflowDiagramDefinition, id: string) =>
  Math.max(
    1,
    ...(d.loops ?? []).filter((l) => l.nodes.includes(id)).map((l) => l.stop.max_attempts),
  )

/** Which routes leave a settled node. `all` (or a single route) takes every non-fallback one;
 *  `one` takes the one the node's agent named, else the fallback, else the first. */
function chooseRoutes(d: WorkflowDiagramDefinition, node: WorkflowNodeDefinition, reply: string) {
  const out = routesFrom(d, node.id)
  if (node.terminal || out.length === 0) return []
  const normal = out.filter((r) => !r.fallback)
  if (node.routing !== "one" && normal.length) return normal.map((r) => r.to)
  const named = ROUTE_LINE.exec(reply)?.[1]
  const pick = out.find((r) => r.to === named) ?? out.find((r) => r.fallback) ?? normal[0] ?? out[0]
  return pick ? [pick.to] : []
}

/** The routes a person's decision at a human node selects. */
function decide(d: WorkflowDiagramDefinition, node: WorkflowNodeDefinition, decision: string) {
  const out = routesFrom(d, node.id)
  const d0 = decision.trim().toLowerCase()
  const hit = out.find((r) => r.when.trim().toLowerCase() === d0 || r.to.toLowerCase() === d0)
  const pick = hit ?? (out.length === 1 ? out[0] : out.find((r) => r.fallback))
  return pick ? [pick.to] : []
}

const lastReply = async (meta: MetaStore, jobId: string, kind: "agent" | "asker") =>
  [...(await meta.listJobMessages(jobId))].reverse().find((m) => m.author_kind === kind)?.body_md ??
  ""

/** How long one pass holds a graph before another may act on it. */
const PASS_HOLD_MS = 30_000

/** What a waiting graph asks the person, from its human step. */
const needsFor = (node: WorkflowNodeDefinition | undefined) =>
  JSON.stringify({
    kind: "decision",
    question: node?.decision ?? "What should happen next?",
    ...(node?.options?.length ? { options: node.options } : {}),
  })

/** Can the walk get from one step to another along the definition's routes? */
const reaches = (d: WorkflowDiagramDefinition, from: string, to: string): boolean => {
  const seen = new Set<string>()
  const queue = [from]
  while (queue.length) {
    const at = queue.shift() as string
    if (at === to) return true
    if (seen.has(at)) continue
    seen.add(at)
    for (const r of d.routes) if (r.from === at) queue.push(r.to)
  }
  return false
}

/** A pass lost the race for the graph row to another pass; it stops and leaves the rest. */
class Superseded extends Error {}

/** Advance one graph job as far as it can go now. Every write names the row as this pass read
 *  it (updated_at), so two passes over one graph (the tick and a child's report) never both
 *  act: the loser's write fails and it stops. Child jobs are deduped by what opened them, so a
 *  step opened by the winner is found, not opened twice. */
export async function advanceGraph(deps: GraphDeps, given: JobRecord): Promise<void> {
  try {
    await walk(deps, given)
  } catch (error) {
    if (!(error instanceof Superseded)) throw error
  }
}

async function walk(deps: GraphDeps, given: JobRecord): Promise<void> {
  const { meta } = deps
  let job = await meta.getJob(given.id)
  if (!job || job.kind !== "graph") return
  const agent = await meta.getAgent(job.agent_id)
  if (!agent) return
  // A paused graph agent, or a workspace with agent writes off, holds its graphs where they are.
  const now = new Date()
  const at = now.toISOString()
  const lease = new Date(now.getTime() + GRAPH_LEASE_MS).toISOString()
  if (agent.paused_at || (await agentWritesOff(meta, agent.org_id))) {
    // Held, not abandoned: keep the lease so reclaim never restarts it under its children.
    if (job.status === "running")
      await meta.updateJob(job.id, { lease_until: lease }, { status: "running" })
    return
  }
  let g = parse<{ graph?: GraphMeta }>(job.meta_json)?.graph

  const write = async (
    patch: Parameters<MetaStore["updateJob"]>[1],
    status?: JobRecord["status"],
  ) => {
    const current = job as JobRecord
    const next = await meta.updateJob(current.id, patch, {
      updated_at: current.updated_at,
      ...(status ? { status } : {}),
    })
    if (!next) throw new Superseded()
    job = next
    return next
  }
  const openChildren = async (since: string) =>
    (await meta.listJobs({ orgId: agent.org_id, parentId: given.id, limit: 200 })).filter(
      (c) => c.created_at >= since && isJobOpen(c.status),
    )
  const settle = async (status: "succeeded" | "failed", body: string) => {
    await write({
      status,
      finished_at: at,
      lease_until: null,
      dedupe_key: null,
      meta_json: JSON.stringify({
        ...parse(job?.meta_json ?? null),
        graph: g ? { ...g, waiting: undefined, pending: [] } : undefined,
      }),
    })
    await meta.addJobMessage({
      id: newId("jm"),
      job_id: given.id,
      author_kind: "agent",
      author_id: agent.id,
      body_md: body,
    })
    // Only once the graph is settled under this pass: a pass that lost never cancels anything.
    if (g) for (const c of await openChildren(g.since)) await cancelJob(deps, c)
  }

  // Reopened after it settled (a follow-up or a retry) and not waiting on a person: run again
  // from the entry, on the definition as it is now, with the latest message as the ask.
  const prior = g
  if (g && !g.waiting && job.status === "queued") g = undefined
  // A pass holds the graph briefly: another pass that finds the hold backs off (the next tick
  // or report picks up from where the holder left it), so two passes never both act.
  if (g?.pass_until && g.pass_until > at) return
  const hold = new Date(now.getTime() + PASS_HOLD_MS).toISOString()

  const toOpen: { to: string; from: string }[] = []
  if (!g) {
    if (job.status !== "queued") return
    const def = await graphOf(deps, agent)
    const claimed = await meta.claimJob(job.id, lease, at)
    if (!claimed) return
    job = claimed
    // The ask is the follow-up that reopened it, if one did; a retry reruns the original ask.
    const since0 = prior?.since ?? ""
    const followUp = [...(await meta.listJobMessages(job.id))]
      .reverse()
      .find(
        (m) => m.author_kind === "asker" && m.created_at > since0 && !/^Decision:/i.test(m.body_md),
      )
    const ask = prior && followUp ? followUp.body_md : job.instruction
    g = {
      artifact_id: agent.instructions_artifact_id ?? "",
      version: def?.version ?? 0,
      diagram_id: def?.diagram.id ?? "",
      since: at,
      ask,
      pending: [],
    }
    if (!def)
      return settle("failed", "This agent's instructions page no longer holds a valid workflow.")
    await write({
      meta_json: JSON.stringify({ ...parse(job.meta_json), graph: { ...g, pass_until: hold } }),
      result_json: JSON.stringify({ ...jobResult(job), route: [] }),
    })
    toOpen.push({ to: def.diagram.entry, from: "entry" })
  }
  const def = await graphOf(deps, agent, g.version)
  if (!def || def.diagram.id !== g.diagram_id)
    return settle("failed", "The workflow this run started on can no longer be read.")
  const d = def.diagram
  const since = g.since
  const route: Route[] = [...((jobResult(job).route ?? []) as Route[])]
  const children = (
    await meta.listJobs({ orgId: job.org_id, parentId: job.id, limit: 200 })
  ).filter((c) => c.created_at >= since)
  const recorded = new Set(route.map((r) => r.job_id).filter(Boolean))
  let waiting = g.waiting
  const pending = new Set(g.pending ?? [])
  let failure: string | null = null

  if (waiting && job.status === "queued") {
    // A person wrote to the graph while it waited on them. Only a decision moves it on: an
    // answer (`Decision: …`) or a reply naming a route. Anything else puts it back to waiting.
    const node = nodeOf(d, waiting)
    const msg = await lastReply(meta, job.id, "asker")
    const said = /^Decision:\s*(.+)$/im.exec(msg)?.[1]?.trim()
    const out = node ? routesFrom(d, node.id) : []
    const named =
      said ??
      out.find(
        (r) => r.when.trim().toLowerCase() === msg.trim().toLowerCase() || r.to === msg.trim(),
      )?.when
    const next = node && named !== undefined ? decide(d, node, named) : []
    if (!node || next.length === 0) {
      // Not a decision this step can take: back to waiting, with its question.
      await write({ status: "needs_you", needs_json: needsFor(node) }, "queued")
      return
    }
    // Hold first, then claim: a pass that read the row before the hold loses its writes, and
    // one that reads it after backs off, so the decision is consumed by this pass or none.
    await write(
      { meta_json: JSON.stringify({ ...parse(job.meta_json), graph: { ...g, pass_until: hold } }) },
      "queued",
    )
    const claimed = await meta.claimJob(job.id, lease, at)
    if (!claimed) return
    job = claimed
    route.push({
      node_id: node.id,
      attempt: route.filter((r) => r.node_id === node.id).length + 1,
      selected: next,
      decision: named,
    })
    for (const to of next) toOpen.push({ to, from: `decision:${route.length}` })
    waiting = undefined
  } else if (job.status === "running") {
    await write(
      {
        lease_until: lease,
        meta_json: JSON.stringify({ ...parse(job.meta_json), graph: { ...g, pass_until: hold } }),
      },
      "running",
    )
  } else return

  // Children that settled since the last pass move the walk on.
  for (const child of children) {
    if (recorded.has(child.id) || isJobOpen(child.status)) continue
    const node = child.node_id ? nodeOf(d, child.node_id) : undefined
    if (!node) continue
    const attempt = route.filter((r) => r.node_id === node.id).length + 1
    if (child.status === "succeeded") {
      const next = chooseRoutes(d, node, await lastReply(meta, child.id, "agent"))
      route.push({ node_id: node.id, attempt, selected: next, job_id: child.id })
      for (const to of next) toOpen.push({ to, from: child.id })
    } else {
      const fallback = routesFrom(d, node.id).find((r) => r.fallback)
      route.push({
        node_id: node.id,
        attempt,
        selected: fallback ? [fallback.to] : [],
        job_id: child.id,
      })
      if (fallback) toOpen.push({ to: fallback.to, from: child.id })
      else
        failure = `Step "${node.id}" ${child.status === "cancelled" ? "was cancelled" : "failed"}.`
    }
  }
  // Steps where branches meet, waiting for the last of them.
  for (const to of pending) toOpen.push({ to, from: "join" })

  const openNow = children.filter((c) => isJobOpen(c.status))
  const askedBy = job.asked_by ?? agent.created_by ?? agent.id
  const joined = new Set<string>()
  let heldForBudget = false
  for (let i = 0; i < toOpen.length; i++) {
    const { to, from } = toOpen[i] as { to: string; from: string }
    if (failure) break
    const node = nodeOf(d, to)
    if (!node) {
      failure = `The workflow routes to "${to}", which it does not define.`
      break
    }
    // A join opens once, after every branch into it has finished in this run.
    const sources = [...new Set(d.routes.filter((r) => r.to === to).map((r) => r.from))]
    if (sources.length > 1) {
      // Wait while anything still in flight can reach it: an open step, the step waiting on a
      // person, or a step this pass is about to open.
      const live =
        openNow.some((c) => c.node_id && c.node_id !== to && reaches(d, c.node_id, to)) ||
        (waiting !== undefined && reaches(d, waiting, to)) ||
        toOpen.slice(i + 1).some((o) => o.to !== to && reaches(d, o.to, to))
      if (live) {
        pending.add(to)
        continue
      }
      pending.delete(to)
      if (joined.has(to)) continue
      joined.add(to)
    }
    if (node.kind === "human") {
      waiting = node.id
      continue
    }
    const target = node.context_ref ? await nodeAgent(meta, job.org_id, node.context_ref) : null
    if (!target) {
      failure = `Step "${node.id}" names "${node.context_ref ?? ""}", which is not an agent here.`
      break
    }
    const dedupeKey = `${job.id}:${since}:${node.id}:${from}`
    // Already opened for this same reason (by an earlier pass): it is this step, not another try.
    const already = await meta.findOpenJobByDedupe(target.id, askedBy, dedupeKey)
    if (already) {
      if (!openNow.some((c) => c.id === already.id)) openNow.push(already)
      continue
    }
    const attempt =
      route.filter((r) => r.node_id === node.id).length +
      openNow.filter((c) => c.node_id === node.id).length +
      1
    const cap = attemptCap(d, node.id)
    if (attempt > cap) {
      failure = `Step "${node.id}" reached its limit of ${cap} tries.`
      break
    }
    if (!(await canAskAgent(meta, target, askedBy))) {
      failure = `Step "${node.id}" needs ${target.name}, which the person who started this cannot ask.`
      break
    }
    if (await deps.isGraph?.(target).catch(() => false)) {
      failure = `Step "${node.id}" names ${target.name}, which is itself a workflow; nesting is not supported.`
      break
    }
    // Past the step's payer's monthly budget: the step is not opened yet. It waits with the
    // graph (as a step where branches meet waits), and a later pass opens it.
    if (await overBudgetFor(meta, target, askedBy)) {
      pending.add(to)
      heldForBudget = true
      continue
    }
    pending.delete(to)
    const choices = routesFrom(d, node.id)
    const menu =
      node.routing === "one" && choices.length > 1
        ? `\n\nWhen you finish, end your reply with one line \`ROUTE: <step>\` choosing what happens next:\n${choices.map((r) => `- ${r.to}: ${r.when}`).join("\n")}`
        : ""
    const { job: child } = await askAgent(deps, {
      agent: target,
      askedBy,
      instruction: `${node.instruction ?? node.result ?? g.ask ?? job.instruction}\n\nThis is step "${node.id}" of the workflow "${def.purpose}", started for: ${g.ask ?? job.instruction}${menu}`,
      parentId: job.id,
      nodeId: node.id,
      kind: "node",
      dedupeKey,
    })
    openNow.push(child)
  }

  g = { ...g, waiting, pending: [...pending], pass_until: undefined }
  await write({
    result_json: JSON.stringify({ ...jobResult(job), route }),
    meta_json: JSON.stringify({ ...parse(job.meta_json), graph: g }),
  })
  if (failure) return settle("failed", failure)
  if (heldForBudget) await noteHeldForBudget(meta, job)
  if (waiting) {
    const node = nodeOf(d, waiting)
    await write(
      {
        status: "needs_you",
        lease_until: null,
        needs_json: needsFor(node),
      },
      "running",
    )
    return
  }
  // Finished only when every step of this run is closed AND recorded: a step that settled while
  // this pass held the graph is picked up by the next pass, not lost to an early settle.
  const recordedNow = new Set(route.map((r) => r.job_id).filter(Boolean))
  const all = (await meta.listJobs({ orgId: job.org_id, parentId: job.id, limit: 200 })).filter(
    (c) => c.created_at >= since,
  )
  if (pending.size === 0 && all.every((c) => !isJobOpen(c.status) && recordedNow.has(c.id)))
    await settle("succeeded", `Done: ${route.map((r) => r.node_id).join(" → ")}.`)
}

/** Deps for the jobs lib that know graphs: `isGraph` reads the agent's instructions page. */
export const graphAware = (deps: GraphDeps): GraphDeps => ({
  ...deps,
  isGraph: async (agent) => (await graphOf(deps, agent)) !== null,
})

/** Every open graph, a step each. Isolated: one bad graph never stalls the rest. */
export async function graphPass(deps: GraphDeps): Promise<number> {
  let n = 0
  for (const job of await deps.meta.listOpenGraphJobs(100)) {
    try {
      await advanceGraph(deps, job)
      n++
    } catch (error) {
      log.warn("graph step deferred", { job: job.id, reason: runtimeFailureReason(error) })
    }
  }
  return n
}
