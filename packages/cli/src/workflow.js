// Standalone workflow preview compiler for the published CLI. The CLI deliberately has
// no @derive/core runtime dependency, so this validates the same public
// derive.workflow/v1 contract from the two facts embedded in one HTML artifact.

export const WORKFLOW_DEFINITION_SCHEMA = "derive.workflow/v1"

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null)
const localId = (value) => {
  const id = text(value)
  return id && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) ? id : null
}
const positive = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
const texts = (value) => {
  if (!Array.isArray(value)) return null
  const out = value.map(text)
  return out.every(Boolean) ? out : null
}
const edgeKey = (from, to) => `${from}\u0000${to}`

/** Read one JSON fact without executing the page. */
export function factJson(source, slot) {
  const escaped = slot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(
    `<script\\b(?=[^>]*\\btype=["']application/derive-facts["'])(?=[^>]*\\bdata-fact=["']${escaped}["'])[^>]*>([\\s\\S]*?)<\\/script\\s*>`,
    "i",
  )
  const body = source.match(pattern)?.[1]
  if (!body) return { value: null, error: null }
  try {
    return { value: JSON.parse(body), error: null }
  } catch {
    return { value: null, error: `${slot} is not valid JSON` }
  }
}

const titleFromId = (id) =>
  id.replaceAll(/[-_]+/g, " ").replace(/^./, (letter) => letter.toUpperCase())

/** Make the visible graph's topology a projection of the runnable definition.
 * Existing labels, node state, and review metadata survive by stable id; only
 * nodes and edges are reconciled. This removes the most error-prone two-fact edit
 * while keeping the visible bundle rich enough to carry live human state. */
