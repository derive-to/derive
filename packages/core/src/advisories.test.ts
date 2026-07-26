import { describe, expect, it } from "vitest"
import { publishAdvisories } from "./advisories"

const HTML_NO_VIEWPORT = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>"
const HTML_WITH_VIEWPORT =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>hi</body></html>'

describe("publishAdvisories", () => {
  it("flags a styled page publishing into the reflow injection (no viewport meta)", () => {
    const out = publishAdvisories(HTML_NO_VIEWPORT, "text/html")
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("viewport")
    expect(out[0]).toContain("data-reflow-exempt")
  })

  it("says nothing when the author declared a viewport (they considered layout)", () => {
    expect(publishAdvisories(HTML_WITH_VIEWPORT, "text/html")).toHaveLength(0)
  })

  it("never gives the viewport advisory to markdown", () => {
    expect(publishAdvisories("# just a doc", "text/markdown")).toHaveLength(0)
  })

  it("flags large inlined base64 (binaries that should be assets), with the size", () => {
    const blob = "A".repeat(20 * 1024)
    const out = publishAdvisories(
      `${HTML_WITH_VIEWPORT}<img src="data:image/png;base64,${blob}">`,
      "text/html",
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("/v1/assets")
    expect(out[0]).toMatch(/~20KB/)
  })

  it("stays quiet for icon-sized data URIs (under the threshold)", () => {
    const out = publishAdvisories(
      `${HTML_WITH_VIEWPORT}<img src="data:image/png;base64,${"A".repeat(2048)}">`,
      "text/html",
    )
    expect(out).toHaveLength(0)
  })

  it("sums base64 across many small URIs — death by a thousand icons still flags", () => {
    const imgs = Array.from(
      { length: 20 },
      (_, i) => `<img src="data:image/png;base64,${"B".repeat(1024)}${i}">`,
    ).join("")
    const out = publishAdvisories(HTML_WITH_VIEWPORT + imgs, "text/html")
    expect(out).toHaveLength(1)
  })
})
