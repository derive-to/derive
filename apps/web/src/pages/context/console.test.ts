import { describe, expect, it } from "vitest"
import type { Session } from "@/api"
import { contextNowSummary } from "./console"

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
