import { MAX_FACT_BYTES, parseFacts } from "./facts"

export { AGENT_MANIFEST_HTML_CONTENT_TYPE as AGENT_MANIFEST_CONTENT_TYPE } from "./content-types"

import { LINKED_BUNDLE_SCHEMA, type LinkedBundleManifest, linkedBundleOf } from "./linked-bundle"
import {
  previewWorkflowDefinition,
  validateWorkflowDefinition,
  WORKFLOW_DEFINITION_SCHEMA,
  type WorkflowDiagramDefinition,
  type WorkflowPreview,
  workflowDefinitionOf,
} from "./workflow"

export const AGENT_MANIFEST_FACT = "agent-manifest"
export const AGENT_MANIFEST_SCHEMA = "derive.agent-manifest/v2"

export type AgentManifestKind = "single" | "graph" | "loop"
export type AgentManifestSource = "agent-manifest-v2" | "workflow-v1" | "implicit-single"

interface AgentManifestBase {
  schema: typeof AGENT_MANIFEST_SCHEMA
  kind: AgentManifestKind
  purpose: string | null
}

export interface SingleAgentManifest extends AgentManifestBase {
  kind: "single"
  /** The leaf agent's system instructions. Legacy Markdown manifests use their full source. */
  instructions: string
}

export interface CompositeAgentManifest extends AgentManifestBase {
  kind: "graph" | "loop"
  purpose: string
  title: string
  diagram: WorkflowDiagramDefinition
  forbidden?: string[]
  /** Presentation labels keyed by stable node id. They never control routing. */
  labels: Record<string, string>
}

export type AgentManifest = SingleAgentManifest | CompositeAgentManifest

export interface AgentManifestCandidate {
  /** Present even for an invalid authored definition when its declared kind is trustworthy. */
  kind: AgentManifestKind | null
  source: AgentManifestSource
  manifest: AgentManifest | null
  preview: WorkflowPreview | null
  errors: string[]
  warnings: string[]
  /** A legacy workflow artifact may carry more than one independently runnable diagram. */
  legacy_diagram_id?: string
  /** Best-effort authored title, available even when the runnable definition is invalid. */
  title?: string
}

export interface AgentManifestRead {
  candidates: AgentManifestCandidate[]
  /** Parse-level failures that prevented even a candidate from being formed. */
  errors: string[]
}

/** The only context-config field the manifest layer owns. Kept here so REST,
 * MCP, import, and the local runner cannot select different legacy diagrams. */
export const agentManifestSelectorFromConfig = (config: string | null): string | null => {
  if (!config) return null
  try {
    const value = JSON.parse(config) as unknown
    if (!object(value)) return null
    return text(value.legacy_diagram_id)
  } catch {
    return null
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null

const localId = (value: unknown): string | null => {
  const id = text(value)
  return id && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) ? id : null
}

const labelsOf = (value: unknown): Record<string, string> => {
  if (!object(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, raw]) => {
      const id = localId(key)
      const label = text(raw)
      return id && label ? [[id, label]] : []
    }),
  )
}

const linkedProjection = (
  purpose: string,
  title: string,
  kind: "graph" | "loop",
  diagram: WorkflowDiagramDefinition,
  labels: Record<string, string>,
): LinkedBundleManifest => ({
  schema: LINKED_BUNDLE_SCHEMA,
  purpose,
  members: [],
  diagrams: [
    {
      id: diagram.id,
      title,
      type: kind,
      nodes: diagram.nodes.map((node) => ({ id: node.id, label: labels[node.id] ?? node.id })),
      edges: diagram.routes.map((route) => ({
        from: route.from,
        to: route.to,
        label: route.when,
      })),
    },
  ],
})

const linkedProjectionFromRaw = (
  purpose: string,
  title: string,
  kind: "graph" | "loop",
  raw: Record<string, unknown>,
  labels: Record<string, string>,
): LinkedBundleManifest => {
  const id = localId(raw.id) ?? "invalid"
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).flatMap((node) => {
    if (!object(node)) return []
    const nodeId = localId(node.id)
    return nodeId ? [{ id: nodeId, label: labels[nodeId] ?? nodeId }] : []
  })
  const edges = (Array.isArray(raw.routes) ? raw.routes : []).flatMap((route) => {
    if (!object(route)) return []
    const from = localId(route.from)
    const to = localId(route.to)
    return from && to ? [{ from, to, label: text(route.when) ?? undefined }] : []
  })
  return {
    schema: LINKED_BUNDLE_SCHEMA,
    purpose,
    members: [],
    diagrams: [{ id, title, type: kind, nodes, edges }],
  }
}

const invalidPreview = (errors: string[], warnings: string[] = []): WorkflowPreview => ({
  status: "needs-changes",
  execution_started: false,
  purpose: null,
  errors,
  warnings,
  diagrams: [],
  cannot_do: [],
})

