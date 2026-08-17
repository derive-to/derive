import { LINKED_BUNDLE_HTML_CONTENT_TYPE } from "./content-types"
import { artifactRefIn, artifactRefOf } from "./derived-facts"
import { parseFacts } from "./facts"

/** A linked bundle is still an ordinary HTML artifact. This content type only lets
 * the host reward the optional bundle-manifest fact with native chrome. */
export const LINKED_BUNDLE_CONTENT_TYPE = LINKED_BUNDLE_HTML_CONTENT_TYPE
export const LINKED_BUNDLE_FACT = "bundle-manifest"
export const LINKED_BUNDLE_SCHEMA = "derive.linked-bundle/v1"

export interface LinkedBundleMember {
  /** Stable, bundle-local name used by diagrams. */
  id: string
  /** Derive artifact short id (a full artifact URL is accepted and normalized). */
  ref: string
  label: string
  role?: string
  note?: string
}

export interface LinkedBundleNode {
  id: string
  label: string
  /** Optional member id when this node is backed by an artifact. */
  member?: string
  /** Explicit workflow state authored by an agent or editor. Derive displays it;
   * it never infers or advances it. */
  state?: "pending" | "active" | "blocked" | "done"
  /** The linked member version the authored state was based on. When the member
   * moves past this version the UI can show an honest "artifact updated" cue. */
  basis_version?: number
  /** Short human-readable context for the current state. */
  note?: string
}

export interface LinkedBundleEdge {
  from: string
  to: string
  label?: string
}

export interface LinkedBundleDiagram {
  id: string
  title: string
  /** A loop is a repeating improvement cycle; a graph is topology. */
  type: "loop" | "graph"
  nodes: LinkedBundleNode[]
  edges: LinkedBundleEdge[]
  /** Descriptive, inspectable loop policy. Derive does not execute it. */
  goal?: string
  evaluate?: string
  stop?: string
}

export interface LinkedBundleManifest {
  schema: typeof LINKED_BUNDLE_SCHEMA
  purpose: string
  members: LinkedBundleMember[]
  diagrams?: LinkedBundleDiagram[]
}

export interface LinkedBundleValidation {
  manifest: LinkedBundleManifest | null
  errors: string[]
  warnings: string[]
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null
const localId = (value: unknown): string | null => {
  const id = text(value)
  return id && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) ? id : null
}

const hasDirectedCycle = (nodes: LinkedBundleNode[], edges: LinkedBundleEdge[]): boolean => {
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to)
  const active = new Set<string>()
  const complete = new Set<string>()
  const visit = (id: string): boolean => {
    if (active.has(id)) return true
    if (complete.has(id)) return false
    active.add(id)
    if (outgoing.get(id)?.some(visit)) return true
    active.delete(id)
    complete.add(id)
    return false
  }
  return nodes.some((node) => visit(node.id))
}

/** Validate and normalize the authored manifest. It is presentation metadata, not an
 * execution contract: loop policies are shown to people and agents, never run here. */
