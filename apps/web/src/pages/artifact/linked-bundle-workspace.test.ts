import { describe, expect, it } from "vitest"
import type { Artifact } from "@/api"
import {
  linkedBundleAnchor,
  linkedBundleFocusedElements,
  linkedBundleLayout,
  linkedBundleNodeFreshness,
} from "./linked-bundle-workspace"

type Diagram = NonNullable<NonNullable<Artifact["linked_bundle"]>["diagrams"]>[number]
type Member = NonNullable<Artifact["linked_bundle"]>["members"][number]

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

describe("linked bundle workspace", () => {
  it("lays a graph out in dependency order without a canvas engine", () => {
    const layout = linkedBundleLayout(graph)
    expect(layout.nodes.brief?.x).toBeLessThan(layout.nodes.research?.x ?? 0)
    expect(layout.nodes.research?.x).toBeLessThan(layout.nodes.decision?.x ?? 0)
    expect(layout.width).toBeGreaterThanOrEqual(660)
  })

  it("lays every loop step around a visible cycle", () => {
    const layout = linkedBundleLayout({
      ...graph,
      id: "improve",
      type: "loop",
      goal: "Improve",
      evaluate: "Check",
      stop: "Confident",
      edges: [
        { from: "brief", to: "research" },
        { from: "research", to: "decision" },
        { from: "decision", to: "brief" },
      ],
    })
    expect(new Set(Object.values(layout.nodes).map((point) => `${point.x}:${point.y}`)).size).toBe(
      3,
    )
  })

  it("turns a native visual selection into the durable semantic anchor", () => {
    expect(
      linkedBundleAnchor({
        id: "derive-launch-node-research",
        kind: "graph-node",
        label: "Graph node — Research",
      }),
    ).toMatchObject({
      type: "ElementSelector",
      tag: "div",
      id: "derive-launch-node-research",
      role: "graph-node",
      snapshot: { label: "Graph node — Research" },
    })
  })

  it("flags authored state when its linked artifact has advanced", () => {
    const node = { id: "brief", label: "Brief", member: "brief", basis_version: 4 }
    const member = {
      id: "brief",
      ref: "brief123",
      label: "Brief",
      available: true,
      current_version: 5,
    } satisfies Member
    expect(linkedBundleNodeFreshness(node, member)).toBe("updated")
    expect(linkedBundleNodeFreshness({ ...node, basis_version: 5 }, member)).toBe("fresh")
  })

  it("focuses a selected node and only its immediate graph context", () => {
    const focus = linkedBundleFocusedElements(graph, {
      diagram: "launch",
      kind: "node",
      local: "research",
    })
    expect([...focus.nodes]).toEqual(["research", "brief", "decision"])
    expect([...focus.edges]).toEqual([0, 1])
  })

  it("focuses a selected relationship and its two endpoints", () => {
    const focus = linkedBundleFocusedElements(graph, {
      diagram: "launch",
      kind: "edge",
      local: "1-research-decision",
    })
    expect([...focus.nodes]).toEqual(["research", "decision"])
    expect([...focus.edges]).toEqual([1])
  })
})
