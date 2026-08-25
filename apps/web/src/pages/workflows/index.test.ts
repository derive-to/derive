import { describe, expect, it } from "vitest"
import type { WorkflowDirectoryItem } from "@/api"
import { workflowDirectoryEntries, workflowItemsForView } from "./index"

const item = (shortId: string, kinds: WorkflowDirectoryItem["kinds"]): WorkflowDirectoryItem => ({
  short_id: shortId,
  title: shortId,
  purpose: "Test the directory",
  version: 1,
  updated_at: "2026-08-24T12:00:00.000Z",
  kinds,
  diagram_count: 1,
  node_count: 2,
  execution: kinds.includes("workflow") ? "ready" : "descriptive",
})

describe("Workflows directory", () => {
  const graph = item("graph123", ["workflow", "graph"])
  const loop = item("loop1234", ["loop"])
  const both = item("both1234", ["graph", "loop"])

  it("keeps graph and loop views separate without duplicating a combined bundle in All", () => {
    const items = [graph, loop, both]
    expect(workflowItemsForView(items, "graphs").map((entry) => entry.short_id)).toEqual([
      "graph123",
      "both1234",
    ])
    expect(workflowItemsForView(items, "loops").map((entry) => entry.short_id)).toEqual([
      "loop1234",
      "both1234",
    ])
    expect(items).toHaveLength(3)
  })

  it("mixes contexts and bundles into one newest-first default directory", () => {
    const entries = workflowDirectoryEntries(
      [
        {
          id: "context-1",
          name: "Researcher",
          agent_id: "agent-1",
          manifest_short_id: "manifest1",
          created_by: "user-1",
          created_at: "2026-08-24T11:30:00.000Z",
          runner_seen_at: null,
          ask_policy: "workspace",
          connection_ids: [],
        },
      ],
      [graph, { ...loop, updated_at: "2026-08-24T11:00:00.000Z" }],
    )
    expect(entries.map((entry) => entry.kind)).toEqual(["bundle", "context", "bundle"])
  })
})