/** Validate the one canonical v2 fact. A composite manifest carries exactly one entry
 * diagram so one Context always names one unambiguous runnable system. The existing
 * workflow validator remains the policy authority; this wrapper only adds the typed
 * manifest envelope and the graph-vs-loop invariant. */
export const validateAgentManifest = (value: unknown): AgentManifestCandidate => {
  const base = {
    source: "agent-manifest-v2" as const,
    warnings: [] as string[],
  }
  if (!object(value)) {
    const errors = ["AM-01 agent-manifest must be an object"]
    return { ...base, kind: null, manifest: null, preview: invalidPreview(errors), errors }
  }
  const kind =
    value.kind === "single" || value.kind === "graph" || value.kind === "loop" ? value.kind : null
  const errors: string[] = []
  if (value.schema !== AGENT_MANIFEST_SCHEMA)
    errors.push(`AM-01 schema must be "${AGENT_MANIFEST_SCHEMA}"`)
  if (!kind) errors.push('AM-01 kind must be "single", "graph", or "loop"')
  const purpose = text(value.purpose)
  if (!purpose) errors.push("AM-01 purpose is required")

  if (kind === "single") {
    const instructions = text(value.instructions)
    if (!instructions) errors.push("AM-03 single manifest requires instructions")
    if (value.diagram !== undefined) errors.push("AM-03 single manifest must not carry a diagram")
    const manifest =
      errors.length || !purpose || !instructions
        ? null
        : ({
            schema: AGENT_MANIFEST_SCHEMA,
            kind,
            purpose,
            instructions,
          } satisfies SingleAgentManifest)
    return {
      ...base,
      kind,
      manifest,
      preview: manifest ? null : invalidPreview(errors),
      errors,
    }
  }

  if (kind !== "graph" && kind !== "loop") {
    return { ...base, kind: null, manifest: null, preview: invalidPreview(errors), errors }
  }

  const rawDiagram = value.diagram
  if (!object(rawDiagram)) errors.push(`AM-02 ${kind} manifest requires one diagram`)
  const title = text(value.title) ?? (object(rawDiagram) ? text(rawDiagram.id) : null)
  if (!title) errors.push(`AM-02 ${kind} manifest requires a title`)
  const labels = labelsOf(value.labels)
  const forbidden = Array.isArray(value.forbidden) ? value.forbidden : undefined
  const rawLoops = object(rawDiagram) && Array.isArray(rawDiagram.loops) ? rawDiagram.loops : []
  if (kind === "graph" && rawLoops.length)
    errors.push("AM-04 graph manifest must be acyclic and must not declare loop policies")
  if (kind === "loop" && !rawLoops.length)
    errors.push("AM-04 loop manifest requires at least one bounded loop policy")
  const synthetic = {
    schema: WORKFLOW_DEFINITION_SCHEMA,
    purpose: purpose ?? "",
    diagrams: object(rawDiagram) ? [rawDiagram] : [],
    ...(forbidden ? { forbidden } : {}),
  }
  const checked =
    purpose && title && object(rawDiagram)
      ? validateWorkflowDefinition(
          synthetic,
          linkedProjectionFromRaw(purpose, title, kind, rawDiagram, labels),
        )
      : null
  if (checked) errors.push(...checked.errors)
  const diagram = checked?.definition?.diagrams[0]
  const manifest =
    errors.length || !purpose || !title || !diagram
      ? null
      : ({
          schema: AGENT_MANIFEST_SCHEMA,
          kind,
          purpose,
          title,
          diagram,
          ...(checked?.definition?.forbidden?.length
            ? { forbidden: checked.definition.forbidden }
            : {}),
          labels,
        } satisfies CompositeAgentManifest)
  const preview = manifest
    ? previewWorkflowDefinition(
        {
          schema: WORKFLOW_DEFINITION_SCHEMA,
          purpose: manifest.purpose,
          diagrams: [manifest.diagram],
          ...(manifest.forbidden ? { forbidden: manifest.forbidden } : {}),
        },
        linkedProjection(manifest.purpose, manifest.title, manifest.kind, manifest.diagram, labels),
      )
    : invalidPreview(errors, checked?.warnings ?? [])
  return {
    ...base,
    kind,
    manifest,
    preview,
    errors,
    warnings: checked?.warnings ?? [],
  }
}

