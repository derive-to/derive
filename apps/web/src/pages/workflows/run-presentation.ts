import type { Automation, Run } from "@/api"
import { runtimeReport } from "@/lib/runtime-report"
import {
  githubActionRunReceipt,
  runExecutionReceipt,
  runOutcome,
  runOutcomeLabel,
  runWrites,
} from "./automation-format"

const countLabel = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? "" : "s"}`

const compactText = (value: string, maxLength = 240): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value

export const formatRunDuration = (milliseconds: number | null): string | null => {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return null
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

export const automationRunTrigger = (reason: string): string => {
  if (reason.startsWith("manual:")) return "Started manually"
  if (reason === "schedule") return "Started on schedule"
  if (reason === "fire") return "Started by webhook"
  if (reason === "local") return "Recorded from a local run"
  if (reason.startsWith("event:")) return `Started by ${reason.slice("event:".length)}`
  return `Started by ${reason}`
}

export interface AutomationRunPresentation {
  title: string
  summary: string
  facts: string[]
}

export const presentAutomationRun = (
  run: Run,
  automation: Automation | undefined,
): AutomationRunPresentation => {
  const cloud = runtimeReport(run.meta)
  const writes = runWrites(run.meta)
  const outcome = runOutcome(run.meta)
  const receipt = runExecutionReceipt(run.meta)
  const githubReceipt = githubActionRunReceipt(run.meta)
  const duration = formatRunDuration(run.timeline?.ran_ms ?? null)
  const facts = [automationRunTrigger(run.reason)]
  const isGithubWorkflow = automation?.trigger.action?.kind === "github_workflow"
  if (isGithubWorkflow)
    facts.push(
      githubReceipt ? `${githubReceipt.repository} · ${githubReceipt.ref}` : "GitHub Actions",
    )
  if (receipt)
    facts.push(
      `${receipt.location === "hosted" ? "Hosted" : "Local"} · ${receipt.provider === "codex" ? "Codex" : "Claude Code"}`,
    )
  if (duration) facts.push(`Ran for ${duration}`)

  let summary: string
  if (run.status === "queued") {
    const waitingUntil = run.timeline?.waiting_until
    summary =
      waitingUntil && Date.parse(waitingUntil) > Date.now()
        ? "Waiting for its scheduled time."
        : "Waiting for an executor to claim it."
  } else if (run.status === "running") {
    summary = "The Agent is working on this run."
  } else if (run.status === "failed") {
    summary = run.timeline?.last_error
      ? compactText(run.timeline.last_error)
      : "The Agent stopped after a failure."
  } else if (isGithubWorkflow && outcome === "dispatched") {
    summary = githubReceipt
      ? `GitHub started ${githubReceipt.workflow} as run #${githubReceipt.runId}.`
      : "GitHub accepted the workflow dispatch."
  } else if (cloud) {
    summary = cloud.report_short_id
      ? "Report ready."
      : "Run finished. No report is available to you here."
    if (cloud.save_status === "saved") facts.push("Files saved")
    if (cloud.released_at) facts.push("Workspace stopped")
  } else if (writes.length > 0) {
    summary = `The Agent wrote ${countLabel(writes.length, "Artifact")}.`
  } else if (outcome) {
    summary = `The Agent finished: ${runOutcomeLabel(outcome)}.`
  } else {
    summary = "Run finished. No published output was recorded."
  }

  return {
    title:
      run.workflow_name ??
      automation?.instruction ??
      (run.automation_id ? "Workflow unavailable" : "One-time Agent run"),
    summary,
    facts,
  }
}
