import { describe, expect, it } from "vitest"
import type { WorkflowDirectoryItem } from "@/api"
import { visibleWorkflows } from "./index"
import { workflowBuilderPrompt } from "./workflow-builder-dialog"

const workflow = (
  shortId: string,
  status: WorkflowDirectoryItem["status"],
  updatedAt: string,
): WorkflowDirectoryItem => ({
  shortId,
  title: shortId,
  version: 1,
  updatedAt,
  purpose: null,
  status,
  diagrams: [],
})

describe("workflow browser", () => {
  const ready = workflow("ready", "ready", "2026-08-30T10:00:00.000Z")
  const blocked = workflow("blocked", "needs-changes", "2026-08-30T11:00:00.000Z")

  it("sorts newest first and filters without dropping the blocked definition", () => {
    expect(visibleWorkflows([ready, blocked], "all").map((item) => item.shortId)).toEqual([
      "blocked",
      "ready",
    ])
    expect(visibleWorkflows([ready, blocked], "needs-changes")).toEqual([blocked])
  })
})

describe("workflow builder handoff", () => {
  it("builds a bounded draft request and never starts the workflow", () => {
    const prompt = workflowBuilderPrompt({
      outcome: "  Verify a pull request and publish the evidence.  ",
      shape: "loop",
      maxAttempts: 3,
      testOnly: true,
      gateExternalEffects: true,
      finalReview: false,
    })
    expect(prompt).toContain("Outcome: Verify a pull request and publish the evidence.")
    expect(prompt).toContain("Stop after at most 3 attempts.")
    expect(prompt).toContain("Do not run it yet.")
  })
})
