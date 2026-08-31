import { describe, expect, it } from "vitest"
import type { Automation, Run, WorkflowRunSummary } from "@/api"
import { runStatusTone } from "@/components/shared/run-receipt"
import { workflowRunSummary } from "@/pages/artifact/workflow-run-presentation"
import { automationRunTrigger, presentAutomationRun } from "./run-presentation"

const automation: Automation = {
  id: "aut_docs",
  agent_id: "agt_writer",
  provider: "codex",
  context_id: null,
  trigger: { kind: "event", on: "webhook" },
  instruction: "Keep internal docs aligned with code changes",
  refs: [{ kind: "artifact", id: "engineering-docs" }],
  connection_ids: [],
  enabled: true,
  created_at: "2026-08-27T12:00:00.000Z",
}

const run: Run = {
  id: "run_docs",
  automation_id: automation.id,
  agent_id: automation.agent_id,
  reason: "fire",
  status: "succeeded",
  cost_micro_usd: null,
  meta: JSON.stringify({
    outcome: "published",
    execution: { provider: "codex", location: "hosted" },
    writes: [
      { short_id: "api-guide", created: false },
      { short_id: "release-notes", created: false },
    ],
  }),
  created_at: "2026-08-27T12:00:00.000Z",
  finished_at: "2026-08-27T12:02:00.000Z",
  timeline: {
    phase: "succeeded",
    waiting_until: null,
    queued_ms: 1_000,
    ran_ms: 120_000,
    retries: 0,
    last_error: null,
    outcome: "published",
    writes: [],
  },
}

describe("run presentation", () => {
  it("explains a standing Agent run without exposing its internal reason value", () => {
    expect(presentAutomationRun(run, automation)).toEqual({
      title: "Keep internal docs aligned with code changes",
      summary: "The Agent wrote 2 Artifacts.",
      facts: ["Started by webhook", "Hosted · Codex", "Ran for 2m"],
    })
    expect(automationRunTrigger("manual:user_123")).toBe("Started manually")
  })

  it("names the exact human pause in a coordinated run", () => {
    const coordinated: WorkflowRunSummary = {
      id: "wfr_release",
      diagramId: "release",
      workflowVersion: 4,
      status: "waiting",
      reason: "agent-request",
      requestedExecution: "local",
      actualExecution: "local",
      createdAt: "2026-08-27T12:00:00.000Z",
      startedAt: "2026-08-27T12:01:00.000Z",
      finishedAt: null,
      attempts: [
        {
          id: "wfsa_approve",
          nodeId: "approve-release",
          attempt: 1,
          kind: "human",
          status: "waiting",
          selectedRoutes: null,
          routeBasis: null,
          resultArtifactId: null,
          error: null,
          createdAt: "2026-08-27T12:01:00.000Z",
          startedAt: "2026-08-27T12:01:00.000Z",
          finishedAt: null,
        },
      ],
    }
    expect(workflowRunSummary(coordinated)).toBe("Waiting for a person at approve-release.")
  })

  it("treats cancellation as a neutral stop, not a failure", () => {
    expect(runStatusTone("cancelled")).toBe("muted")
    expect(runStatusTone("failed")).toBe("error")
  })

  it("shows an exact, safe GitHub Actions run receipt", () => {
    const githubAutomation: Automation = {
      ...automation,
      trigger: {
        kind: "manual",
        action: {
          kind: "github_workflow",
          owner: "Niftory",
          repo: "sift",
          workflow: "derive-docs-refresh.yml",
          ref: "main",
        },
      },
      instruction: "Run Niftory/sift · derive-docs-refresh.yml",
    }
    const githubRun: Run = {
      ...run,
      meta: JSON.stringify({
        outcome: "dispatched",
        action: githubAutomation.trigger.action,
        github_action: {
          run_id: "7788",
          url: "https://malicious.example/ignored",
        },
      }),
    }
    expect(presentAutomationRun(githubRun, githubAutomation)).toEqual({
      title: "Run Niftory/sift · derive-docs-refresh.yml",
      summary: "GitHub started derive-docs-refresh.yml as run #7788.", // tokens-ignore
      facts: ["Started by webhook", "Niftory/sift · main", "Ran for 2m"],
    })
  })
})
