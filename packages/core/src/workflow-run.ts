// The old workflow-run ledger's row types. Graphs now run as jobs (see agent-model.ts); these
// stay only because the workflow_run and workflow_step_attempt tables do, until they are dropped.
const WORKFLOW_RUN_STATUSES = [
  "queued",
  "dispatched",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const

export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number]

const WORKFLOW_STEP_ATTEMPT_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const

export type WorkflowStepAttemptStatus = (typeof WORKFLOW_STEP_ATTEMPT_STATUSES)[number]

export type WorkflowStepKind = "context" | "human" | "terminal"

export type WorkflowRequestedExecution = "any" | "local" | "hosted" | "github_actions"
export type WorkflowExecutionLane = Exclude<WorkflowRequestedExecution, "any">