const legacyCandidates = (source: string): AgentManifestCandidate[] | null => {
  const checked = workflowDefinitionOf(source)
  if (!checked) return null
  const linked = linkedBundleOf(source)?.manifest ?? null
  if (!checked.definition) {
    if (linked?.diagrams?.length)
      return linked.diagrams.map((diagram) => ({
        source: "workflow-v1",
        kind: diagram.type,
        manifest: null,
        preview: invalidPreview(checked.errors, checked.warnings),
        errors: checked.errors,
        warnings: checked.warnings,
        legacy_diagram_id: diagram.id,
        title: diagram.title,
      }))
    return [
      {
        source: "workflow-v1",
        kind: null,
        manifest: null,
        preview: invalidPreview(checked.errors, checked.warnings),
        errors: checked.errors,
        warnings: checked.warnings,
      },
    ]
  }
  const linkedById = new Map((linked?.diagrams ?? []).map((diagram) => [diagram.id, diagram]))
  return checked.definition.diagrams.map((diagram) => {
    const visible = linkedById.get(diagram.id)
    const kind: "graph" | "loop" = diagram.loops?.length ? "loop" : "graph"
    const labels = Object.fromEntries((visible?.nodes ?? []).map((node) => [node.id, node.label]))
    const title = visible?.title ?? diagram.id
    const manifest: CompositeAgentManifest = {
      schema: AGENT_MANIFEST_SCHEMA,
      kind,
      purpose: checked.definition?.purpose ?? "",
      title,
      diagram,
      ...(checked.definition?.forbidden?.length ? { forbidden: checked.definition.forbidden } : {}),
      labels,
    }
    return {
      source: "workflow-v1",
      kind,
      manifest,
      preview: previewWorkflowDefinition(
        {
          schema: WORKFLOW_DEFINITION_SCHEMA,
          purpose: manifest.purpose,
          diagrams: [diagram],
          ...(manifest.forbidden ? { forbidden: manifest.forbidden } : {}),
        },
        linkedProjection(manifest.purpose, manifest.title, kind, diagram, labels),
      ),
      errors: [],
      warnings: checked.warnings,
      legacy_diagram_id: diagram.id,
      title,
    }
  })
}

/** Read an artifact as one or more normalized agent manifests. Explicit v2 wins;
 * otherwise a workflow-v1 artifact adapts per diagram; every other source is the
 * existing leaf/single context contract. No old artifact bytes are rewritten. */
export const agentManifestsOf = (source: string, contentType = "text/html"): AgentManifestRead => {
  const parsed = parseFacts(source, contentType)
  const row = parsed.facts.find((fact) => fact.slot === AGENT_MANIFEST_FACT)
  if (row) {
    try {
      return { candidates: [validateAgentManifest(JSON.parse(row.json))], errors: [] }
    } catch {
      const errors = ["AM-01 agent-manifest is not valid JSON"]
      return {
        candidates: [
          {
            source: "agent-manifest-v2",
            kind: null,
            manifest: null,
            preview: invalidPreview(errors),
            errors,
            warnings: [],
          },
        ],
        errors,
      }
    }
  }
  const advisory = parsed.advisories.find((item) => item.includes(`Facts "${AGENT_MANIFEST_FACT}"`))
  if (advisory) {
    const error = advisory.includes(`over the ${MAX_FACT_BYTES / 1024}KB limit`)
      ? `AM-01 agent-manifest exceeds ${MAX_FACT_BYTES / 1024}KB fact limit`
      : "AM-01 agent-manifest is not valid JSON"
    return {
      candidates: [
        {
          source: "agent-manifest-v2",
          kind: null,
          manifest: null,
          preview: invalidPreview([error]),
          errors: [error],
          warnings: [],
        },
      ],
      errors: [error],
    }
  }
  const legacy = legacyCandidates(source)
  if (legacy) return { candidates: legacy, errors: [] }
  return {
    candidates: [
      {
        source: "implicit-single",
        kind: "single",
        manifest: {
          schema: AGENT_MANIFEST_SCHEMA,
          kind: "single",
          purpose: null,
          instructions: source,
        },
        preview: null,
        errors: [],
        warnings: [],
      },
    ],
    errors: [],
  }
}

/** Resolve the one candidate a Context names. Legacy multi-diagram artifacts must
 * carry an explicit selector in the context config/import; guessing would make
 * `use(context)` non-deterministic. */
export const agentManifestForContext = (
  source: string,
  contentType = "text/html",
  legacyDiagramId?: string | null,
): AgentManifestCandidate => {
  const read = agentManifestsOf(source, contentType)
  const selected = legacyDiagramId
    ? read.candidates.find((candidate) => candidate.legacy_diagram_id === legacyDiagramId)
    : read.candidates.length === 1
      ? read.candidates[0]
      : null
  if (selected) return selected
  const errors = read.errors.length
    ? read.errors
    : legacyDiagramId
      ? [`AM-02 no legacy diagram "${legacyDiagramId}" exists in this manifest version`]
      : ["AM-02 context manifest contains multiple diagrams and requires an explicit selector"]
  return {
    source: read.candidates[0]?.source ?? "workflow-v1",
    kind: null,
    manifest: null,
    preview: invalidPreview(errors),
    errors,
    warnings: [],
  }
}