export const validateLinkedBundle = (value: unknown): LinkedBundleValidation => {
  const errors: string[] = []
  const warnings: string[] = []
  if (!object(value))
    return { manifest: null, errors: ["manifest must be a JSON object"], warnings }
  if (value.schema !== LINKED_BUNDLE_SCHEMA) errors.push(`schema must be "${LINKED_BUNDLE_SCHEMA}"`)
  const purpose = text(value.purpose)
  if (!purpose) errors.push("purpose is required")
  if (!Array.isArray(value.members) || value.members.length === 0)
    errors.push("members must contain at least one artifact")

  const memberIds = new Set<string>()
  const members: LinkedBundleMember[] = []
  for (const [index, raw] of (Array.isArray(value.members) ? value.members : []).entries()) {
    if (!object(raw)) {
      errors.push(`members[${index}] must be an object`)
      continue
    }
    const id = localId(raw.id)
    const ref = text(raw.ref)
    const shortId = ref ? (artifactRefIn(ref) ?? artifactRefOf(ref)) : null
    const label = text(raw.label)
    if (!id) errors.push(`members[${index}].id must be a short local id`)
    else if (memberIds.has(id)) errors.push(`duplicate member id "${id}"`)
    if (!shortId) errors.push(`members[${index}].ref must identify a Derive artifact`)
    if (!label) errors.push(`members[${index}].label is required`)
    if (!id || !shortId || !label || memberIds.has(id)) continue
    memberIds.add(id)
    members.push({
      id,
      ref: shortId,
      label,
      ...(text(raw.role) ? { role: text(raw.role) as string } : {}),
      ...(text(raw.note) ? { note: text(raw.note) as string } : {}),
    })
  }

  const diagrams: LinkedBundleDiagram[] = []
  const diagramIds = new Set<string>()
  if (value.diagrams !== undefined && !Array.isArray(value.diagrams))
    errors.push("diagrams must be an array when present")
  for (const [index, raw] of (Array.isArray(value.diagrams) ? value.diagrams : []).entries()) {
    if (!object(raw)) {
      errors.push(`diagrams[${index}] must be an object`)
      continue
    }
    const id = localId(raw.id)
    const repeatedId = !!id && diagramIds.has(id)
    const title = text(raw.title)
    const type = raw.type === "loop" || raw.type === "graph" ? raw.type : null
    if (!id) errors.push(`diagrams[${index}].id must be a short local id`)
    else if (repeatedId) errors.push(`duplicate diagram id "${id}"`)
    else diagramIds.add(id)
    if (!title) errors.push(`diagrams[${index}].title is required`)
    if (!type) errors.push(`diagrams[${index}].type must be "loop" or "graph"`)
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0)
      errors.push(`diagrams[${index}].nodes must not be empty`)
    if (!Array.isArray(raw.edges)) errors.push(`diagrams[${index}].edges must be an array`)

    const nodeIds = new Set<string>()
    const nodes: LinkedBundleNode[] = []
    for (const [nodeIndex, nodeRaw] of (Array.isArray(raw.nodes) ? raw.nodes : []).entries()) {
      if (!object(nodeRaw)) {
        errors.push(`diagrams[${index}].nodes[${nodeIndex}] must be an object`)
        continue
      }
      const nodeId = localId(nodeRaw.id)
      const nodeLabel = text(nodeRaw.label)
      const member = nodeRaw.member === undefined ? null : localId(nodeRaw.member)
      const state =
        nodeRaw.state === "pending" ||
        nodeRaw.state === "active" ||
        nodeRaw.state === "blocked" ||
        nodeRaw.state === "done"
          ? nodeRaw.state
          : null
      const basisVersion =
        Number.isInteger(nodeRaw.basis_version) && Number(nodeRaw.basis_version) > 0
          ? Number(nodeRaw.basis_version)
          : null
      if (!nodeId) errors.push(`diagrams[${index}].nodes[${nodeIndex}].id is invalid`)
      else if (nodeIds.has(nodeId)) errors.push(`diagram "${id ?? index}" repeats node "${nodeId}"`)
      if (!nodeLabel) errors.push(`diagrams[${index}].nodes[${nodeIndex}].label is required`)
      if (nodeRaw.state !== undefined && !state)
        errors.push(
          `diagrams[${index}].nodes[${nodeIndex}].state must be "pending", "active", "blocked", or "done"`,
        )
      if (nodeRaw.basis_version !== undefined && !basisVersion)
        errors.push(`diagrams[${index}].nodes[${nodeIndex}].basis_version must be positive`)
      if (member && !memberIds.has(member))
        errors.push(`diagram node "${nodeId ?? nodeIndex}" names unknown member "${member}"`)
      if (basisVersion && !member)
        warnings.push(
          `diagram node "${nodeId ?? nodeIndex}" has basis_version but no linked member`,
        )
      if (!nodeId || !nodeLabel || nodeIds.has(nodeId)) continue
      nodeIds.add(nodeId)
      nodes.push({
        id: nodeId,
        label: nodeLabel,
        ...(member ? { member } : {}),
        ...(state ? { state } : {}),
        ...(basisVersion ? { basis_version: basisVersion } : {}),
        ...(text(nodeRaw.note) ? { note: text(nodeRaw.note) as string } : {}),
      })
    }

    const edges: LinkedBundleEdge[] = []
    for (const [edgeIndex, edgeRaw] of (Array.isArray(raw.edges) ? raw.edges : []).entries()) {
      if (!object(edgeRaw)) {
        errors.push(`diagrams[${index}].edges[${edgeIndex}] must be an object`)
        continue
      }
      const from = localId(edgeRaw.from)
      const to = localId(edgeRaw.to)
      if (!from || !nodeIds.has(from))
        errors.push(`diagrams[${index}].edges[${edgeIndex}].from names an unknown node`)
      if (!to || !nodeIds.has(to))
        errors.push(`diagrams[${index}].edges[${edgeIndex}].to names an unknown node`)
      if (from && to && nodeIds.has(from) && nodeIds.has(to))
        edges.push({
          from,
          to,
          ...(text(edgeRaw.label) ? { label: text(edgeRaw.label) as string } : {}),
        })
    }

    const goal = text(raw.goal)
    const evaluate = text(raw.evaluate)
    const stop = text(raw.stop)
    if (type === "loop") {
      if (!goal) warnings.push(`loop "${id ?? index}" has no stated goal`)
      if (!evaluate) warnings.push(`loop "${id ?? index}" has no evaluation condition`)
      if (!stop) warnings.push(`loop "${id ?? index}" has no stop condition`)
      if (!hasDirectedCycle(nodes, edges))
        warnings.push(`loop "${id ?? index}" has no directed cycle`)
    } else if (goal || evaluate || stop) {
      warnings.push(`graph "${id ?? index}" carries loop policy; use type "loop" if it repeats`)
    }
    if (id && !repeatedId && title && type && nodes.length)
      diagrams.push({
        id,
        title,
        type,
        nodes,
        edges,
        ...(goal ? { goal } : {}),
        ...(evaluate ? { evaluate } : {}),
        ...(stop ? { stop } : {}),
      })
  }

  return errors.length
    ? { manifest: null, errors, warnings }
    : {
        manifest: {
          schema: LINKED_BUNDLE_SCHEMA,
          purpose: purpose as string,
          members,
          ...(diagrams.length ? { diagrams } : {}),
        },
        errors,
        warnings,
      }
}

