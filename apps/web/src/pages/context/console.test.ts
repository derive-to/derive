import { describe, expect, it } from "vitest"
import type { Session } from "@/api"
import { contextNowSummary, localRunSnippet } from "./console"
import { contextWorkflowNodeNote } from "./workflow-definition"

const session = (id: string, state: Session["state"]): Session => ({
  id,
  context_id: "ctx",
  asker_id: "user",
  context_version: 3,
  state,
  created_at: "2026-08-22T12:00:00.000Z",
  updated_at: "2026-08-22T12:00:00.000Z",
  subject: null,
  result_artifact_id: null,
})

describe("context now summary", () => {
  it("prioritizes explicit review requests without hiding other live state", () => {
    expect(
      contextNowSummary([
        session("working", "working"),
        session("waiting", "open"),
        session("review", "escalated"),
        session("failed", "failed"),
      ]),
    ).toEqual({
      working: 1,
      waiting: 1,
      needsReview: 1,
      failed: 1,
      headline: "1 run needs your review.",
    })
  })

  it("stays quiet when no work needs attention", () => {
    expect(contextNowSummary([session("answered", "answered")])).toEqual({
      working: 0,
      waiting: 0,
      needsReview: 0,
      failed: 0,
      headline: "Ready for a new question.",
    })
  })
})

describe("context workflow definition notes", () => {
  it("explains a context node in terms of the exact call and instruction", () => {
    expect(
      contextWorkflowNodeNote({
        id: "build",
        kind: "context",
        context_ref: "writer",
        instruction: "Draft the cited brief.",
        result: "A cited brief",
      }),
    ).toBe("Calls writer. Draft the cited brief.")
  })

  it("explains what a human node waits for and how it resumes", () => {
    expect(
      contextWorkflowNodeNote({
        id: "approve",
        kind: "human",
        decision: "Ship this?",
        options: ["ship", "stop"],
        resume: "Choose ship or stop.",
      }),
    ).toBe("Ship this? Resume with Choose ship or stop.")
  })
})

describe("local composite run call", () => {
  it("escapes the context name into a copyable MCP call", () => {
    expect(localRunSnippet('Writer "review" graph')).toBe(
      'use({\n  context: "Writer \\"review\\" graph",\n  instruction: "Describe the outcome you want"\n})',
    )
  })
})
