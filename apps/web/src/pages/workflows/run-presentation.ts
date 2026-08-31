import type { Automation, Run } from "@/api"
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
  } else if (writes.length > 0) {
    summary = `The Agent wrote ${countLabel(writes.length, "Artifact")}.`
  } else if (outcome) {
    summary = `The Agent finished: ${runOutcomeLabel(outcome)}.`
  } else {
    summary = "The Agent finished without an Artifact write."
  }

  return {
    title:
      automation?.instruction ??
      (run.automation_id ? "Removed automated workflow" : "One-time Agent run"),
    summary,
    facts,
  }
}
