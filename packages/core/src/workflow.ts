import { MAX_FACT_BYTES, parseFacts } from "./facts"
import { type LinkedBundleManifest, type LinkedBundleNode, linkedBundleOf } from "./linked-bundle"

export const WORKFLOW_DEFINITION_FACT = "workflow-definition"
export const WORKFLOW_DEFINITION_SCHEMA = "derive.workflow/v1"

export type WorkflowNodeKind = "context" | "human" | "terminal"
export type WorkflowEffectKind = "read" | "write" | "message" | "spend" | "access"

export interface WorkflowEffect {
  kind: WorkflowEffectKind
  description: string
  gate: "none" | "human"
  /** Stable id of the human node whose decision authorizes this effect. */
  approval_ref?: string
  idempotency?: string
  compensation?: string
}

export interface WorkflowNodeDefinition {
  id: string
  kind: WorkflowNodeKind
  /** Required on a context node with multiple outgoing routes. */
  routing?: "all" | "one"
  /** A context or human node may also end the diagram after it settles. */
  terminal?: boolean
  context_ref?: string
  instruction?: string
  result?: string
  decision?: string
  options?: string[]
  resume?: string
  effects?: WorkflowEffect[]
}

export interface WorkflowRouteDefinition {
  from: string
  to: string
  when: string
  fallback?: boolean
}

export interface WorkflowLoopDefinition {
  id: string
  nodes: string[]
  goal: string
  evaluate: string
  stop: {
    max_attempts: number
    stagnation_limit?: number
    max_minutes?: number
    max_cost_usd?: number
    human_stop: string
  }
}

export interface WorkflowScenarioDefinition {
  id: string
  kind: "expected" | "failure" | "human"
  path: string[]
  outcome: string
}

export interface WorkflowDiagramDefinition {
  id: string
  entry: string
  nodes: WorkflowNodeDefinition[]
  routes: WorkflowRouteDefinition[]
  loops?: WorkflowLoopDefinition[]
  scenarios: WorkflowScenarioDefinition[]
}

export interface WorkflowDefinition {
  schema: typeof WORKFLOW_DEFINITION_SCHEMA
  purpose: string
  diagrams: WorkflowDiagramDefinition[]
  forbidden?: string[]
}

export interface WorkflowValidation {
  definition: WorkflowDefinition | null
  errors: string[]
  warnings: string[]
}

export interface WorkflowPreviewDiagram {
  id: string
  title: string
  will_do: string[]
  may_do: string[]
  will_pause: string[]
  can_repeat: string[]
  side_effects: string[]
  /** Minimal workflow text used when an older visible node has no authored note. */
  node_details: Array<{
    node_id: string
    instruction: string | null
    result: string | null
  }>
  context_sessions: Array<{
    node_id: string
    label: string
    context_ref: string
    result: string
    starts_when: string
  }>
  scenarios: Array<{ kind: WorkflowScenarioDefinition["kind"]; outcome: string }>
}

export interface WorkflowPreview {
  status: "ready" | "needs-changes"
  execution_started: false
  purpose: string | null
  errors: string[]
  warnings: string[]
  diagrams: WorkflowPreviewDiagram[]
  cannot_do: string[]
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null
const localId = (value: unknown): string | null => {
  const id = text(value)
  return id && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) ? id : null
}
const positive = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
const nonemptyTexts = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null
  const values = value.map(text)
  return values.every((item): item is string => item !== null) ? values : null
}

