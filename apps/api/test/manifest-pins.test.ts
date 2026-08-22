import { describe, expect, it } from "vitest"
import { manifestDescription } from "../src/lib/manifest-pins"

describe("manifestDescription", () => {
  it("keeps the first prose paragraph from a markdown manifest", () => {
    expect(
      manifestDescription("# Hiring playbook\n\nRun the search without restating the brief.\n"),
    ).toBe("Run the search without restating the brief.")
  })

  it("converts an HTML linked graph to readable prose before summarizing it", () => {
    const html =
      "<!doctype html><html><head><title>Graph</title><style>body{color:red}</style></head>" +
      '<body><p class="eyebrow">Live hiring workflow</p><h1>Pete’s search</h1>' +
      "<p>Research, draft, source, and package the role.</p><script>ignored()</script></body></html>"

    expect(manifestDescription(html)).toBe("Research, draft, source, and package the role.")
    expect(manifestDescription(html)).not.toContain("<!doctype")
  })
})
