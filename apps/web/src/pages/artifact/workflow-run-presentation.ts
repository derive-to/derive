import type { WorkflowRunSummary } from "@/api"
import { workflowGithubReceipt } from "./workflow-github-presentation"

type WorkflowAttempt = WorkflowRunSummary["attempts"][number]

const countLabel = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? "" : "s"}`

export const compactWorkflowReceiptText = (value: string, maxLength = 1_000): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value

export const workflowAttemptRoute = (attempt: WorkflowAttempt): string | null => {
  if (attempt.selectedRoutes === null) return null
  if (attempt.selectedRoutes.length > 0) return `Next: ${attempt.selectedRoutes.join(", ")}`
  if (attempt.status === "succeeded" && attempt.finishedAt) return "No next step selected"
  return null
}

const latestAttempt = (run: WorkflowRunSummary): WorkflowAttempt | undefined => run.attempts.at(-1)

const latestAttemptError = (attempts: readonly WorkflowAttempt[]): string | null => {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const error = attempts[index]?.error
    if (error) return error
  }
  return null
}

export const workflowRunSummary = (run: WorkflowRunSummary): string => {
  const status: string = run.status
  const github = workflowGithubReceipt(run)
  const waiting = run.attempts.filter((attempt) => attempt.status === "waiting")
  const humanPause = waiting.find((attempt) => attempt.kind === "human")
  if (humanPause) return `Waiting for a person at ${humanPause.nodeId}.`
  if (waiting.length > 0)
    return waiting.length === 1
      ? `${waiting[0]?.nodeId ?? "A step"} is waiting.`
      : `${waiting.length} steps are waiting.`
  const active = run.attempts.filter((attempt) => attempt.status === "running")
  if (active.length > 0)
    return active.length === 1
      ? `${active[0]?.nodeId ?? "A step"} is running.`
      : `${active.length} steps are running.`
  if (status === "queued") return "Waiting for an Agent to claim this run."
  if (status === "dispatched" && github)
    return github.runId
      ? `GitHub run #${github.runId} was dispatched; waiting for its OIDC-authenticated job.`
      : "GitHub accepted the dispatch; waiting for its OIDC-authenticated job."
  if (status === "running" && run.attempts.length === 0 && github)
    return github.runId
      ? `GitHub run #${github.runId} authenticated; no Context step has started yet.`
      : "The GitHub job authenticated; no Context step has started yet."
  if (status === "running" && run.attempts.length === 0)
    return "The Agent claimed this run; no step has started yet."
  const last = latestAttempt(run)
  const lastError = latestAttemptError(run.attempts)
  if (status === "failed")
    return (
      (github?.error ? compactWorkflowReceiptText(github.error, 240) : null) ??
      (lastError ? compactWorkflowReceiptText(lastError, 240) : null) ??
      (last ? `The run stopped at ${last.nodeId}.` : "The run stopped after a failure.")
    )
  if (status === "cancelled")
    return last ? `The run was cancelled at ${last.nodeId}.` : "The run was cancelled."
  if (status === "timed_out")
    return last ? `The GitHub job timed out at ${last.nodeId}.` : "The GitHub job timed out."
  if (status === "succeeded")
    return last ? `The workflow completed at ${last.nodeId}.` : "The workflow completed."
  return `${countLabel(run.attempts.length, "step")} recorded.`
}

export const workflowDeliveryLabel = (run: WorkflowRunSummary): string => {
  const github = workflowGithubReceipt(run)
  if (github) return "GitHub Actions"
  const actualExecution: string | null = run.actualExecution
  if (actualExecution)
    return `${
      actualExecution === "hosted"
        ? "Hosted"
        : actualExecution === "github_actions"
          ? "GitHub Actions"
          : "Local"
    } execution`
  if (run.reason === "agent-request") return "Assigned Agent"
  if (run.reason === "manual:copy") return "Local copy"
  return `${run.requestedExecution} execution`
}
