import {
  type AgentRecord,
  type BlobStore,
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
import { askAgent, type JobDeps } from "./jobs"
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
  /** The human node the graph is waiting on, if any. */
  waiting?: string
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

const pageSource = async (deps: GraphDeps, artifactId: string, version?: number) => {
  const art = await deps.meta.getArtifactById(artifactId).catch(() => null)
  if (!art) return null
  const v = await deps.meta.getVersion(art.id, version ?? art.current_version)
  if (!v) return null
  const bytes = await deps.blobs.get(v.blob_key)
  return bytes ? { text: new TextDecoder().decode(bytes), version: v.n } : null
}

/** The workflow definition on an agent's instructions page, or null when it is not a graph. */
export async function graphOf(
  deps: GraphDeps,
  agent: AgentRecord,
  version?: number,
): Promise<{ diagram: WorkflowDiagramDefinition; version: number; purpose: string } | null> {
  if (!agent.instructions_artifact_id) return null
  const page = await pageSource(deps, agent.instructions_artifact_id, version)
  if (!page) return null
  const checked = workflowDefinitionOf(page.text)
  const diagram = checked?.definition?.diagrams[0]
  if (!checked?.definition || checked.errors.length || !diagram) return null
  return { diagram, version: page.version, purpose: checked.definition.purpose }
}

/** The agent a node's `context_ref` names: an agent id or name, or a Context's id or name (whose
 *  agent row the cutover made the agent), in the graph's own workspace. */
async function nodeAgent(meta: MetaStore, orgId: string, ref: string): Promise<AgentRecord | null> {
  const agents = await meta.listAgents(orgId)
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

/** Advance one graph job as far as it can go now. */
export async function advanceGraph(deps: GraphDeps, parent: JobRecord): Promise<void> {
  const { meta } = deps
  const agent = await meta.getAgent(parent.agent_id)
  if (!agent) return
  const now = new Date()
  const lease = new Date(now.getTime() + GRAPH_LEASE_MS).toISOString()
  let g = parse<{ graph?: GraphMeta }>(parent.meta_json)?.graph
  let job = parent
  let fresh = false
  // Reopened after it settled (a follow-up or a retry) and not waiting on a person: run again
  // from the entry, on the definition as it is now.
  if (g && !g.waiting && job.status === "queued") g = undefined

  const settle = async (status: "succeeded" | "failed", body: string) => {
    const done = await meta.updateJob(
      job.id,
      { status, finished_at: now.toISOString(), lease_until: null, dedupe_key: null },
      { status: job.status },
    )
    if (done)
      await meta.addJobMessage({
        id: newId("jm"),
        job_id: job.id,
        author_kind: "agent",
        author_id: agent.id,
        body_md: body,
      })
  }

  // Start: claim the graph, pin its definition, open the entry node.
  if (!g) {
    if (job.status !== "queued") return
    const def = await graphOf(deps, agent)
    const claimed = await meta.claimJob(job.id, lease, now.toISOString())
    if (!claimed) return
    job = claimed
    if (!def)
      return settle("failed", "This agent's instructions page no longer holds a valid workflow.")
    g = {
      artifact_id: agent.instructions_artifact_id as string,
      version: def.version,
      diagram_id: def.diagram.id,
      since: now.toISOString(),
    }
    fresh = true
    job =
      (await meta.updateJob(job.id, {
        meta_json: JSON.stringify({ ...parse(job.meta_json), graph: g }),
        result_json: JSON.stringify({ ...jobResult(job), route: [] }),
      })) ?? job
  }
  const def = await graphOf(deps, agent, g.version)
  if (!def || def.diagram.id !== g.diagram_id)
    return settle("failed", "The workflow this run started on can no longer be read.")
  const d = def.diagram
  const route: Route[] = [...((jobResult(job).route ?? []) as Route[])]
  const since = g.since
  const children = (
    await meta.listJobs({ orgId: job.org_id, parentId: job.id, limit: 200 })
  ).filter((c) => c.created_at >= since)
  const recorded = new Set(route.map((r) => r.job_id).filter(Boolean))
  const toOpen: string[] = []
  let waiting = g.waiting
  let failure: string | null = null

  // A person answered the human node: their decision picks the way on.
  if (waiting && job.status === "queued") {
    const node = nodeOf(d, waiting)
    const decision =
      (await lastReply(meta, job.id, "asker")).replace(/^Decision:\s*/i, "").split("\n")[0] ?? ""
    const next = node ? decide(d, node, decision) : []
    route.push({ node_id: waiting, attempt: 1, selected: next, decision })
    toOpen.push(...next)
    waiting = undefined
    const reclaimed = await meta.claimJob(job.id, lease, now.toISOString())
    if (!reclaimed) return
    job = reclaimed
  } else if (job.status === "running") {
    await meta.updateJob(job.id, { lease_until: lease }, { status: "running" })
  } else return

  if (fresh) toOpen.push(d.entry)

  // Children that settled since the last pass move the walk on.
  for (const child of children) {
    if (
      recorded.has(child.id) ||
      child.status === "queued" ||
      child.status === "running" ||
      child.status === "needs_you"
    )
      continue
    const node = child.node_id ? nodeOf(d, child.node_id) : undefined
    if (!node) continue
    const attempt = route.filter((r) => r.node_id === node.id).length + 1
    if (child.status === "succeeded") {
      const next = chooseRoutes(d, node, await lastReply(meta, child.id, "agent"))
      route.push({ node_id: node.id, attempt, selected: next, job_id: child.id })
      toOpen.push(...next)
    } else {
      const fallback = routesFrom(d, node.id).find((r) => r.fallback)
      route.push({
        node_id: node.id,
        attempt,
        selected: fallback ? [fallback.to] : [],
        job_id: child.id,
      })
      if (fallback) toOpen.push(fallback.to)
      else
        failure = `Step "${node.id}" ${child.status === "cancelled" ? "was cancelled" : "failed"}.`
    }
  }

  // Open the next nodes.
  for (const id of toOpen) {
    if (failure) break
    const node = nodeOf(d, id)
    if (!node) {
      failure = `The workflow routes to "${id}", which it does not define.`
      break
    }
    if (node.kind === "terminal") {
      route.push({ node_id: node.id, attempt: 1, selected: [] })
      continue
    }
    if (node.kind === "human") {
      waiting = node.id
      continue
    }
    const attempt =
      route.filter((r) => r.node_id === node.id).length +
      children.filter(
        (c) => c.node_id === node.id && (c.status === "queued" || c.status === "running"),
      ).length +
      1
    if (attempt > attemptCap(d, node.id)) {
      failure = `Step "${node.id}" reached its limit of ${attemptCap(d, node.id)} tries.`
      break
    }
    const target = node.context_ref ? await nodeAgent(meta, job.org_id, node.context_ref) : null
    if (!target) {
      failure = `Step "${node.id}" names "${node.context_ref ?? ""}", which is not an agent here.`
      break
    }
    const choices = routesFrom(d, node.id)
    const menu =
      node.routing === "one" && choices.length > 1
        ? `\n\nWhen you finish, end your reply with one line \`ROUTE: <step>\` choosing what happens next:\n${choices.map((r) => `- ${r.to}: ${r.when}`).join("\n")}`
        : ""
    await askAgent(deps, {
      agent: target,
      askedBy: job.asked_by ?? agent.created_by ?? agent.id,
      instruction: `${node.instruction ?? node.result ?? job.instruction}\n\nThis is step "${node.id}" of the workflow "${def.purpose}", started for: ${job.instruction}${menu}`,
      parentId: job.id,
      nodeId: node.id,
      kind: "node",
      dedupeKey: `${job.id}:${since}:${node.id}:${attempt}`,
    })
  }

  const saved = await meta.updateJob(job.id, {
    result_json: JSON.stringify({ ...jobResult(job), route }),
    meta_json: JSON.stringify({ ...parse(job.meta_json), graph: { ...g, waiting } }),
  })
  if (saved) job = saved
  if (failure) {
    for (const c of children)
      if (c.status === "queued" || c.status === "running")
        await meta.updateJob(c.id, {
          status: "cancelled",
          finished_at: now.toISOString(),
          lease_until: null,
        })
    return settle("failed", failure)
  }
  if (waiting) {
    const node = nodeOf(d, waiting)
    await meta.updateJob(
      job.id,
      {
        status: "needs_you",
        lease_until: null,
        needs_json: JSON.stringify({
          kind: "decision",
          question: node?.decision ?? "What should happen next?",
          ...(node?.options?.length ? { options: node.options } : {}),
        }),
      },
      { status: "running" },
    )
    return
  }
  const stillOpen = (await meta.listJobs({ orgId: job.org_id, parentId: job.id, limit: 200 })).some(
    (c) =>
      c.created_at >= since &&
      (c.status === "queued" || c.status === "running" || c.status === "needs_you"),
  )
  if (!stillOpen) await settle("succeeded", `Done: ${route.map((r) => r.node_id).join(" → ")}.`)
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
