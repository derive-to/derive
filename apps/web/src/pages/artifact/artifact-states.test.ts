import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ArtifactWrongWorkspace } from "./artifact-states"

describe("ArtifactWrongWorkspace", () => {
  it("names the destination and offers the one-click switch", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactWrongWorkspace, {
        workspaceName: "Acme",
        onSwitch: vi.fn(),
        onBack: vi.fn(),
      }),
    )

    expect(html).toContain("Switch to Acme")
    expect(html).toContain("This artifact belongs to Acme")
    expect(html).toContain('data-testid="artifact-workspace-switch">Switch to Acme</button>')
    expect(html).toContain('data-testid="artifact-workspace-back"')
  })
})
