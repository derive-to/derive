import { describe, expect, it } from "vitest"
import type { Comment } from "@/api"
import {
  linkedBundleCommentCounts,
  linkedBundleMemberDetail,
  linkedBundleReviewTarget,
} from "./linked-bundle-panel"

const comment = (overrides: Partial<Comment>): Comment =>
  ({
    id: "thread-1",
    thread_id: "thread-1",
    base_version: 1,
    path: null,
    anchor: null,
    body_md: "Review this",
    author: "Reviewer",
    author_id: "user-1",
    state: "open",
    anchored: true,
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: null,
    deleted: false,
    reactions: {},
    mentions: [],
    ...overrides,
  }) as Comment

describe("linked bundle review map", () => {
  it("keeps the current artifact version visible during a loop", () => {
    expect(
      linkedBundleMemberDetail({
        id: "brief",
        ref: "brief123",
        label: "Decision brief",
        role: "working output",
        available: true,
        current_version: 4,
        open_comment_count: 2,
      }),
    ).toBe("working output · v4 · 2 open")
    expect(
      linkedBundleMemberDetail({
        id: "missing",
        ref: "missing1",
        label: "Missing evidence",
        available: false,
      }),
    ).toBe("Unavailable")
  })

  it("uses the stable review target convention rendered into the artifact", () => {
    expect(linkedBundleReviewTarget("improve", "node", "revise")).toBe("derive-improve-node-revise")
    expect(linkedBundleReviewTarget("improve", "edge", "0-revise-check")).toBe(
      "derive-improve-edge-0-revise-check",
    )
  })

  it("counts one open discussion per semantic target", () => {
    const id = linkedBundleReviewTarget("improve", "node", "revise")
    const anchor = JSON.stringify({
      type: "ElementSelector",
      tag: "div",
      role: "loop-step",
      id,
      fingerprint: "abc",
      ordinal: 0,
      docFraction: 0.4,
      snapshot: { tag: "div", label: "Loop step — Revise" },
    })
    const counts = linkedBundleCommentCounts([
      comment({ anchor }),
      comment({ id: "reply", thread_id: "thread-1", anchor: null }),
      comment({ id: "resolved", thread_id: "resolved", state: "resolved", anchor }),
    ])
    expect(counts.get(id)).toBe(1)
  })
})
