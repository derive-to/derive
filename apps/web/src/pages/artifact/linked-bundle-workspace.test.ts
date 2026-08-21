import { describe, expect, it } from "vitest"
import type { Artifact, Comment } from "@/api"
import { linkedBundleManifestProblem, linkedBundleManifestSource } from "./linked-bundle-editor"
import { linkedBundleCommentCounts, linkedBundleReviewTarget } from "./linked-bundle-panel"
import { linkedBundleReconciliationEdit } from "./linked-bundle-reconcile"
import {
  linkedBundleAnchor,
  linkedBundleFocusedElements,
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
      }),
    ).toContain("artifact member")
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

  it("fails closed when the requested node is not in the manifest", () => {
    expect(
      linkedBundleReconciliationEdit(source, "graph", "missing", { state: "pending" }),
    ).toBeNull()
  })
})
