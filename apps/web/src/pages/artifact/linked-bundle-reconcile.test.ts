import { describe, expect, it } from "vitest"
import { linkedBundleReconciliationEdit } from "./linked-bundle-reconcile"

const source = `<!doctype html><html><body>
<script type="application/derive-facts" data-fact="bundle-manifest">{"schema":"derive.linked-bundle/v1","purpose":"Review launch","members":[{"id":"brief","ref":"abc","label":"Brief"}],"diagrams":[{"id":"graph","title":"Graph","type":"graph","nodes":[{"id":"brief","label":"Brief","member":"brief","state":"active","basis_version":4}],"edges":[]}]}</script>
</body></html>`

describe("linked bundle reconciliation", () => {
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