export function syncWorkflowSource(source) {
  const definitionFact = factJson(source, "workflow-definition")
  if (definitionFact.error) throw new Error(definitionFact.error)
  if (!object(definitionFact.value) || !Array.isArray(definitionFact.value.diagrams))
    throw new Error("workflow-definition is missing or invalid")
  const bundleFact = factJson(source, "bundle-manifest")
  if (bundleFact.error) throw new Error(bundleFact.error)
  const existing = object(bundleFact.value) ? bundleFact.value : {}
  const oldDiagrams = new Map(
    (Array.isArray(existing.diagrams) ? existing.diagrams : [])
      .filter(object)
      .map((diagram) => [diagram.id, diagram]),
  )
  const diagrams = definitionFact.value.diagrams.filter(object).map((definition) => {
    const old = oldDiagrams.get(definition.id)
    const oldNodes = new Map(
      (Array.isArray(old?.nodes) ? old.nodes : []).filter(object).map((node) => [node.id, node]),
    )
    const oldEdges = new Map(
      (Array.isArray(old?.edges) ? old.edges : [])
        .filter(object)
        .map((edge) => [edgeKey(edge.from, edge.to), edge]),
    )
    return {
      ...(old ?? {}),
      id: definition.id,
      title: text(old?.title) ?? titleFromId(definition.id),
      type:
        old?.type === "loop" || old?.type === "graph"
          ? old.type
          : Array.isArray(definition.loops) && definition.loops.length
            ? "loop"
            : "graph",
      nodes: (Array.isArray(definition.nodes) ? definition.nodes : [])
        .filter(object)
        .map((node) => ({
          ...(oldNodes.get(node.id) ?? {}),
          id: node.id,
          label: text(oldNodes.get(node.id)?.label) ?? titleFromId(node.id),
          state: oldNodes.get(node.id)?.state ?? "pending",
        })),
      edges: (Array.isArray(definition.routes) ? definition.routes : [])
        .filter(object)
        .map((route) => ({
          ...(oldEdges.get(edgeKey(route.from, route.to)) ?? {}),
          from: route.from,
          to: route.to,
          label:
            text(oldEdges.get(edgeKey(route.from, route.to))?.label) ??
            (route.when === "always" ? "next" : route.when),
        })),
    }
  })
  const bundle = {
    ...existing,
    schema: "derive.linked-bundle/v1",
    purpose: text(definitionFact.value.purpose) ?? text(existing.purpose) ?? "Workflow",
    members: Array.isArray(existing.members) ? existing.members : [],
    diagrams,
  }
  const escaped = JSON.stringify(bundle, null, 2).replaceAll("<", "\\u003c")
  const pattern =
    /(<script\b(?=[^>]*\btype=["']application\/derive-facts["'])(?=[^>]*\bdata-fact=["']bundle-manifest["'])[^>]*>)[\s\S]*?(<\/script\s*>)/i
  if (!pattern.test(source)) throw new Error("bundle-manifest fact is missing")
  const next = source.replace(pattern, (_match, open, close) => `${open}\n${escaped}\n${close}`)
  return { source: next, changed: next !== source }
}

const cyclicComponents = (nodes, routes) => {
  const outgoing = new Map(nodes.map((node) => [node, []]))
  for (const route of routes) outgoing.get(route.from)?.push(route.to)
  let nextIndex = 0
  const indices = new Map()
  const lows = new Map()
  const stack = []
  const stacked = new Set()
  const components = []
  const visit = (id) => {
    indices.set(id, nextIndex)
    lows.set(id, nextIndex++)
    stack.push(id)
    stacked.add(id)
    for (const next of outgoing.get(id) ?? []) {
      if (!indices.has(next)) {
        visit(next)
        lows.set(id, Math.min(lows.get(id), lows.get(next)))
      } else if (stacked.has(next)) {
        lows.set(id, Math.min(lows.get(id), indices.get(next)))
      }
    }
    if (lows.get(id) !== indices.get(id)) return
    const component = []
    let member
    do {
      member = stack.pop()
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

function validateBundle(value, errors) {
  if (!object(value) || value.schema !== "derive.linked-bundle/v1") {
    errors.push("WF-02 workflow-definition requires a valid bundle-manifest in the same artifact")
    return null
  }
  const purpose = text(value.purpose)
  if (!purpose) errors.push("WF-02 bundle-manifest purpose is required")
  const members = Array.isArray(value.members) ? value.members : []
  if (!Array.isArray(value.members)) errors.push("WF-02 bundle-manifest members must be an array")
  else if (!members.length && (!Array.isArray(value.diagrams) || !value.diagrams.length))
    errors.push("WF-02 bundle-manifest members or diagrams must contain at least one item")
  const memberIds = new Set()
  for (const [index, member] of members.entries()) {
    const id = object(member) ? localId(member.id) : null
    const label = object(member) ? text(member.label) : null
    const ref = object(member) ? text(member.ref) : null
    const shortRef = ref?.match(/(?:^|\/artifacts\/)([0-9a-z]{6,12})(?:[/?#]|$)/)?.[1]
    if (!id || !label || !shortRef)
      errors.push(`WF-02 bundle-manifest member[${index}] requires a valid id, ref, and label`)
    else if (memberIds.has(id)) errors.push(`WF-02 bundle-manifest repeats member "${id}"`)
    else memberIds.add(id)
  }
  const diagrams = Array.isArray(value.diagrams) ? value.diagrams : []
  const diagramIds = new Set()
  return {
    purpose,
    diagrams: diagrams.filter(object).map((diagram, diagramIndex) => {
      const id = localId(diagram.id)
      const title = text(diagram.title)
      const type = diagram.type === "graph" || diagram.type === "loop" ? diagram.type : null
      const rawNodes = Array.isArray(diagram.nodes) ? diagram.nodes : []
      const rawEdges = Array.isArray(diagram.edges) ? diagram.edges : []
      if (!id || !title || !type || !rawNodes.length || !Array.isArray(diagram.edges))
        errors.push(
          `WF-02 bundle-manifest diagram[${diagramIndex}] requires id, title, type, nodes, and edges`,
        )
      else if (diagramIds.has(id)) errors.push(`WF-02 bundle-manifest repeats diagram "${id}"`)
      else diagramIds.add(id)
      const nodeIds = new Set()
      const nodes = rawNodes.filter(object).map((node, nodeIndex) => {
        const nodeId = localId(node.id)
        const label = text(node.label)
        const member = node.member === undefined ? null : localId(node.member)
        if (!nodeId || !label)
          errors.push(
            `WF-02 bundle-manifest diagram[${diagramIndex}] node[${nodeIndex}] requires id and label`,
          )
        else if (nodeIds.has(nodeId))
          errors.push(
            `WF-02 bundle-manifest diagram "${id ?? diagramIndex}" repeats node "${nodeId}"`,
          )
        else nodeIds.add(nodeId)
        if (member && !memberIds.has(member))
          errors.push(`WF-02 bundle-manifest node "${nodeId ?? nodeIndex}" names unknown member`)
        return { id: nodeId, label }
      })
      const edges = rawEdges.filter(object).map((edge, edgeIndex) => {
        const from = localId(edge.from)
        const to = localId(edge.to)
        if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to))
          errors.push(
            `WF-02 bundle-manifest diagram[${diagramIndex}] edge[${edgeIndex}] names an unknown node`,
          )
        return { from, to }
      })
      return { id, title, type, nodes, edges }
    }),
  }
}

function validateDefinition(value, bundle, errors) {
  if (!object(value)) {
    errors.push("WF-01 definition must be an object")
    return null
  }
  if (value.schema !== WORKFLOW_DEFINITION_SCHEMA)
    errors.push(`WF-01 schema must be "${WORKFLOW_DEFINITION_SCHEMA}"`)
  const purpose = text(value.purpose)
  if (!purpose) errors.push("WF-01 purpose is required")
  if (!Array.isArray(value.diagrams) || value.diagrams.length === 0)
    errors.push("WF-02 diagrams must contain at least one workflow")

  const diagramIds = new Set()
  const diagrams = []
  for (const [diagramIndex, rawDiagram] of (Array.isArray(value.diagrams)
    ? value.diagrams
    : []
  ).entries()) {
    if (!object(rawDiagram)) {
      errors.push(`WF-01 diagrams[${diagramIndex}] must be an object`)
      continue
    }
    const id = localId(rawDiagram.id)
    if (!id) errors.push(`WF-01 diagrams[${diagramIndex}].id must be a stable local id`)
    else if (diagramIds.has(id)) errors.push(`WF-01 duplicate diagram id "${id}"`)
    else diagramIds.add(id)

    const nodeIds = new Set()
    const nodes = []
    if (!Array.isArray(rawDiagram.nodes) || rawDiagram.nodes.length === 0)
      errors.push(`WF-02 diagrams[${diagramIndex}].nodes must not be empty`)
    for (const [nodeIndex, rawNode] of (Array.isArray(rawDiagram.nodes)
      ? rawDiagram.nodes
      : []
    ).entries()) {
      if (!object(rawNode)) {
        errors.push(`WF-01 diagrams[${diagramIndex}].nodes[${nodeIndex}] must be an object`)
        continue
      }
      const nodeId = localId(rawNode.id)
      if (!nodeId)
        errors.push(
          `WF-01 diagrams[${diagramIndex}].nodes[${nodeIndex}].id must be a stable local id`,
        )
      else if (nodeIds.has(nodeId)) errors.push(`WF-01 duplicate node id "${nodeId}" in diagram`)
      else nodeIds.add(nodeId)
      const kind = ["context", "human", "terminal"].includes(rawNode.kind) ? rawNode.kind : null
      if (!kind)
        errors.push(
          `WF-03 diagrams[${diagramIndex}].nodes[${nodeIndex}].kind must be "context", "human", or "terminal"`,
        )
      const contextRef = text(rawNode.context_ref)
      const instruction = text(rawNode.instruction)
      const result = text(rawNode.result)
      const decision = text(rawNode.decision)
      const options = texts(rawNode.options)
      const resume = text(rawNode.resume)
      const terminal = rawNode.terminal === true
      const routing = ["all", "one"].includes(rawNode.routing) ? rawNode.routing : null
      if (rawNode.routing !== undefined && !routing)
        errors.push(`WF-02 node "${nodeId ?? nodeIndex}" routing must be "all" or "one"`)
      if (kind !== "context" && routing)
        errors.push(`WF-02 node "${nodeId ?? nodeIndex}" routing is only valid on context nodes`)
      if (kind === "context" && (!contextRef || !instruction || !result))
        errors.push(
          `WF-03 context node "${nodeId ?? nodeIndex}" requires context_ref, instruction, and result`,
        )
      if (kind === "human" && (!decision || !options || options.length < 2 || !resume))
        errors.push(
          `WF-07 human node "${nodeId ?? nodeIndex}" requires decision, at least two options, and resume`,
        )
      if (kind === "terminal" && !result)
        errors.push(`WF-02 terminal node "${nodeId ?? nodeIndex}" requires result`)

      const effects = []
      if (rawNode.effects !== undefined && !Array.isArray(rawNode.effects))
        errors.push(`WF-05 node "${nodeId ?? nodeIndex}" effects must be an array`)
      for (const [effectIndex, rawEffect] of (Array.isArray(rawNode.effects)
        ? rawNode.effects
        : []
      ).entries()) {
        if (!object(rawEffect)) {
          errors.push(
            `WF-05 node "${nodeId ?? nodeIndex}" effect[${effectIndex}] must be an object`,
          )
          continue
        }
        const effectKind = ["read", "write", "message", "spend", "access"].includes(rawEffect.kind)
          ? rawEffect.kind
          : null
        const description = text(rawEffect.description)
        const gate = ["none", "human"].includes(rawEffect.gate) ? rawEffect.gate : null
        const approvalRef = localId(rawEffect.approval_ref)
        const idempotency = text(rawEffect.idempotency)
        const compensation = text(rawEffect.compensation)
        if (!effectKind || !description || !gate)
          errors.push(
            `WF-05 node "${nodeId ?? nodeIndex}" effect[${effectIndex}] requires kind, description, and gate`,
          )
        if (effectKind && effectKind !== "read" && gate === "none" && !idempotency)
          errors.push(
            `WF-05 node "${nodeId ?? nodeIndex}" ${effectKind} effect needs a human gate or idempotency`,
          )
        if (gate === "human" && !approvalRef)
          errors.push(
            `WF-05 node "${nodeId ?? nodeIndex}" ${effectKind ?? "external"} effect with a human gate requires approval_ref`,
          )
        if (gate === "none" && rawEffect.approval_ref !== undefined)
          errors.push(
            `WF-05 node "${nodeId ?? nodeIndex}" effect approval_ref is only valid with a human gate`,
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
      if (nodeId && kind)
        nodes.push({
          id: nodeId,
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
      errors.push(`WF-02 diagram "${id ?? diagramIndex}" requires an entry node`)
    const humanNodeIds = new Set(
      nodes.filter((node) => node.kind === "human").map((node) => node.id),
    )
    for (const node of nodes)
      for (const effect of node.effects ?? [])
        if (effect.gate === "human" && !humanNodeIds.has(effect.approval_ref ?? ""))
          errors.push(
            `WF-05 node "${node.id}" effect approval_ref must name a human node in the diagram`,
          )

    const routes = []
    const routeKeys = new Set()
    if (!Array.isArray(rawDiagram.routes))
      errors.push(`WF-02 diagrams[${diagramIndex}].routes must be an array`)
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
      if (!from || !to || !when)
        errors.push(
          `WF-02 diagrams[${diagramIndex}].routes[${routeIndex}] needs from, to, and when`,
        )
      else if (!nodeIds.has(from) || !nodeIds.has(to))
        errors.push(`WF-02 route "${from}" → "${to}" references an unknown node`)
      else if (routeKeys.has(edgeKey(from, to)))
        errors.push(`WF-01 duplicate route "${from}" → "${to}"`)
      else {
        routeKeys.add(edgeKey(from, to))
        routes.push({ from, to, when, ...(rawRoute.fallback === true ? { fallback: true } : {}) })
      }
    }
    const outgoing = new Set(routes.map((route) => route.from))
    for (const node of nodes)
      if (node.kind !== "terminal" && !node.terminal && !outgoing.has(node.id))
        errors.push(`WF-02 non-terminal node "${node.id}" has no outgoing route`)
      else if ((node.kind === "terminal" || node.terminal) && outgoing.has(node.id))
        errors.push(`WF-02 terminal node "${node.id}" must not have an outgoing route`)
    if (!nodes.some((node) => node.kind === "terminal" || node.terminal))
      errors.push(`WF-02 diagram "${id ?? diagramIndex}" requires a terminal node`)
    const routesBySource = new Map()
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
        const from = queue.shift()
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

    const loops = []
    for (const [loopIndex, rawLoop] of (Array.isArray(rawDiagram.loops)
      ? rawDiagram.loops
      : []
    ).entries()) {
      if (!object(rawLoop)) {
        errors.push(`WF-04 diagrams[${diagramIndex}].loops[${loopIndex}] must be an object`)
        continue
      }
      const loopId = localId(rawLoop.id)
      const loopNodes = texts(rawLoop.nodes)
      const goal = text(rawLoop.goal)
      const evaluate = text(rawLoop.evaluate)
      const stop = object(rawLoop.stop) ? rawLoop.stop : null
      const maxAttempts = positive(stop?.max_attempts)
      const stagnationLimit = positive(stop?.stagnation_limit)
      const maxMinutes = positive(stop?.max_minutes)
      const maxCost = positive(stop?.max_cost_usd)
      const humanStop = text(stop?.human_stop)
      if (!loopId || !loopNodes?.length || !goal || !evaluate || !maxAttempts || !humanStop)
        errors.push(
          `WF-04 loop[${loopIndex}] requires id, nodes, goal, evaluate, max_attempts, and human_stop`,
        )
      if (maxAttempts && (!Number.isInteger(maxAttempts) || maxAttempts > 100))
        errors.push(
          `WF-04 loop "${loopId ?? loopIndex}" max_attempts must be an integer from 1 to 100`,
        )
      if (stagnationLimit && maxAttempts && stagnationLimit > maxAttempts)
        errors.push(`WF-04 loop "${loopId ?? loopIndex}" stagnation_limit exceeds max_attempts`)
      for (const node of loopNodes ?? [])
        if (!nodeIds.has(node))
          errors.push(`WF-04 loop "${loopId ?? loopIndex}" references unknown node "${node}"`)
      if (loopId && loopNodes?.length && goal && evaluate && maxAttempts && humanStop)
        loops.push({
          id: loopId,
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

    const scenarios = []
    const kinds = new Set()
    if (!Array.isArray(rawDiagram.scenarios) || rawDiagram.scenarios.length === 0)
      errors.push(`WF-10 diagrams[${diagramIndex}].scenarios must not be empty`)
    for (const [scenarioIndex, rawScenario] of (Array.isArray(rawDiagram.scenarios)
      ? rawDiagram.scenarios
      : []
    ).entries()) {
      if (!object(rawScenario)) {
        errors.push(`WF-10 diagrams[${diagramIndex}].scenarios[${scenarioIndex}] must be an object`)
        continue
      }
      const scenarioId = localId(rawScenario.id)
      const kind = ["expected", "failure", "human"].includes(rawScenario.kind)
        ? rawScenario.kind
        : null
      const path = texts(rawScenario.path)
      const outcome = text(rawScenario.outcome)
      if (!scenarioId || !kind || !path?.length || !outcome)
        errors.push(`WF-10 scenario[${scenarioIndex}] requires id, kind, path, and outcome`)
      if (path?.length && entry && path[0] !== entry)
        errors.push(
          `WF-10 scenario "${scenarioId ?? scenarioIndex}" must start at entry "${entry}"`,
        )
      for (const node of path ?? [])
        if (!nodeIds.has(node))
          errors.push(
            `WF-10 scenario "${scenarioId ?? scenarioIndex}" references unknown node "${node}"`,
          )
      for (let i = 1; i < (path?.length ?? 0); i++) {
        const from = path?.[i - 1]
        const to = path?.[i]
        if (from && to && !routeKeys.has(edgeKey(from, to)))
          errors.push(
            `WF-10 scenario "${scenarioId ?? scenarioIndex}" takes nonexistent route "${from}" → "${to}"`,
          )
      }
      const last = path?.at(-1)
      if (
        kind !== "failure" &&
        last &&
        !nodes.some(
          (node) => node.id === last && (node.kind === "terminal" || node.terminal === true),
        )
      )
        errors.push(`WF-10 scenario "${scenarioId ?? scenarioIndex}" must end at a terminal node`)
      if (kind) kinds.add(kind)
      if (scenarioId && kind && path?.length && outcome)
        scenarios.push({ id: scenarioId, kind, path, outcome })
    }
    if (!kinds.has("expected"))
      errors.push(`WF-10 diagram "${id ?? diagramIndex}" needs an expected scenario`)
    if (nodes.some((node) => node.kind === "context") && !kinds.has("failure"))
      errors.push(`WF-10 diagram "${id ?? diagramIndex}" needs a failure scenario`)
    if (nodes.some((node) => node.kind === "human") && !kinds.has("human"))
      errors.push(`WF-10 diagram "${id ?? diagramIndex}" needs a human scenario`)
    for (const node of nodes.filter((node) => node.kind === "human"))
      if (
        !scenarios.some((scenario) => scenario.kind === "human" && scenario.path.includes(node.id))
      )
        errors.push(`WF-10 human node "${node.id}" is not covered by a human scenario`)
    if (id)
      diagrams.push({
        id,
        entry: entry ?? "",
        nodes,
        routes,
        ...(loops.length ? { loops } : {}),
        scenarios,
      })
  }

  const forbidden = texts(value.forbidden)
  if (value.forbidden !== undefined && !forbidden)
    errors.push("WF-05 forbidden must be an array of non-empty strings")

  if (bundle) {
    if (purpose && bundle.purpose !== purpose)
      errors.push("WF-02 workflow purpose must match bundle-manifest purpose")
    const visibleById = new Map(bundle.diagrams.map((diagram) => [diagram.id, diagram]))
    for (const diagram of diagrams) {
      const visible = visibleById.get(diagram.id)
      if (!visible) {
        errors.push(`WF-02 workflow diagram "${diagram.id}" is missing from bundle-manifest`)
        continue
      }
      const visibleNodes = new Set(visible.nodes.map((node) => node.id).filter(Boolean))
      const definedNodes = new Set(diagram.nodes.map((node) => node.id))
      for (const node of visibleNodes)
        if (!definedNodes.has(node))
          errors.push(`WF-02 visible node "${diagram.id}/${node}" has no workflow definition`)
      for (const node of definedNodes)
        if (!visibleNodes.has(node))
          errors.push(
            `WF-02 workflow node "${diagram.id}/${node}" is not visible in bundle-manifest`,
          )
      const labels = new Map(visible.nodes.map((node) => [node.id, node.label]))
      const visibleEdges = new Set(
        visible.edges
          .filter((edge) => edge.from && edge.to)
          .map((edge) => edgeKey(edge.from, edge.to)),
      )
      const definedRoutes = new Set(diagram.routes.map((route) => edgeKey(route.from, route.to)))
      for (const edge of visible.edges)
        if (edge.from && edge.to && !definedRoutes.has(edgeKey(edge.from, edge.to)))
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
    for (const diagram of bundle.diagrams)
      if (diagram.id && !diagramIds.has(diagram.id))
        errors.push(`WF-02 visible diagram "${diagram.id}" has no workflow definition`)
  }

  if (errors.length || !purpose) return null
  return {
    schema: WORKFLOW_DEFINITION_SCHEMA,
    purpose,
    diagrams,
    ...(forbidden?.length ? { forbidden } : {}),
  }
}

export function previewWorkflowSource(source) {
  const errors = []
  const warnings = []
  const linkedFact = factJson(source, "bundle-manifest")
  const workflowFact = factJson(source, "workflow-definition")
  if (linkedFact.error) errors.push(`WF-02 ${linkedFact.error}`)
  if (workflowFact.error) errors.push(`WF-01 ${workflowFact.error}`)
  if (!workflowFact.value && !workflowFact.error)
    errors.push("WF-01 no workflow-definition fact found")
  const bundle = validateBundle(linkedFact.value, errors)
  const definition = workflowFact.value
    ? validateDefinition(workflowFact.value, bundle, errors)
    : null
  if (!definition || errors.length)
    return {
      status: "needs-changes",
      execution_started: false,
      purpose: null,
      errors,
      warnings,
      diagrams: [],
      cannot_do: [],
    }

  const visibleById = new Map(bundle.diagrams.map((diagram) => [diagram.id, diagram]))
  return {
    status: "ready",
    execution_started: false,
    purpose: definition.purpose,
    errors: [],
    warnings,
    diagrams: definition.diagrams.map((diagram) => {
      const visible = visibleById.get(diagram.id)
      const labels = new Map(visible.nodes.map((node) => [node.id, node.label]))
      const label = (id) => labels.get(id) ?? id
      return {
        id: diagram.id,
        title: visible.title ?? diagram.id,
        will_do: diagram.nodes
          .filter((node) => node.kind === "context")
          .map((node) => `${label(node.id)} — ${node.result}`),
        may_do: diagram.routes
          .filter((route) => route.when.toLowerCase() !== "always")
          .map((route) => `${label(route.from)} → ${label(route.to)} when ${route.when}`),
        will_pause: diagram.nodes
          .filter((node) => node.kind === "human")
          .map((node) => `${label(node.id)} — ${node.decision}; resume: ${node.resume}`),
        can_repeat: (diagram.loops ?? []).map(
          (loop) =>
            `${loop.goal} — at most ${loop.stop.max_attempts} attempts; human stop: ${loop.stop.human_stop}`,
        ),
        side_effects: diagram.nodes.flatMap((node) =>
          (node.effects ?? [])
            .filter((effect) => effect.kind !== "read")
            .map(
              (effect) =>
                `${effect.description} — ${effect.gate === "human" ? `authorized at ${label(effect.approval_ref ?? "human gate")}` : `replay-safe: ${effect.idempotency}`}`,
            ),
        ),
        context_sessions: diagram.nodes
          .filter((node) => node.kind === "context" && node.context_ref)
          .map((node) => {
            const incoming = diagram.routes.filter((route) => route.to === node.id)
            return {
              node_id: node.id,
              label: label(node.id),
              context_ref: node.context_ref,
              starts_when:
                node.id === diagram.entry
                  ? "explicit run"
                  : incoming
                      .map((route) => `${label(route.from)} returns ${route.when}`)
                      .join("; "),
            }
          }),
        scenarios: diagram.scenarios.map((scenario) => ({
          kind: scenario.kind,
          outcome: scenario.outcome,
        })),
      }
    }),
    cannot_do: definition.forbidden ?? [],
  }
}

const section = (title, rows) => {
  if (!rows.length) return []
  return [`\n${title}`, ...rows.map((row) => `  - ${row}`)]
}

export function formatWorkflowPreview(preview) {
  if (preview.status !== "ready")
    return [
      `✗ Needs changes — ${preview.errors.length} blocker${preview.errors.length === 1 ? "" : "s"}`,
      "  Preview only — no context session has started.",
      ...preview.errors.map((error) => `  - ${error}`),
      ...section("Warnings", preview.warnings),
    ].join("\n")
  const lines = [
    `✓ Ready to run — ${preview.purpose}`,
    "Preview only — no context session has started.",
  ]
  for (const diagram of preview.diagrams) {
    lines.push(`\n${diagram.title}`)
    lines.push(...section("Will do", diagram.will_do))
    lines.push(...section("May branch", diagram.may_do))
    lines.push(...section("Will pause", diagram.will_pause))
    lines.push(...section("Can repeat", diagram.can_repeat))
    lines.push(...section("External effects", diagram.side_effects))
    lines.push(
      ...section(
        "Context sessions on explicit run",
        diagram.context_sessions.map(
          (session) =>
            `${session.label} → ${session.context_ref}; starts when ${session.starts_when}`,
        ),
      ),
    )
    lines.push(
      ...section(
        "Scenarios checked",
        diagram.scenarios.map((scenario) => `${scenario.kind}: ${scenario.outcome}`),
      ),
    )
  }
  lines.push(...section("Cannot do", preview.cannot_do))
  lines.push(...section("Warnings", preview.warnings))
  return lines.join("\n")
}
