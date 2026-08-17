import { describe, expect, it } from "vitest"
import type { Artifact } from "@/api"
import { linkedBundleFocusMatches, linkedBundleFocusTargets } from "./linked-bundle-focus"

type LinkedBundle = NonNullable<Artifact["linked_bundle"]>

describe("linked bundle focus search", () => {
  const members = new Map(
    [
      {
        id: "evidence",
        ref: "evidence123",
        label: "Evidence ledger",
        available: true,
        current_version: 9,
      },
    ].map((member) => [member.id, member] as const),
  ) satisfies Map<string, LinkedBundle["members"][number]>
  const diagrams: NonNullable<LinkedBundle["diagrams"]> = [
    {
      id: "decision-graph",
      title: "Release decision",
      type: "graph",
      nodes: [{ id: "confidence", label: "Confidence", member: "evidence" }],
      edges: [],
    },
  ]

  it("indexes both native labels and linked artifact labels", () => {
    const [target] = linkedBundleFocusTargets(diagrams, members)
    expect(target).toMatchObject({
      diagram: "decision-graph",
      local: "confidence",
      label: "Confidence",
      context: "Release decision · Evidence ledger",
    })
  })

  it("matches every search term so reviewers can jump by artifact or node", () => {
    const targets = linkedBundleFocusTargets(diagrams, members)
    expect(linkedBundleFocusMatches(targets, "evidence confidence")).toHaveLength(1)
    expect(linkedBundleFocusMatches(targets, "missing")).toEqual([])
  })
})
