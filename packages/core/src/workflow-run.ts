const WORKFLOW_RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const

export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number]

export type WorkflowStepAttemptStatus = WorkflowRunStatus

export type WorkflowStepKind = "context" | "human" | "terminal"

export type WorkflowRequestedExecution = "any" | "local" | "hosted"
export type WorkflowExecutionLane = Exclude<WorkflowRequestedExecution, "any">

export interface WorkflowTransitionGuard {
  status: WorkflowRunStatus
  stateRevision: number
}

const runTransitions: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["waiting", "succeeded", "failed", "cancelled"],
  waiting: ["running", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
}

const stepTransitions: Record<WorkflowStepAttemptStatus, readonly WorkflowStepAttemptStatus[]> = {
  queued: ["running", "waiting", "failed", "cancelled"],
  running: ["waiting", "succeeded", "failed", "cancelled"],
  waiting: ["running", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
}

export const workflowRunCanTransition = (from: WorkflowRunStatus, to: WorkflowRunStatus): boolean =>
  runTransitions[from].includes(to)

export const workflowStepCanTransition = (
  from: WorkflowStepAttemptStatus,
  to: WorkflowStepAttemptStatus,
): boolean => stepTransitions[from].includes(to)

export const workflowStatusIsTerminal = (status: WorkflowRunStatus): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled"

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0

interface WorkflowDefinitionPin {
  workflow_artifact_id: string
  workflow_version: number
  workflow_blob_key: string
  workflow_content_type: string
  diagram_id: string
}

export const isValidWorkflowRunDefinitionPin = (run: WorkflowDefinitionPin): boolean =>
  isNonEmptyString(run.workflow_artifact_id) &&
  isPositiveInteger(run.workflow_version) &&
  isNonEmptyString(run.workflow_blob_key) &&
  isNonEmptyString(run.workflow_content_type) &&
  isNonEmptyString(run.diagram_id)

interface WorkflowStepContextPin {
  kind: WorkflowStepKind
  context_id?: string | null
  context_manifest_artifact_id?: string | null
  context_version?: number | null
  context_blob_key?: string | null
  context_content_type?: string | null
  session_id?: string | null
}

export const isValidWorkflowStepContextPin = (step: WorkflowStepContextPin): boolean => {
  const contextFields = [
    step.context_id,
    step.context_manifest_artifact_id,
    step.context_blob_key,
    step.context_content_type,
  ]
  if (step.kind === "context") {
    return (
      contextFields.every(isNonEmptyString) &&
      isPositiveInteger(step.context_version) &&
      (step.session_id == null || isNonEmptyString(step.session_id))
    )
  }
  return (
    contextFields.every((value) => value == null) &&
    step.context_version == null &&
    step.session_id == null
  )
}
