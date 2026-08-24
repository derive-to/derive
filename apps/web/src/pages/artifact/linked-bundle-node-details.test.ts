import { describe, expect, it } from "vitest"
import type { Artifact } from "@/api"
import {
  linkedBundleNodeExplanation,
  linkedBundleWorkflowNodeMap,
} from "./linked-bundle-node-details"

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
  it("uses the authored note before workflow detail and exposes the four-part explanation", () => {
    const node = {
      id: "research",
      label: "Research",
      note: "Review the strongest customer evidence.",
      role: "Research owner",
    }
    const explanation = linkedBundleNodeExplanation(graph, node, {
      node_id: "research",
      label: "Research",
      kind: "context",
      instruction: "Collect customer evidence.",
      result: "A cited evidence brief",
      context_ref: "customer-research",
      exit_condition: "On completion → Decision",
    })

    expect(explanation).toEqual({
      whatHappens: "Review the strongest customer evidence.",
      source: "note",
      ownerContext: "Research owner · customer-research",
      expectedOutput: "A cited evidence brief",
      exitCondition: "On completion → Decision",
    })
  })

  it("falls back from a missing node note to workflow instruction then result", () => {
    const node = graph.nodes.find((item) => item.id === "research")
    if (!node) throw new Error("research fixture is missing")
    const base = {
      node_id: "research",
      label: "Research",
      kind: "context" as const,
      result: "A cited evidence brief",
      context_ref: "customer-research",
      exit_condition: "On completion → Decision",
    }

    expect(
      linkedBundleNodeExplanation(graph, node, {
        ...base,
        instruction: "Collect customer evidence.",
      }).whatHappens,
    ).toBe("Collect customer evidence.")
    expect(
      linkedBundleNodeExplanation(graph, node, {
        ...base,
        instruction: null,
      }).whatHappens,
    ).toBe("A cited evidence brief")
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
              label: "Research",
              kind: "context",
              instruction: "Collect customer evidence.",
              result: null,
              context_ref: null,
              exit_condition: "No outgoing transitions",
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
