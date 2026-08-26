import { describe, expect, it } from "vitest"
import type { Artifact } from "@/api"
import { linkedBundleNodeNote, linkedBundleWorkflowNodeMap } from "./linked-bundle-node-details"

type Diagram = NonNullable<NonNullable<Artifact["linked_bundle"]>["diagrams"]>[number]

const graph: Diagram = {
  id: "launch",
  title: "Launch graph",
  type: "graph",
  nodes: [
    { id: "brief", label: "Brief" },
    { id: "research", label: "Research" },
    { id: "decision", label: "Decision" },
  ],
  edges: [
    { from: "brief", to: "research" },
    { from: "research", to: "decision" },
  ],
}

describe("linked bundle node details", () => {
  it("uses the authored note before the workflow draft", () => {
    const node = {
      id: "research",
      label: "Research",
      note: "Review the strongest customer evidence.",
      role: "Research owner",
    }
    const note = linkedBundleNodeNote(node, {
      node_id: "research",
      instruction: "Collect customer evidence.",
      result: "A cited evidence brief",
    })

    expect(note).toEqual({
      text: "Review the strongest customer evidence.",
      source: "note",
    })
  })

  it("drafts a missing note from workflow instruction then result", () => {
    const node = graph.nodes.find((item) => item.id === "research")
    if (!node) throw new Error("research fixture is missing")
    const base = {
      node_id: "research",
      result: "A cited evidence brief",
    }

    expect(
      linkedBundleNodeNote(node, {
        ...base,
        instruction: "Collect customer evidence.",
      }),
    ).toEqual({ text: "Collect customer evidence.", source: "workflow" })
    expect(
      linkedBundleNodeNote(node, {
        ...base,
        instruction: null,
      }),
    ).toEqual({ text: "A cited evidence brief", source: "workflow" })
  })

  it("keeps a truly empty node simple", () => {
    const node = graph.nodes.find((item) => item.id === "decision")
    if (!node) throw new Error("decision fixture is missing")
    expect(linkedBundleNodeNote(node)).toEqual({ text: null, source: null })
  })

  it("indexes workflow nodes with one shared diagram-and-node key", () => {
    const map = linkedBundleWorkflowNodeMap({
      status: "ready",
      execution_started: false,
      purpose: null,
      errors: [],
      diagrams: [
        {
          id: "launch",
          title: "Launch graph",
          will_do: [],
          may_do: [],
          will_pause: [],
          can_repeat: [],
          side_effects: [],
          node_details: [
            {
              node_id: "research",
              instruction: "Collect customer evidence.",
              result: null,
            },
          ],
          context_sessions: [],
          scenarios: [],
        },
      ],
      cannot_do: [],
      warnings: [],
    })

    expect(map.get("launch:research")?.instruction).toBe("Collect customer evidence.")
  })
})
