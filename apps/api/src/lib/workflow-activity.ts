import type {
  ArtifactRecord,
  MetaStore,
  VersionDataRecord,
  VersionRecord,
  WorkflowArtifactActivityRecord,
  WorkflowArtifactActivityRole,
  WorkflowRunRecord,
  WorkflowStepAttemptRecord,
} from "@derive/core"
import { parseLinkedWorkflowFacts } from "./workflow-facts"

export interface WorkflowArtifactSuggestion {
  id: string
  nodeId: string | null
  attempt: number | null
  artifactShortId: string
  artifactVersion: number
  artifactTitle: string | null
  role: WorkflowArtifactActivityRole
  source: "suggested"
  reason: string
  createdAt: string
}

type VisibleWorkflowArtifactActivity = WorkflowArtifactActivityRecord & {
  source: Exclude<WorkflowArtifactActivityRecord["source"], "dismissed">
}

const suggestionRole = (role: string | undefined): WorkflowArtifactActivityRole => {
  if (role?.toLowerCase() === "evidence") return "evidence"
  if (role?.toLowerCase() === "input") return "input"
  return "output"
}

interface WorkflowSuggestionRunState {
  run: WorkflowRunRecord
  attempts: WorkflowStepAttemptRecord[]
  recorded: WorkflowArtifactActivityRecord[]
}

interface WorkflowMemberRelationship {
  nodeIds: Set<string>
  role: WorkflowArtifactActivityRole
  pinned: boolean
  current: boolean
}

const workflowRelationships = async (args: {
  meta: MetaStore
  workflowArtifact: ArtifactRecord
  run: WorkflowRunRecord
  loadVersionData?: (version: number) => Promise<VersionDataRecord[]>
}): Promise<Map<string, WorkflowMemberRelationship>> => {
  const { meta, workflowArtifact, run } = args
  const versionNumbers =
    run.workflow_version === workflowArtifact.current_version
      ? [run.workflow_version]
      : [run.workflow_version, workflowArtifact.current_version]
  const factSets = await Promise.all(
    versionNumbers.map((version) =>
      args.loadVersionData
        ? args.loadVersionData(version)
        : meta.getVersionData(workflowArtifact.id, version),
    ),
  )
  const relationships = new Map<string, WorkflowMemberRelationship>()
  for (const [index, rows] of factSets.entries()) {
    const facts = parseLinkedWorkflowFacts(rows)
    const diagram = facts.manifest?.diagrams?.find((item) => item.id === run.diagram_id)
    if (!facts.manifest || !diagram) continue
    const members = new Map(facts.manifest.members.map((member) => [member.id, member]))
    for (const node of diagram.nodes) {
      const member = node.member ? members.get(node.member) : undefined
      if (!member) continue
      const existing = relationships.get(member.ref)
      if (existing) {
        existing.nodeIds.add(node.id)
        existing.pinned ||= index === 0
        existing.current ||= index > 0
      } else {
        relationships.set(member.ref, {
          nodeIds: new Set([node.id]),
          role: suggestionRole(member.role),
          pinned: index === 0,
          current: index > 0,
        })
      }
    }
  }
  return relationships
}

