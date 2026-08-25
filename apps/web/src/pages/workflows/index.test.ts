import { describe, expect, it } from "vitest"
import type { ContextInfo } from "@/api"
import { workflowContextsForView } from "./index"

const context = (id: string, kind: ContextInfo["kind"], createdAt: string): ContextInfo => ({
  id,
  name: id,
  agent_id: `agent-${id}`,
  manifest_short_id: `manifest-${id}`,
  created_by: "user-1",
  created_at: createdAt,
  runner_seen_at: null,
  ask_policy: "workspace",
  connection_ids: [],
  kind,
  manifest_status: kind ? "ready" : "needs-changes",
  manifest_source: kind === "single" ? "implicit-single" : "agent-manifest-v2",
  manifest_errors: kind ? [] : ["Unknown manifest kind"],
  node_count: kind === "single" ? 0 : 2,
  loop_count: kind === "loop" ? 1 : 0,
})

describe("Workflows context directory", () => {
  const single = context("single", "single", "2026-08-24T11:00:00.000Z")
  const graph = context("graph", "graph", "2026-08-24T13:00:00.000Z")
  const loop = context("loop", "loop", "2026-08-24T12:00:00.000Z")
  const invalid = context("invalid", null, "2026-08-24T14:00:00.000Z")
  const all = [single, graph, loop, invalid]

  it("shows one context-backed record per workflow in newest-first order", () => {
    expect(workflowContextsForView(all, "all").map((item) => item.id)).toEqual([
      "invalid",
      "graph",
      "loop",
      "single",
    ])
  })

  it("filters Contexts, Graphs, and Loops by normalized manifest kind", () => {
    expect(workflowContextsForView(all, "contexts").map((item) => item.id)).toEqual(["single"])
    expect(workflowContextsForView(all, "graphs").map((item) => item.id)).toEqual(["graph"])
    expect(workflowContextsForView(all, "loops").map((item) => item.id)).toEqual(["loop"])
  })

  it("keeps an invalid unknown-kind context visible in All instead of silently dropping it", () => {
    expect(workflowContextsForView(all, "all")).toContainEqual(invalid)
    expect(workflowContextsForView(all, "graphs")).not.toContainEqual(invalid)
  })

  it("stays deterministic for a large mixed directory", () => {
    const items = Array.from({ length: 1_000 }, (_, index) =>
      context(
        `context-${String(index).padStart(4, "0")}`,
        index % 3 === 0 ? "single" : index % 3 === 1 ? "graph" : "loop",
        new Date(Date.UTC(2026, 7, 24, 12, 0, index)).toISOString(),
      ),
    )
    const entries = workflowContextsForView(items, "all")
    expect(entries).toHaveLength(1_000)
    expect(entries[0]?.id).toBe("context-0999")
    expect(new Set(entries.map((item) => item.id)).size).toBe(1_000)
  })
})
