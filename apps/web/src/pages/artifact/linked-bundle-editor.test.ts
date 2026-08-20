import { describe, expect, it } from "vitest"
import {
  linkedBundleManifestProblem,
  linkedBundleManifestSource,
  linkedBundleManifestSummary,
} from "./linked-bundle-editor"

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

  it("summarizes the authored surface before a reviewer edits JSON", () => {
    expect(
      linkedBundleManifestSummary({
        members: [{ id: "a" }, { id: "b" }],
        diagrams: [
          {
            type: "loop",
            nodes: [{ id: "observe" }, { id: "revise" }],
            edges: [{ from: "observe", to: "revise" }],
          },
          {
            type: "graph",
            nodes: [{ id: "evidence" }, { id: "decision" }],
            edges: [
              { from: "evidence", to: "decision" },
              { from: "decision", to: "evidence" },
            ],
          },
        ],
      }),
    ).toEqual({ artifacts: 2, loops: 1, graphs: 1, nodes: 4, relationships: 3 })
  })
})
