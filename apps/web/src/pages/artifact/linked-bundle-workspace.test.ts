import { describe, expect, it } from "vitest"
import type { Artifact, Comment } from "@/api"
import { linkedBundleManifestProblem, linkedBundleManifestSource } from "./linked-bundle-editor"
import {
  linkedBundleCommentCounts,
  linkedBundleEffectiveTier,
  linkedBundleReviewTarget,
} from "./linked-bundle-panel"
import { linkedBundleReconciliationEdit } from "./linked-bundle-reconcile"
import {
  linkedBundleAnchor,
  linkedBundleCurrentNodes,
  linkedBundleEdgePath,
  linkedBundleFitScale,
  linkedBundleFocusedElements,
  linkedBundleInitialView,
  linkedBundleLayout,
  linkedBundleNodeFreshness,
  linkedBundleNowHeadline,
  linkedBundleNowSummary,
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

  it("uses a node tier before the graph default", () => {
    const diagram = { ...graph, tier: "expert" as const }
    expect(linkedBundleEffectiveTier({ id: "brief", label: "Brief" }, diagram)).toBe("expert")
    expect(linkedBundleEffectiveTier({ id: "brief", label: "Brief", tier: "fast" }, diagram)).toBe(
      "fast",
    )
    expect(linkedBundleEffectiveTier({ id: "brief", label: "Brief" }, graph)).toBeNull()
  })

  it("keeps mobile graph labels readable while desktop still fits the overview", () => {
    expect(linkedBundleFitScale(390, 2_400)).toBe(0.72)
    expect(linkedBundleFitScale(1_200, 2_400)).toBeCloseTo(1_160 / 2_400)
    expect(linkedBundleFitScale(1_200, 800)).toBe(1)
  })

  it("keeps cyclic graph nodes and reciprocal edge labels from overlapping", () => {
    const cyclic = {
      ...graph,
      edges: [
        { from: "brief", to: "research", label: "ready" },
        { from: "research", to: "brief", label: "revise" },
        { from: "research", to: "decision", label: "approve" },
      ],
    }
    const layout = linkedBundleLayout(cyclic)
    expect(new Set(Object.values(layout.nodes).map((point) => point.x)).size).toBe(3)
    const [first, second] = cyclic.edges
    if (!first || !second) throw new Error("reciprocal fixture is incomplete")
    const forward = linkedBundleEdgePath(cyclic, first, layout.nodes)
    const reverse = linkedBundleEdgePath(cyclic, second, layout.nodes)
    expect(Math.abs(forward.y - reverse.y)).toBeGreaterThan(112)
  })

  it("surfaces only current or attention-worthy nodes for the mobile summary", () => {
    const diagram = {
      ...graph,
      nodes: [
        { id: "brief", label: "Brief", state: "done" as const },
        { id: "research", label: "Research", state: "active" as const },
        { id: "decision", label: "Decision", state: "waiting" as const },
      ],
    }
    expect(linkedBundleCurrentNodes(diagram).map((node) => node.id)).toEqual([
      "research",
      "decision",
    ])
  })

  it("opens untouched workflows on Preview and started workflows on Now", () => {
    expect(linkedBundleInitialView([graph], true)).toBe("preview")
    expect(
      linkedBundleInitialView(
        [
          {
            ...graph,
            nodes: graph.nodes.map((node, index) =>
              index === 0 ? { ...node, state: "done" as const } : node,
            ),
          },
        ],
        true,
      ),
    ).toBe("now")
    expect(linkedBundleInitialView([graph], false)).toBe("now")
  })

  it("projects authored graph state into current, help, and likely-next work", () => {
    const diagram = {
      ...graph,
      nodes: [
        { id: "brief", label: "Brief", state: "done" as const },
        { id: "research", label: "Research", state: "active" as const },
        {
          id: "decision",
          label: "Decision",
          state: "waiting" as const,
          help: { needed: true, question: "Choose the launch date" },
        },
        { id: "launch", label: "Launch", state: "pending" as const },
      ],
      edges: [
        { from: "brief", to: "research" },
        { from: "research", to: "decision" },
        { from: "decision", to: "launch" },
      ],
    }
    expect(linkedBundleNowSummary([diagram])).toEqual({
      current: [
        { diagram: "launch", node: "research" },
        { diagram: "launch", node: "decision" },
      ],
      needsHelp: [{ diagram: "launch", node: "decision" }],
      next: [{ diagram: "launch", node: "launch" }],
      done: 1,
      total: 4,
    })
  })

  it("calls a fully completed graph a completed run", () => {
    expect(
      linkedBundleNowHeadline({ current: [], needsHelp: [], next: [], done: 3, total: 3 }),
    ).toBe("Run complete.")
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

describe("linked bundle manifest editor", () => {
  it("reads the authored manifest without rewriting the surrounding page", () => {
    const source =
      '<h1>Bundle</h1><script data-fact="bundle-manifest" type="application/derive-facts">\n' +
      '{"schema":"derive.linked-bundle/v1","purpose":"Coordinate","members":[{"id":"a","ref":"abc12345","label":"A"}]}\n' +
      "</script><footer>Keep me</footer>"
    const manifest = linkedBundleManifestSource(source)
    expect(manifest?.exact).toContain("derive.linked-bundle/v1")
    expect(manifest?.value.purpose).toBe("Coordinate")
    expect(source.replace(manifest?.exact ?? "", "NEXT")).toContain("<footer>Keep me</footer>")
  })

  it("rejects a manifest that would turn native bundle behavior off", () => {
    expect(linkedBundleManifestProblem({ schema: "other", purpose: "x", members: [{}] })).toContain(
      "Schema",
    )
    expect(
      linkedBundleManifestProblem({
        schema: "derive.linked-bundle/v1",
        purpose: "",
        members: [{}],
      }),
    ).toContain("Purpose")
    expect(
      linkedBundleManifestProblem({
        schema: "derive.linked-bundle/v1",
        purpose: "x",
        members: [],
        diagrams: [graph],
      }),
    ).toBeNull()
    expect(
      linkedBundleManifestProblem({
        schema: "derive.linked-bundle/v1",
        purpose: "x",
        members: [],
        diagrams: [],
      }),
    ).toContain("artifact member, loop, or graph")
  })
})

describe("linked bundle review map", () => {
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

describe("linked bundle reconciliation", () => {
  const source = `<!doctype html><html><body>
<script type="application/derive-facts" data-fact="bundle-manifest">{"schema":"derive.linked-bundle/v1","purpose":"Review launch","members":[{"id":"brief","ref":"abc","label":"Brief"}],"diagrams":[{"id":"graph","title":"Graph","type":"graph","nodes":[{"id":"brief","label":"Brief","member":"brief","state":"active","basis_version":4}],"edges":[]}]}</script>
</body></html>`

  it("updates only explicit authored node state in the inert manifest", () => {
    const edit = linkedBundleReconciliationEdit(source, "graph", "brief", {
      state: "done",
      basisVersion: 7,
      note: "Reviewed by a human",
    })
    expect(edit?.exact).toContain('"state":"active"')
    expect(edit?.serialized).toContain(
      '"state":"done","basis_version":7,"note":"Reviewed by a human"',
    )
  })

  it("serializes optional role, confidence, and help details only when authored", () => {
    const edit = linkedBundleReconciliationEdit(source, "graph", "brief", {
      state: "waiting",
      role: "Decision owner",
      confidence: { level: "high", basis: "Reviewed the current brief" },
      help: {
        needed: true,
        question: "Approve the launch date?",
        canContinue: "Prepare the rollout plan",
      },
    })
    expect(edit?.serialized).toContain('"state":"waiting"')
    expect(edit?.serialized).toContain('"role":"Decision owner"')
    expect(edit?.serialized).toContain(
      '"confidence":{"level":"high","basis":"Reviewed the current brief"}',
    )
    expect(edit?.serialized).toContain(
      '"help":{"needed":true,"question":"Approve the launch date?","can_continue":"Prepare the rollout plan"}',
    )
  })

  it("removes optional node details when they are left unset", () => {
    const sourceWithDetails = source.replace(
      '"state":"active","basis_version":4',
      '"state":"active","basis_version":4,"role":"Old role","confidence":{"level":"low","basis":"Old basis"},"help":{"needed":true,"question":"Old question"}',
    )
    const edit = linkedBundleReconciliationEdit(sourceWithDetails, "graph", "brief", {
      state: "done",
    })
    expect(edit?.serialized).not.toContain('"role"')
    expect(edit?.serialized).not.toContain('"confidence"')
    expect(edit?.serialized).not.toContain('"help"')
  })

  it("stores a no-help marker without stale question details", () => {
    const edit = linkedBundleReconciliationEdit(source, "graph", "brief", {
      state: "active",
      help: { needed: false },
    })
    expect(edit?.serialized).toContain('"help":{"needed":false}')
    expect(edit?.serialized).not.toContain('"question"')
    expect(edit?.serialized).not.toContain('"can_continue"')
  })

  it("does not infer pending state when editing another optional detail", () => {
    const sourceWithoutState = source.replace(',"state":"active","basis_version":4', "")
    const edit = linkedBundleReconciliationEdit(sourceWithoutState, "graph", "brief", {
      role: "Decision owner",
    })
    expect(edit?.serialized).toContain('"role":"Decision owner"')
    expect(edit?.serialized).not.toContain('"state"')
  })

  it("fails closed when the requested node is not in the manifest", () => {
    expect(
      linkedBundleReconciliationEdit(source, "graph", "missing", { state: "pending" }),
    ).toBeNull()
  })
})
