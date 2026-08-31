import { describe, expect, it } from "vitest"
import type { Automation, Run, WorkflowRunSummary } from "@/api"
import { runStatusTone } from "@/components/shared/run-receipt"
import {
  workflowGithubReceipt,
  workflowGithubStarterAdapter,
} from "@/pages/artifact/workflow-github-presentation"
import {
  workflowDeliveryLabel,
  workflowRunSummary,
} from "@/pages/artifact/workflow-run-presentation"
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

const githubWorkflowRun = (externalExecution: unknown, status = "dispatched"): WorkflowRunSummary =>
  ({
    id: "wfr_github",
    diagramId: "release",
    workflowVersion: 7,
    status,
    reason: "manual:github",
    requestedExecution: "github_actions",
    actualExecution: status === "dispatched" ? null : "github_actions",
    externalExecution,
    createdAt: "2026-08-31T12:00:00.000Z",
    startedAt: status === "dispatched" ? null : "2026-08-31T12:00:04.000Z",
    finishedAt: null,
    attempts: [],
  }) as unknown as WorkflowRunSummary

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
    expect(runStatusTone("timed_out")).toBe("error")
  })

  it("keeps GitHub dispatch separate from downstream graph success", () => {
    const coordinated = githubWorkflowRun({
      kind: "github_actions",
      owner: "Niftory",
      repo: "sift",
      workflow: "derive-graph-runner.yml",
      ref: "main",
      github_run_id: "998877",
      github_run_url: "https://malicious.example/ignored",
    })

    expect(workflowRunSummary(coordinated)).toBe(
      "GitHub run #998877 was dispatched; waiting for its OIDC-authenticated job.", // tokens-ignore
    )
    expect(workflowDeliveryLabel(coordinated)).toBe("GitHub Actions · Codex")
    expect(workflowGithubReceipt(coordinated)?.runUrl).toBe(
      "https://github.com/Niftory/sift/actions/runs/998877", // tokens-ignore
    )
  })

  it("renders a no-prompt OIDC adapter with repository-pinned CLIs", () => {
    const codex = workflowGithubStarterAdapter()
    expect(codex).toContain("id-token: write")
    expect(codex).toContain("DERIVE_EXCHANGE_NONCE")
    expect(codex).toMatch(/OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/)
    expect(codex).not.toContain("DERIVE_TOKEN")
    expect(codex).not.toContain("prompt:")
    expect(codex).toContain("@derive-to/cli@0.6.0")
    expect(codex).toContain("@openai/codex@0.151.0")
    expect(codex).not.toContain("@latest")
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