/** Read the canonical fact from an HTML artifact. */
export const linkedBundleOf = (source: string): LinkedBundleValidation | null => {
  const row = parseFacts(source, "text/html").facts.find((fact) => fact.slot === LINKED_BUNDLE_FACT)
  if (!row) return null
  try {
    return validateLinkedBundle(JSON.parse(row.json))
  } catch {
    return { manifest: null, errors: ["bundle-manifest is not valid JSON"], warnings: [] }
  }
}

/** Human-readable publish feedback for the contract and its one-model rendering rule. */
export const linkedBundleAdvisories = (source: string): string[] => {
  const result = linkedBundleOf(source)
  if (!result) return []
  const out = [
    ...result.errors.map((error) => `Linked bundle manifest: ${error}.`),
    ...result.warnings.map((warning) => `Linked bundle manifest: ${warning}.`),
  ]
  if (!result.manifest) return out
  const linked = new Set<string>()
  for (const match of source.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const ref = artifactRefIn(match[1] ?? match[2] ?? match[3] ?? "")
    if (ref) linked.add(ref)
  }
  const hidden = result.manifest.members.filter((member) => !linked.has(member.ref))
  if (hidden.length)
    out.push(
      `${hidden.length} linked bundle member${hidden.length === 1 ? " is" : "s are"} in the manifest but not a visible artifact link (${hidden
        .slice(0, 3)
        .map((member) => member.label)
        .join(
          ", ",
        )}${hidden.length > 3 ? ", …" : ""}). Render links and the manifest from the same model so people and agents see the same bundle.`,
    )
  return out
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string,
  )

/** Stable DOM identity for a semantic review target rendered from a linked-bundle
 * manifest. Comments pin to these authored ids, so a cosmetic layout rewrite does
 * not detach discussion from the loop step, policy, graph node, or edge it names. */
export const linkedBundleReviewId = (
  diagramId: string,
  kind: "diagram" | "node" | "edge" | "policy",
  localId: string,
): string => `derive-${diagramId}-${kind}-${localId}`

const reviewAttrs = (id: string, kind: string, label: string): string =>
  `id="${escapeHtml(id)}" data-derive-review-id="${escapeHtml(id)}" data-derive-review-kind="${escapeHtml(kind)}" data-derive-review-label="${escapeHtml(label)}"`

/** Minimal canonical page: the visible links and the fact come from the same object.
 * Agents can style the shell, but should keep this one-model rendering invariant. */