const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`

const cyclicComponents = (nodes: string[], routes: WorkflowRouteDefinition[]): string[][] => {
  const outgoing = new Map(nodes.map((node) => [node, [] as string[]]))
  for (const route of routes) outgoing.get(route.from)?.push(route.to)
  let nextIndex = 0
  const indices = new Map<string, number>()
  const lows = new Map<string, number>()
  const stack: string[] = []
  const stacked = new Set<string>()
  const components: string[][] = []
  const visit = (id: string) => {
    indices.set(id, nextIndex)
    lows.set(id, nextIndex++)
    stack.push(id)
    stacked.add(id)
    for (const next of outgoing.get(id) ?? []) {
      if (!indices.has(next)) {
        visit(next)
        lows.set(id, Math.min(lows.get(id) as number, lows.get(next) as number))
      } else if (stacked.has(next)) {
        lows.set(id, Math.min(lows.get(id) as number, indices.get(next) as number))
      }
    }
    if (lows.get(id) !== indices.get(id)) return
    const component: string[] = []
    let member: string
    do {
      member = stack.pop() as string
      stacked.delete(member)
      component.push(member)
    } while (member !== id)
    if (
      component.length > 1 ||
      routes.some((route) => route.from === component[0] && route.to === component[0])
    )
      components.push(component)
  }
  for (const node of nodes) if (!indices.has(node)) visit(node)
  return components
}

const nodeLabel = (node: LinkedBundleNode | undefined, fallback: string): string =>
  node?.label ?? fallback

export const validateWorkflowDefinition = (
  value: unknown,
  linked?: LinkedBundleManifest | null,
): WorkflowValidation => {
  const errors: string[] = []
  const warnings: string[] = []
  if (!object(value))
    return { definition: null, errors: ["WF-01 definition must be an object"], warnings }
  if (value.schema !== WORKFLOW_DEFINITION_SCHEMA)
    errors.push(`WF-01 schema must be "${WORKFLOW_DEFINITION_SCHEMA}"`)
  const purpose = text(value.purpose)
  if (!purpose) errors.push("WF-01 purpose is required")
  if (!Array.isArray(value.diagrams) || value.diagrams.length === 0)
    errors.push("WF-02 diagrams must contain at least one workflow")

  const diagramIds = new Set<string>()
  const diagrams: WorkflowDiagramDefinition[] = []
  for (const [diagramIndex, rawDiagram] of (Array.isArray(value.diagrams)
    ? value.diagrams
    : []
  ).entries()) {
    if (!object(rawDiagram)) {
      errors.push(`WF-01 diagrams[${diagramIndex}] must be an object`)
      continue
    }
    const diagramId = localId(rawDiagram.id)
    if (!diagramId) errors.push(`WF-01 diagrams[${diagramIndex}].id must be a stable local id`)
    else if (diagramIds.has(diagramId)) errors.push(`WF-01 duplicate diagram id "${diagramId}"`)
    else diagramIds.add(diagramId)

    if (!Array.isArray(rawDiagram.nodes) || rawDiagram.nodes.length === 0)
      errors.push(`WF-02 diagrams[${diagramIndex}].nodes must not be empty`)
    const nodeIds = new Set<string>()
    const nodes: WorkflowNodeDefinition[] = []
    for (const [nodeIndex, rawNode] of (Array.isArray(rawDiagram.nodes)
      ? rawDiagram.nodes
      : []
    ).entries()) {
      if (!object(rawNode)) {
        errors.push(`WF-01 diagrams[${diagramIndex}].nodes[${nodeIndex}] must be an object`)
        continue
      }
      const id = localId(rawNode.id)
      if (!id)
        errors.push(
          `WF-01 diagrams[${diagramIndex}].nodes[${nodeIndex}].id must be a stable local id`,
        )
      else if (nodeIds.has(id)) errors.push(`WF-01 duplicate node id "${id}" in diagram`)
      else nodeIds.add(id)
      const kind =
        rawNode.kind === "context" || rawNode.kind === "human" || rawNode.kind === "terminal"
          ? rawNode.kind
          : null
      if (!kind)
        errors.push(
          `WF-03 diagrams[${diagramIndex}].nodes[${nodeIndex}].kind must be "context", "human", or "terminal"`,
        )

      const contextRef = text(rawNode.context_ref)
      const instruction = text(rawNode.instruction)
      const result = text(rawNode.result)
      const decision = text(rawNode.decision)
      const options = nonemptyTexts(rawNode.options)
      const resume = text(rawNode.resume)
      const terminal = rawNode.terminal === true
      const routing =
        rawNode.routing === "all" || rawNode.routing === "one" ? rawNode.routing : null
      if (rawNode.routing !== undefined && !routing)
        errors.push(`WF-02 node "${id ?? nodeIndex}" routing must be "all" or "one"`)
      if (kind !== "context" && routing)
        errors.push(`WF-02 node "${id ?? nodeIndex}" routing is only valid on context nodes`)
      if (kind === "context") {
        if (!contextRef) errors.push(`WF-03 context node "${id ?? nodeIndex}" requires context_ref`)
        if (!instruction)
          errors.push(`WF-03 context node "${id ?? nodeIndex}" requires instruction`)
        if (!result) errors.push(`WF-03 context node "${id ?? nodeIndex}" requires result`)
      }
      if (kind === "human") {
        if (!decision) errors.push(`WF-07 human node "${id ?? nodeIndex}" requires decision`)
        if (!options || options.length < 2)
          errors.push(`WF-07 human node "${id ?? nodeIndex}" requires at least two options`)
        if (!resume) errors.push(`WF-07 human node "${id ?? nodeIndex}" requires resume`)
      }
      if (kind === "terminal" && !result)
        errors.push(`WF-02 terminal node "${id ?? nodeIndex}" requires result`)

      const effects: WorkflowEffect[] = []
      if (rawNode.effects !== undefined && !Array.isArray(rawNode.effects))
        errors.push(`WF-05 node "${id ?? nodeIndex}" effects must be an array`)
      for (const [effectIndex, rawEffect] of (Array.isArray(rawNode.effects)
        ? rawNode.effects
        : []
      ).entries()) {
        if (!object(rawEffect)) {
          errors.push(`WF-05 node "${id ?? nodeIndex}" effect[${effectIndex}] must be an object`)
          continue
        }
        const effectKind =
          rawEffect.kind === "read" ||
          rawEffect.kind === "write" ||
          rawEffect.kind === "message" ||
          rawEffect.kind === "spend" ||
          rawEffect.kind === "access"
            ? rawEffect.kind
            : null
        const description = text(rawEffect.description)
        const gate = rawEffect.gate === "none" || rawEffect.gate === "human" ? rawEffect.gate : null
        const approvalRef = localId(rawEffect.approval_ref)
        const idempotency = text(rawEffect.idempotency)
        const compensation = text(rawEffect.compensation)
        if (!effectKind)
          errors.push(`WF-05 node "${id ?? nodeIndex}" effect[${effectIndex}] has invalid kind`)
        if (!description)
          errors.push(`WF-05 node "${id ?? nodeIndex}" effect[${effectIndex}] requires description`)
        if (!gate)
          errors.push(`WF-05 node "${id ?? nodeIndex}" effect[${effectIndex}] requires gate`)
        if (effectKind && effectKind !== "read" && gate === "none" && !idempotency)
          errors.push(
            `WF-05 node "${id ?? nodeIndex}" ${effectKind} effect needs a human gate or idempotency`,
          )
        if (gate === "human" && !approvalRef)
          errors.push(
            `WF-05 node "${id ?? nodeIndex}" ${effectKind ?? "external"} effect with a human gate requires approval_ref`,
          )
        if (gate === "none" && rawEffect.approval_ref !== undefined)
          errors.push(
            `WF-05 node "${id ?? nodeIndex}" effect approval_ref is only valid with a human gate`,
          )
        if (effectKind && description && gate)
          effects.push({
            kind: effectKind,
            description,
            gate,
            ...(approvalRef ? { approval_ref: approvalRef } : {}),
            ...(idempotency ? { idempotency } : {}),
            ...(compensation ? { compensation } : {}),
          })
      }
      if (id && kind)
        nodes.push({
          id,
          kind,
          ...(routing ? { routing } : {}),
          ...(terminal ? { terminal: true } : {}),
          ...(contextRef ? { context_ref: contextRef } : {}),
          ...(instruction ? { instruction } : {}),
          ...(result ? { result } : {}),
          ...(decision ? { decision } : {}),
          ...(options ? { options } : {}),
          ...(resume ? { resume } : {}),
          ...(effects.length ? { effects } : {}),
        })
    }

    const entry = localId(rawDiagram.entry)
    if (!entry || !nodeIds.has(entry))
      errors.push(`WF-02 diagram "${diagramId ?? diagramIndex}" requires an entry node`)
    const humanNodeIds = new Set(
      nodes.filter((node) => node.kind === "human").map((node) => node.id),
    )
    for (const node of nodes)
      for (const effect of node.effects ?? [])
        if (effect.gate === "human" && !humanNodeIds.has(effect.approval_ref ?? ""))
          errors.push(
            `WF-05 node "${node.id}" effect approval_ref must name a human node in the diagram`,
          )

    if (!Array.isArray(rawDiagram.routes))
      errors.push(`WF-02 diagrams[${diagramIndex}].routes must be an array`)
    const routeKeys = new Set<string>()
    const routes: WorkflowRouteDefinition[] = []
    for (const [routeIndex, rawRoute] of (Array.isArray(rawDiagram.routes)
      ? rawDiagram.routes
      : []
    ).entries()) {
      if (!object(rawRoute)) {
        errors.push(`WF-02 diagrams[${diagramIndex}].routes[${routeIndex}] must be an object`)
        continue
      }
      const from = localId(rawRoute.from)
      const to = localId(rawRoute.to)
      const when = text(rawRoute.when)
      if (!from || !to)
        errors.push(`WF-02 diagrams[${diagramIndex}].routes[${routeIndex}] needs from and to`)
      else if (!nodeIds.has(from) || !nodeIds.has(to))
        errors.push(`WF-02 route "${from}" → "${to}" references an unknown node`)
      else if (routeKeys.has(edgeKey(from, to)))
        errors.push(`WF-01 duplicate route "${from}" → "${to}"`)
      else routeKeys.add(edgeKey(from, to))
      if (!when) errors.push(`WF-02 route "${from ?? "?"}" → "${to ?? "?"}" requires when`)
      if (from && to && when)
        routes.push({
          from,
          to,
          when,
          ...(rawRoute.fallback === true ? { fallback: true } : {}),
        })
    }
    const outgoing = new Set(routes.map((route) => route.from))
    for (const node of nodes)
      if (node.kind !== "terminal" && !node.terminal && !outgoing.has(node.id))
        errors.push(`WF-02 non-terminal node "${node.id}" has no outgoing route`)
      else if ((node.kind === "terminal" || node.terminal) && outgoing.has(node.id))
        errors.push(`WF-02 terminal node "${node.id}" must not have an outgoing route`)
    if (!nodes.some((node) => node.kind === "terminal" || node.terminal))
      errors.push(`WF-02 diagram "${diagramId ?? diagramIndex}" requires a terminal node`)
    const routesBySource = new Map<string, WorkflowRouteDefinition[]>()
    for (const route of routes) {
      const group = routesBySource.get(route.from) ?? []
      group.push(route)
      routesBySource.set(route.from, group)
    }
    for (const [from, choices] of routesBySource) {
      const node = nodes.find((candidate) => candidate.id === from)
      if (node?.kind === "human") {
        const options = new Set(node.options ?? [])
        const conditions = new Set(choices.map((route) => route.when))
        const missing = [...options].filter((option) => !conditions.has(option))
        const unexpected = [...conditions].filter((condition) => !options.has(condition))
        const hasFallback = choices.some((route) => route.fallback)
        if (hasFallback || options.size !== conditions.size || missing.length > 0)
          errors.push(
            `WF-02 human node "${from}" routes must match its options exactly` +
              (missing.length ? `; missing ${missing.map((item) => `"${item}"`).join(", ")}` : "") +
              (unexpected.length
                ? `; unexpected ${unexpected.map((item) => `"${item}"`).join(", ")}`
                : "") +
              (hasFallback ? "; fallback is not allowed" : ""),
          )
      } else if (choices.length > 1 && node?.routing === "all") {
        if (
          choices.some((route) => route.when.toLowerCase() !== "always" || route.fallback === true)
        )
          errors.push(`WF-02 routing:"all" node "${from}" requires only always routes`)
      } else if (choices.length > 1 && node?.routing === "one") {
        if (
          choices.some((route) => route.when.toLowerCase() === "always") ||
          choices.filter((route) => route.fallback).length !== 1
        )
          errors.push(
            `WF-02 routing:"one" node "${from}" requires conditions and exactly one fallback`,
          )
      } else if (choices.length > 1) {
        errors.push(`WF-02 context node "${from}" with multiple routes requires routing`)
      }
    }
    if (entry) {
      const reachable = new Set([entry])
      const queue = [entry]
      while (queue.length) {
        const from = queue.shift() as string
        for (const route of routesBySource.get(from) ?? [])
          if (!reachable.has(route.to)) {
            reachable.add(route.to)
            queue.push(route.to)
          }
      }
      for (const node of nodes)
        if (!reachable.has(node.id))
          errors.push(`WF-02 node "${node.id}" is unreachable from entry "${entry}"`)
    }

    const loops: WorkflowLoopDefinition[] = []
    const loopIds = new Set<string>()
    if (rawDiagram.loops !== undefined && !Array.isArray(rawDiagram.loops))
      errors.push(`WF-04 diagrams[${diagramIndex}].loops must be an array`)
    for (const [loopIndex, rawLoop] of (Array.isArray(rawDiagram.loops)
      ? rawDiagram.loops
      : []
    ).entries()) {
      if (!object(rawLoop)) {
        errors.push(`WF-04 diagrams[${diagramIndex}].loops[${loopIndex}] must be an object`)
        continue
      }
      const id = localId(rawLoop.id)
      const loopNodes = nonemptyTexts(rawLoop.nodes)
      const goal = text(rawLoop.goal)
      const evaluate = text(rawLoop.evaluate)
      const stop = object(rawLoop.stop) ? rawLoop.stop : null
      const maxAttempts = positive(stop?.max_attempts)
      const stagnationLimit = positive(stop?.stagnation_limit)
      const maxMinutes = positive(stop?.max_minutes)
      const maxCost = positive(stop?.max_cost_usd)
      const humanStop = text(stop?.human_stop)
      if (!id) errors.push(`WF-04 diagrams[${diagramIndex}].loops[${loopIndex}] needs a stable id`)
      else if (loopIds.has(id)) errors.push(`WF-01 duplicate loop id "${id}"`)
      else loopIds.add(id)
      if (!loopNodes?.length) errors.push(`WF-04 loop "${id ?? loopIndex}" requires nodes`)
      else
        for (const node of loopNodes)
          if (!nodeIds.has(node))
            errors.push(`WF-04 loop "${id ?? loopIndex}" references unknown node "${node}"`)
      if (!goal) errors.push(`WF-04 loop "${id ?? loopIndex}" requires goal`)
      if (!evaluate) errors.push(`WF-04 loop "${id ?? loopIndex}" requires evaluate`)
      if (!stop) errors.push(`WF-04 loop "${id ?? loopIndex}" requires stop policy`)
      if (!maxAttempts || !Number.isInteger(maxAttempts) || maxAttempts > 100)
        errors.push(`WF-04 loop "${id ?? loopIndex}" max_attempts must be an integer from 1 to 100`)
      if (stagnationLimit && maxAttempts && stagnationLimit > maxAttempts)
        errors.push(`WF-04 loop "${id ?? loopIndex}" stagnation_limit exceeds max_attempts`)
      if (!humanStop) errors.push(`WF-04 loop "${id ?? loopIndex}" requires human_stop`)
      if (id && loopNodes?.length && goal && evaluate && maxAttempts && humanStop)
        loops.push({
          id,
          nodes: loopNodes,
          goal,
          evaluate,
          stop: {
            max_attempts: maxAttempts,
            ...(stagnationLimit ? { stagnation_limit: stagnationLimit } : {}),
            ...(maxMinutes ? { max_minutes: maxMinutes } : {}),
            ...(maxCost ? { max_cost_usd: maxCost } : {}),
            human_stop: humanStop,
          },
        })
    }
    for (const component of cyclicComponents([...nodeIds], routes))
      if (!loops.some((loop) => component.every((node) => loop.nodes.includes(node))))
        errors.push(
          `WF-04 cycle containing "${component.sort().join('", "')}" has no covering bounded loop policy`,
        )

    if (!Array.isArray(rawDiagram.scenarios) || rawDiagram.scenarios.length === 0)
      errors.push(`WF-10 diagrams[${diagramIndex}].scenarios must not be empty`)
    const scenarios: WorkflowScenarioDefinition[] = []
    const scenarioIds = new Set<string>()
    const scenarioKinds = new Set<WorkflowScenarioDefinition["kind"]>()
    for (const [scenarioIndex, rawScenario] of (Array.isArray(rawDiagram.scenarios)
      ? rawDiagram.scenarios
      : []
    ).entries()) {
      if (!object(rawScenario)) {
        errors.push(`WF-10 diagrams[${diagramIndex}].scenarios[${scenarioIndex}] must be an object`)
        continue
      }
      const id = localId(rawScenario.id)
      const kind =
        rawScenario.kind === "expected" ||
        rawScenario.kind === "failure" ||
        rawScenario.kind === "human"
          ? rawScenario.kind
          : null
      const path = nonemptyTexts(rawScenario.path)
      const outcome = text(rawScenario.outcome)
      if (!id) errors.push(`WF-10 scenario[${scenarioIndex}] needs a stable id`)
      else if (scenarioIds.has(id)) errors.push(`WF-01 duplicate scenario id "${id}"`)
      else scenarioIds.add(id)
      if (!kind) errors.push(`WF-10 scenario "${id ?? scenarioIndex}" has invalid kind`)
      else scenarioKinds.add(kind)
      if (!path?.length) errors.push(`WF-10 scenario "${id ?? scenarioIndex}" requires a path`)
      else {
        if (entry && path[0] !== entry)
          errors.push(`WF-10 scenario "${id ?? scenarioIndex}" must start at entry "${entry}"`)
        for (const node of path)
          if (!nodeIds.has(node))
            errors.push(`WF-10 scenario "${id ?? scenarioIndex}" references unknown node "${node}"`)
        for (let i = 1; i < path.length; i++) {
          const from = path[i - 1]
          const to = path[i]
          if (from && to && !routeKeys.has(edgeKey(from, to)))
            errors.push(
              `WF-10 scenario "${id ?? scenarioIndex}" takes nonexistent route "${from}" → "${to}"`,
            )
        }
        const last = path.at(-1)
        if (
          kind !== "failure" &&
          last &&
          !nodes.some(
            (node) => node.id === last && (node.kind === "terminal" || node.terminal === true),
          )
        )
          errors.push(`WF-10 scenario "${id ?? scenarioIndex}" must end at a terminal node`)
      }
      if (!outcome) errors.push(`WF-10 scenario "${id ?? scenarioIndex}" requires outcome`)
      if (id && kind && path?.length && outcome) scenarios.push({ id, kind, path, outcome })
    }
    if (!scenarioKinds.has("expected"))
      errors.push(`WF-10 diagram "${diagramId ?? diagramIndex}" needs an expected scenario`)
    if (nodes.some((node) => node.kind === "context") && !scenarioKinds.has("failure"))
      errors.push(`WF-10 diagram "${diagramId ?? diagramIndex}" needs a failure scenario`)
    if (nodes.some((node) => node.kind === "human") && !scenarioKinds.has("human"))
      errors.push(`WF-10 diagram "${diagramId ?? diagramIndex}" needs a human scenario`)
    for (const node of nodes.filter((node) => node.kind === "human"))
      if (
        !scenarios.some((scenario) => scenario.kind === "human" && scenario.path.includes(node.id))
      )
        errors.push(`WF-10 human node "${node.id}" is not covered by a human scenario`)

    if (diagramId)
      diagrams.push({
        id: diagramId,
        entry: entry ?? "",
        nodes,
        routes,
        ...(loops.length ? { loops } : {}),
        scenarios,
      })
  }

  const forbidden = nonemptyTexts(value.forbidden)
  if (value.forbidden !== undefined && !forbidden)
    errors.push("WF-05 forbidden must be an array of non-empty strings")

  if (linked) {
    if (purpose && linked.purpose !== purpose)
      errors.push("WF-02 workflow purpose must match bundle-manifest purpose")
    const linkedDiagrams = new Map((linked.diagrams ?? []).map((diagram) => [diagram.id, diagram]))
    for (const diagram of diagrams) {
      const visible = linkedDiagrams.get(diagram.id)
      if (!visible) {
        errors.push(`WF-02 workflow diagram "${diagram.id}" is missing from bundle-manifest`)
        continue
      }
      const visibleNodes = new Set(visible.nodes.map((node) => node.id))
      const definedNodes = new Set(diagram.nodes.map((node) => node.id))
      for (const id of visibleNodes)
        if (!definedNodes.has(id))
          errors.push(`WF-02 visible node "${diagram.id}/${id}" has no workflow definition`)
      for (const id of definedNodes)
        if (!visibleNodes.has(id))
          errors.push(`WF-02 workflow node "${diagram.id}/${id}" is not visible in bundle-manifest`)
      const labels = new Map(visible.nodes.map((node) => [node.id, node.label]))
      const visibleEdges = new Set(visible.edges.map((edge) => edgeKey(edge.from, edge.to)))
      const definedRoutes = new Set(diagram.routes.map((route) => edgeKey(route.from, route.to)))
      for (const edge of visible.edges)
        if (!definedRoutes.has(edgeKey(edge.from, edge.to)))
          errors.push(
            `WF-02 visible edge "${labels.get(edge.from) ?? edge.from}" → "${labels.get(edge.to) ?? edge.to}" in "${diagram.id}" has no workflow route`,
          )
      for (const route of diagram.routes)
        if (!visibleEdges.has(edgeKey(route.from, route.to)))
          errors.push(
            `WF-02 workflow route "${labels.get(route.from) ?? route.from}" → "${labels.get(route.to) ?? route.to}" in "${diagram.id}" is not visible`,
          )
      if (visible.type === "loop" && !diagram.loops?.length)
        errors.push(`WF-04 visible loop "${diagram.id}" has no bounded loop policy`)
    }
    for (const diagram of linked.diagrams ?? [])
      if (!diagramIds.has(diagram.id))
        errors.push(`WF-02 visible diagram "${diagram.id}" has no workflow definition`)
  } else if (diagrams.length) {
    errors.push("WF-02 workflow-definition requires a valid bundle-manifest in the same artifact")
  }

  return errors.length
    ? { definition: null, errors, warnings }
    : {
        definition: {
          schema: WORKFLOW_DEFINITION_SCHEMA,
          purpose: purpose as string,
          diagrams,
          ...(forbidden?.length ? { forbidden } : {}),
        },
        errors,
        warnings,
      }
}

export const workflowDefinitionOf = (source: string): WorkflowValidation | null => {
  const parsed = parseFacts(source, "text/html")
  const row = parsed.facts.find((fact) => fact.slot === WORKFLOW_DEFINITION_FACT)
  if (!row) {
    const advisory = parsed.advisories.find((item) =>
      item.includes(`Facts "${WORKFLOW_DEFINITION_FACT}"`),
    )
    if (!advisory) return null
    return {
      definition: null,
      errors: [
        advisory.includes(`over the ${MAX_FACT_BYTES / 1024}KB limit`)
          ? `WF-01 workflow-definition exceeds ${MAX_FACT_BYTES / 1024}KB fact limit`
          : "WF-01 workflow-definition is not valid JSON",
      ],
      warnings: [],
    }
  }
  const linked = linkedBundleOf(source)
  try {
    return validateWorkflowDefinition(JSON.parse(row.json), linked?.manifest ?? null)
  } catch {
    return {
      definition: null,
      errors: ["WF-01 workflow-definition is not valid JSON"],
      warnings: [],
    }
  }
}

export const workflowDefinitionAdvisories = (source: string): string[] => {
  const result = workflowDefinitionOf(source)
  if (!result) return []
  return [
    ...result.errors.map((error) => `Workflow preview: ${error}.`),
    ...result.warnings.map((warning) => `Workflow preview: ${warning}.`),
  ]
}

const previewWorkflowValidation = (
  validation: WorkflowValidation,
  linked: LinkedBundleManifest | null,
): WorkflowPreview => {
  if (!validation.definition)
    return {
      status: "needs-changes",
      execution_started: false,
      purpose: null,
      errors: validation.errors,
      warnings: validation.warnings,
      diagrams: [],
      cannot_do: [],
    }
  const visibleByDiagram = new Map((linked?.diagrams ?? []).map((diagram) => [diagram.id, diagram]))
  const detailWarnings = validation.definition.diagrams.flatMap((diagram) => {
    const visible = visibleByDiagram.get(diagram.id)
    const visibleNodes = new Map((visible?.nodes ?? []).map((node) => [node.id, node]))
    const empty = diagram.nodes.filter(
      (node) => !visibleNodes.get(node.id)?.note && !node.instruction && !node.result,
    )
    if (!empty.length) return []
    const labels = empty
      .slice(0, 3)
      .map((node) => nodeLabel(visibleNodes.get(node.id), node.id))
      .join(", ")
    return [
      `Preview advisory: ${empty.length} node${empty.length === 1 ? " has" : "s have"} no note or workflow description (${labels}${empty.length > 3 ? ", …" : ""}). Add a short node.note so ${empty.length === 1 ? "it is" : "they are"} easy to understand.`,
    ]
  })
  return {
    status: "ready",
    execution_started: false,
    purpose: validation.definition.purpose,
    errors: [],
    warnings: [...validation.warnings, ...detailWarnings],
    diagrams: validation.definition.diagrams.map((diagram) => {
      const visible = visibleByDiagram.get(diagram.id)
      const nodes = new Map((visible?.nodes ?? []).map((node) => [node.id, node]))
      return {
        id: diagram.id,
        title: visible?.title ?? diagram.id,
        will_do: diagram.nodes
          .filter((node) => node.kind === "context")
          .map(
            (node) =>
              `${nodeLabel(nodes.get(node.id), node.id)} — ${node.result ?? "produce its declared result"}`,
          ),
        may_do: diagram.routes
          .filter((route) => route.when.toLowerCase() !== "always")
          .map(
            (route) =>
              `${nodeLabel(nodes.get(route.from), route.from)} → ${nodeLabel(nodes.get(route.to), route.to)} when ${route.when}`,
          ),
        will_pause: diagram.nodes
          .filter((node) => node.kind === "human")
          .map(
            (node) =>
              `${nodeLabel(nodes.get(node.id), node.id)} — ${node.decision ?? "human decision"}; resume: ${node.resume ?? "declared response"}`,
          ),
        can_repeat: (diagram.loops ?? []).map(
          (loop) =>
            `${loop.goal} — at most ${loop.stop.max_attempts} attempts; human stop: ${loop.stop.human_stop}`,
        ),
        side_effects: diagram.nodes.flatMap((node) =>
          (node.effects ?? [])
            .filter((effect) => effect.kind !== "read")
            .map(
              (effect) =>
                `${effect.description} — ${effect.gate === "human" ? `authorized at ${nodeLabel(nodes.get(effect.approval_ref ?? ""), effect.approval_ref ?? "human gate")}` : `replay-safe: ${effect.idempotency ?? "declared"}`}`,
            ),
        ),
        node_details: diagram.nodes.map((node) => ({
          node_id: node.id,
          instruction: node.instruction ?? null,
          result: node.result ?? null,
        })),
        context_sessions: diagram.nodes
          .filter(
            (node): node is WorkflowNodeDefinition & { context_ref: string } =>
              node.kind === "context" && !!node.context_ref,
          )
          .map((node) => {
            const incoming = diagram.routes.filter((route) => route.to === node.id)
            return {
              node_id: node.id,
              label: nodeLabel(nodes.get(node.id), node.id),
              context_ref: node.context_ref,
              result: node.result ?? "Declared result",
              starts_when:
                node.id === diagram.entry
                  ? "explicit run"
                  : incoming
                      .map(
                        (route) =>
                          `${nodeLabel(nodes.get(route.from), route.from)}${
                            route.when.toLowerCase() === "always"
                              ? " completes"
                              : ` returns ${route.when}`
                          }`,
                      )
                      .join("; "),
            }
          }),
        scenarios: diagram.scenarios.map((scenario) => ({
          kind: scenario.kind,
          outcome: scenario.outcome,
        })),
      }
    }),
    cannot_do: validation.definition.forbidden ?? [],
  }
}

/** Build the same one-gate Preview from already-extracted facts. The artifact
 * detail API uses this path so the shared page can render exactly what the CLI
 * explains without re-reading or executing the document bytes. */
export const previewWorkflowDefinition = (
  value: unknown,
  linked: LinkedBundleManifest | null,
): WorkflowPreview => previewWorkflowValidation(validateWorkflowDefinition(value, linked), linked)

/** Parse an already-extracted workflow fact and produce the canonical Preview.
 * API surfaces share this helper so malformed JSON cannot be classified or
 * worded differently from one route to another. */
export const previewWorkflowJson = (
  json: string,
  linked: LinkedBundleManifest | null,
): WorkflowPreview => {
  try {
    return previewWorkflowDefinition(JSON.parse(json), linked)
  } catch {
    return {
      status: "needs-changes",
      execution_started: false,
      purpose: null,
      errors: ["WF-01 workflow-definition is not valid JSON"],
      warnings: [],
      diagrams: [],
      cannot_do: [],
    }
  }
}

export const previewWorkflow = (source: string): WorkflowPreview => {
  const validation = workflowDefinitionOf(source)
  const linked = linkedBundleOf(source)?.manifest ?? null
  if (!validation)
    return {
      status: "needs-changes",
      execution_started: false,
      purpose: null,
      errors: ["WF-01 no workflow-definition fact found"],
      warnings: [],
      diagrams: [],
      cannot_do: [],
    }
  return previewWorkflowValidation(validation, linked)
}

/** A self-contained handoff for any approved local harness. Derive stores the
 * workflow and its receipts; the addressed agent performs the work through the
 * existing context-session contract. */
export const workflowRunInstruction = (shortId: string, diagramId: string): string =>
  `Read Derive artifact ${shortId} and run workflow diagram "${diagramId}". This is explicit run intent. ` +
  "Use its workflow-definition as the policy and Preview it again before opening any context " +
  "session; stop and report the blockers if it Needs changes. Use the existing Derive context " +
  "sessions for ready context nodes, preserve the authored loop bounds and human gates, and " +
  "project only explicit session truth back into the visible graph. Derive stores the graph, " +
  "artifacts, review, and receipts; this agent is the harness that performs the work."
