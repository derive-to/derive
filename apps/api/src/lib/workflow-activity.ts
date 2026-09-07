import type {
  ArtifactRecord,
  MetaStore,
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

const suggestionRole = (role: string | undefined): WorkflowArtifactActivityRole => {
  if (role?.toLowerCase() === "evidence") return "evidence"
  if (role?.toLowerCase() === "input") return "input"
  return "output"
}

/** Find exact member versions that appeared while a run was open. These are
 * candidates only. A graph relationship and overlapping time do not prove causality. */
export const workflowActivitySuggestions = async (args: {
  meta: MetaStore
  workflowArtifact: ArtifactRecord
  run: WorkflowRunRecord
  attempts: WorkflowStepAttemptRecord[]
  recorded: WorkflowArtifactActivityRecord[]
  canRead: (artifact: ArtifactRecord) => Promise<boolean>
}): Promise<WorkflowArtifactSuggestion[]> => {
  const { meta, workflowArtifact, run, attempts, recorded, canRead } = args
  const versionNumbers =
    run.workflow_version === workflowArtifact.current_version
      ? [run.workflow_version]
      : [run.workflow_version, workflowArtifact.current_version]
  const factSets = await Promise.all(
    versionNumbers.map((version) => meta.getVersionData(workflowArtifact.id, version)),
  )
  const relationships = new Map<
    string,
    {
      nodeIds: Set<string>
      role: WorkflowArtifactActivityRole
      pinned: boolean
      current: boolean
    }
  >()
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
  const memberArtifacts = await meta.getByShortIds([...relationships.keys()])
  const readable = await Promise.all(
    memberArtifacts.map(async (member) => ({ member, allowed: await canRead(member) })),
  )
  const readableMembers = readable.filter(({ member, allowed }) =>
    Boolean(allowed && member.id !== workflowArtifact.id),
  )
  const versions = await meta.versionsForArtifacts(
    readableMembers.map(({ member }) => member.id),
    { createdFrom: run.created_at, createdTo: run.finished_at ?? undefined, limit: 100 },
  )
  const membersById = new Map(readableMembers.map(({ member }) => [member.id, member]))
  const recordedVersions = new Set(
    recorded.map((item) => `${item.artifact_short_id}@${item.artifact_version}`),
  )
  const started = Date.parse(run.created_at)
  const finished = run.finished_at ? Date.parse(run.finished_at) : Number.POSITIVE_INFINITY
  return versions
    .flatMap((version) => {
      const member = membersById.get(version.artifact_id)
      if (!member) return []
      const relationship = relationships.get(member.short_id)
      const createdAt = version.created_at
      const created = Date.parse(createdAt)
      if (!relationship || created < started || created > finished) return []
      if (recordedVersions.has(`${member.short_id}@${version.n}`)) return []
      const nodeIds = [...relationship.nodeIds]
      const nodeId = nodeIds.length === 1 ? (nodeIds[0] ?? null) : null
      const matchingAttempts = nodeId
        ? attempts.filter((attempt) => {
            if (attempt.node_id !== nodeId) return false
            const attemptStarted = Date.parse(attempt.created_at)
            const attemptFinished = attempt.finished_at
              ? Date.parse(attempt.finished_at)
              : Number.POSITIVE_INFINITY
            return created >= attemptStarted && created <= attemptFinished
          })
        : []
      const attempt = matchingAttempts.length === 1 ? (matchingAttempts[0]?.attempt ?? null) : null
      return [
        {
          id: `suggested_${run.id}_${member.short_id}_${version.n}`,
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
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 20)
}

export const readableWorkflowActivity = async (args: {
  meta: MetaStore
  rows: WorkflowArtifactActivityRecord[]
  canRead: (artifact: ArtifactRecord) => Promise<boolean>
}): Promise<WorkflowArtifactActivityRecord[]> => {
  const artifacts = await args.meta.getByShortIds([
    ...new Set(args.rows.map((item) => item.artifact_short_id)),
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
  return args.rows.filter((item) => allowed.has(item.artifact_short_id))
}

export const loadWorkflowRunArtifactState = async (args: {
  meta: MetaStore
  workflowArtifact: ArtifactRecord
  run: WorkflowRunRecord
  canRead: (artifact: ArtifactRecord) => Promise<boolean>
}): Promise<{
  attempts: WorkflowStepAttemptRecord[]
  activity: WorkflowArtifactActivityRecord[]
  suggestions: WorkflowArtifactSuggestion[]
}> => {
  const [attempts, recorded] = await Promise.all([
    args.meta.listWorkflowStepAttempts(args.run.id, args.run.org_id),
    args.meta.listWorkflowArtifactActivity(args.run.id, args.run.org_id),
  ])
  const [activity, suggestions] = await Promise.all([
    readableWorkflowActivity({ meta: args.meta, rows: recorded, canRead: args.canRead }),
    workflowActivitySuggestions({
      meta: args.meta,
      workflowArtifact: args.workflowArtifact,
      run: args.run,
      attempts,
      recorded,
      canRead: args.canRead,
    }),
  ])
  return { attempts, activity, suggestions }
}