export const renderLinkedBundle = (
  manifest: LinkedBundleManifest,
  title = "Linked bundle",
): string => {
  const checked = validateLinkedBundle(manifest)
  if (!checked.manifest) throw new Error(`invalid linked bundle: ${checked.errors.join("; ")}`)
  const model = checked.manifest
  const json = JSON.stringify(model).replace(/</g, "\\u003c")
  const members = model.members
    .map(
      (member) =>
        `<li><a href="/artifacts/${member.ref}">${escapeHtml(member.label)}</a>${member.role ? ` <small>${escapeHtml(member.role)}</small>` : ""}${member.note ? `<p>${escapeHtml(member.note)}</p>` : ""}</li>`,
    )
    .join("")
  const diagrams = (model.diagrams ?? [])
    .map((diagram) => {
      const policy =
        diagram.type === "loop"
          ? `<dl>${(["goal", "evaluate", "stop"] as const)
              .map((key) => {
                const name = key[0]?.toUpperCase() + key.slice(1)
                const value = diagram[key] ?? "Not stated"
                const id = linkedBundleReviewId(diagram.id, "policy", key)
                return `<div class="policy" ${reviewAttrs(id, "loop-policy", `Loop ${name} — ${value}`)}><dt>${name}</dt><dd>${escapeHtml(value)}</dd></div>`
              })
              .join("")}</dl>`
          : ""
      const nodes = diagram.nodes
        .map((node) => {
          const kind = diagram.type === "loop" ? "loop-step" : "graph-node"
          const id = linkedBundleReviewId(diagram.id, "node", node.id)
          return `<div class="node" ${reviewAttrs(id, kind, `${diagram.type === "loop" ? "Loop step" : "Graph node"} — ${node.label}`)}${node.state ? ` data-state="${node.state}"` : ""}><strong>${escapeHtml(node.label)}</strong>${node.state ? `<small>${escapeHtml(node.state)}</small>` : ""}${node.member ? `<small>${escapeHtml(node.member)}${node.basis_version ? ` · based on v${node.basis_version}` : ""}</small>` : ""}${node.note ? `<p>${escapeHtml(node.note)}</p>` : ""}</div>`
        })
        .join("")
      const edges = diagram.edges
        .map((edge, index) => {
          const edgeName = `${edge.from} → ${edge.to}${edge.label ? ` · ${edge.label}` : ""}`
          const id = linkedBundleReviewId(diagram.id, "edge", `${index}-${edge.from}-${edge.to}`)
          const kind = diagram.type === "loop" ? "loop-transition" : "graph-edge"
          return `<div class="edge" ${reviewAttrs(id, kind, `${diagram.type === "loop" ? "Loop transition" : "Graph edge"} — ${edgeName}`)}><span>${escapeHtml(edge.from)}</span><span class="arrow">→${edge.label ? ` ${escapeHtml(edge.label)}` : ""}</span><span>${escapeHtml(edge.to)}</span></div>`
        })
        .join("")
      return `<section class="diagram ${diagram.type}"><p class="eyebrow">${diagram.type}</p><h2>${escapeHtml(diagram.title)}</h2>${policy}<div class="nodes">${nodes}</div><div class="edges">${edges}</div></section>`
    })
    .join("")
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:880px;margin:auto;padding:clamp(24px,5vw,64px);color:#171717}h1{font-size:clamp(2rem,6vw,4rem);letter-spacing:-.05em}.eyebrow,small,.arrow{color:#68706a}section{border-top:1px solid #ddd;padding-top:24px;margin-top:40px}li{margin:.75rem 0}a{color:inherit;text-underline-offset:3px}dl{display:grid;gap:8px}.policy{display:grid;grid-template-columns:100px 1fr;gap:8px}.policy dt{color:#68706a}.policy dd{margin:0}.nodes{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:24px}.edges{display:grid;gap:8px;margin-top:12px}.edge{display:flex;align-items:center;gap:10px;overflow:auto;border-top:1px solid #eee;padding-top:8px}.node{border:1px solid #ddd;border-radius:8px;padding:10px 12px}.node strong,.node small{display:block}.arrow{font-size:13px;white-space:nowrap}</style></head><body><p class="eyebrow">Linked bundle</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(model.purpose)}</p><section><h2>Artifacts</h2><ul>${members}</ul></section>${diagrams}<script type="application/derive-facts" data-fact="${LINKED_BUNDLE_FACT}">${json}</script></body></html>`
}
