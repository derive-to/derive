import { describe, expect, it } from "vitest"
import type { WorkflowRunSummary } from "@/api"
import { workflowTriggerLabel } from "./workflow-preview"
import { workflowAttemptRoute } from "./workflow-run-history"

describe("workflow Preview", () => {
  it("explains context triggers in plain run language", () => {
    expect(workflowTriggerLabel("explicit run")).toBe("Starts when you run this workflow")
    expect(workflowTriggerLabel("Research completes")).toBe("After Research completes")
    expect(workflowTriggerLabel("Quality check returns ready")).toBe(
      "When Quality check returns ready",
    )
  })

  it("describes only routes recorded in a durable step receipt", () => {
    const attempt: WorkflowRunSummary["attempts"][number] = {
      id: "wsa_review",
      nodeId: "review",
      attempt: 1,
      kind: "human",
      status: "succeeded",
      selectedRoutes: ["publish"],
      routeBasis: "The reviewer approved the draft.",
      resultArtifactId: null,
      createdAt: "2026-08-26T18:00:00.000Z",
      startedAt: "2026-08-26T18:00:00.000Z",
      finishedAt: "2026-08-26T18:01:00.000Z",
    }

    expect(workflowAttemptRoute(attempt)).toBe("Next: publish")
    expect(workflowAttemptRoute({ ...attempt, selectedRoutes: [] })).toBe("No next node selected")
    expect(workflowAttemptRoute({ ...attempt, selectedRoutes: null })).toBeNull()
    expect(
      workflowAttemptRoute({
        ...attempt,
        status: "running",
        selectedRoutes: [],
        finishedAt: null,
      }),
    ).toBeNull()
  })
})