const suggestionsForRun = (args: {
  state: WorkflowSuggestionRunState
  relationships: Map<string, WorkflowMemberRelationship>
  membersById: Map<string, ArtifactRecord>
  versions: VersionRecord[]
}): WorkflowArtifactSuggestion[] => {
  const { run, attempts, recorded } = args.state
  const recordedVersions = new Set(
    recorded.map(
      (item) => `${item.node_id}\0${item.artifact_short_id}@${item.artifact_version}\0${item.role}`,
    ),
  )
  const started = Date.parse(run.created_at)
  const finished = run.finished_at ? Date.parse(run.finished_at) : Number.POSITIVE_INFINITY
  return args.versions
    .flatMap((version) => {
      const member = args.membersById.get(version.artifact_id)
      if (!member) return []
      const relationship = args.relationships.get(member.short_id)
      const createdAt = version.created_at
      const created = Date.parse(createdAt)
      if (!relationship || created < started || created > finished) return []
      return [...relationship.nodeIds].flatMap((nodeId) => {
        if (
          recordedVersions.has(`${nodeId}\0${member.short_id}@${version.n}\0${relationship.role}`)
        )
          return []
        const matchingAttempts = attempts.filter((attempt) => {
          if (attempt.node_id !== nodeId) return false
          const attemptStarted = Date.parse(attempt.created_at)
          const attemptFinished = attempt.finished_at
            ? Date.parse(attempt.finished_at)
            : Number.POSITIVE_INFINITY
          return created >= attemptStarted && created <= attemptFinished
        })
        const attempt =
          matchingAttempts.length === 1 ? (matchingAttempts[0]?.attempt ?? null) : null
        return [
          {
            id: `suggested_${run.id}_${nodeId}_${member.short_id}_${version.n}`,
            nodeId,
            attempt,
            artifactShortId: member.short_id,
            artifactVersion: version.n,
            artifactTitle: member.title,
            role: relationship.role,
            source: "suggested" as const,
            reason: relationship.pinned
              ? "A pinned graph member gained this version while the run was open."
              : "The current graph links this version, and it was published while the run was open.",
            createdAt,
          },
        ]
      })
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 20)
}

/** Find exact member versions that appeared while runs were open. These are candidates only.
 * Shared artifact, version, fact, and authorization reads stay batched across run history. */
export const workflowActivitySuggestionsForRuns = async (args: {
  meta: MetaStore
  workflowArtifact: ArtifactRecord
  states: WorkflowSuggestionRunState[]
  canRead: (artifact: ArtifactRecord) => Promise<boolean>
  loadVersionData?: (version: number) => Promise<VersionDataRecord[]>
}): Promise<Map<string, WorkflowArtifactSuggestion[]>> => {
  if (args.states.length === 0) return new Map()
  const relationships = await Promise.all(
    args.states.map((state) =>
      workflowRelationships({
        meta: args.meta,
        workflowArtifact: args.workflowArtifact,
        run: state.run,
        loadVersionData: args.loadVersionData,
      }),
    ),
  )
  const memberRefs = [...new Set(relationships.flatMap((items) => [...items.keys()]))]
  const memberArtifacts = await args.meta.getByShortIds(memberRefs)
  const readable = await Promise.all(
    memberArtifacts.map(async (member) => ({ member, allowed: await args.canRead(member) })),
  )
  const readableMembers = readable
    .filter(({ member, allowed }) => allowed && member.id !== args.workflowArtifact.id)
    .map(({ member }) => member)
  const createdFrom = args.states
    .map(({ run }) => run.created_at)
    .sort((left, right) => left.localeCompare(right))[0]
  const finished = args.states.map(({ run }) => run.finished_at)
  const createdTo = finished.every((value): value is string => Boolean(value))
    ? [...finished].sort((left, right) => right.localeCompare(left))[0]
    : undefined
  const versions = await args.meta.versionsForArtifacts(
    readableMembers.map((member) => member.id),
    {
      createdFrom,
      createdTo,
      limit: Math.min(1_000, Math.max(100, args.states.length * 100)),
    },
  )
  const membersById = new Map(readableMembers.map((member) => [member.id, member]))
  return new Map(
    args.states.map((state, index) => [
      state.run.id,
      suggestionsForRun({
        state,
        relationships: relationships[index] ?? new Map(),
        membersById,
        versions,
      }),
    ]),
  )
}

export const workflowActivitySuggestions = async (args: {
  meta: MetaStore
  workflowArtifact: ArtifactRecord
  run: WorkflowRunRecord
  attempts: WorkflowStepAttemptRecord[]
  recorded: WorkflowArtifactActivityRecord[]
  canRead: (artifact: ArtifactRecord) => Promise<boolean>
  loadVersionData?: (version: number) => Promise<VersionDataRecord[]>
}): Promise<WorkflowArtifactSuggestion[]> => {
  const suggestions = await workflowActivitySuggestionsForRuns({
    meta: args.meta,
    workflowArtifact: args.workflowArtifact,
    states: [{ run: args.run, attempts: args.attempts, recorded: args.recorded }],
    canRead: args.canRead,
    loadVersionData: args.loadVersionData,
  })
  return suggestions.get(args.run.id) ?? []
}

export const readableWorkflowActivity = async (args: {
  meta: MetaStore
  rows: WorkflowArtifactActivityRecord[]
  canRead: (artifact: ArtifactRecord) => Promise<boolean>
}): Promise<VisibleWorkflowArtifactActivity[]> => {
  const visibleRows = args.rows.filter((item) => item.source !== "dismissed")
  const artifacts = await args.meta.getByShortIds([
    ...new Set(visibleRows.map((item) => item.artifact_short_id)),
  ])
  const allowed = new Set(
    (
      await Promise.all(
        artifacts.map(async (artifact) => ({
          shortId: artifact.short_id,
          allowed: await args.canRead(artifact),
        })),
      )
    )
      .filter((item) => item.allowed)
      .map((item) => item.shortId),
  )
  return visibleRows.filter((item) =>
    allowed.has(item.artifact_short_id),
  ) as VisibleWorkflowArtifactActivity[]
}

export const loadWorkflowRunArtifactState = async (args: {
  meta: MetaStore
  workflowArtifact: ArtifactRecord
  run: WorkflowRunRecord
  canRead: (artifact: ArtifactRecord) => Promise<boolean>
}): Promise<{
  attempts: WorkflowStepAttemptRecord[]
  activity: VisibleWorkflowArtifactActivity[]
  suggestions: WorkflowArtifactSuggestion[]
}> => {
  const readable = new Map<string, Promise<boolean>>()
  const canRead = (artifact: ArtifactRecord): Promise<boolean> => {
    const existing = readable.get(artifact.id)
    if (existing) return existing
    const result = args.canRead(artifact)
    readable.set(artifact.id, result)
    return result
  }
  const [attempts, recorded] = await Promise.all([
    args.meta.listWorkflowStepAttempts(args.run.id, args.run.org_id),
    args.meta.listWorkflowArtifactActivity(args.run.id, args.run.org_id),
  ])
  const [activity, suggestions] = await Promise.all([
    readableWorkflowActivity({ meta: args.meta, rows: recorded, canRead }),
    workflowActivitySuggestions({
      meta: args.meta,
      workflowArtifact: args.workflowArtifact,
      run: args.run,
      attempts,
      recorded,
      canRead,
    }),
  ])
  return { attempts, activity, suggestions }
}
