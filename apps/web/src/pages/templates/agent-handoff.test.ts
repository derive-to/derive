import { describe, expect, it } from "vitest"
import { localAgentHandoff } from "./agent-handoff"

const artifact = {
  uri: "derive://templates/narrative-pitch",
  title: "Narrative pitch",
  description: "A story-led deck.",
  kind: "artifact" as const,
  category: "Deck",
}

describe("template agent handoffs", () => {
  it("gives a local agent an exact, agentic artifact contract", () => {
    const handoff = localAgentHandoff(artifact, "  Make Acme's launch story.  ")
    expect(handoff).toContain("Exact reference: derive://templates/narrative-pitch")
    expect(handoff).toContain("Make Acme's launch story.")
    expect(handoff).toContain("read tool")
    expect(handoff).toContain("Use find")
    expect(handoff).toContain("publish a new artifact")
    expect(handoff).toContain('derived_from: "derive://templates/narrative-pitch"')
    expect(handoff).toContain("visually inspect")
    expect(handoff).not.toContain("{{")
  })

  it("pins the destination workspace into the portable task", () => {
    const handoff = localAgentHandoff(artifact, "Make the launch story.", {
      id: "ws_product",
      name: "Product",
    })
    expect(handoff).toContain("Destination workspace: Product (ws_product)")
    expect(handoff).toContain("confirm the active workspace is Product")
  })

  it("adapts the contract to Context creation", () => {
    const handoff = localAgentHandoff(
      { ...artifact, kind: "context", category: "Context", title: "Research brief" },
      "Use approved research every Monday.",
    )
    expect(handoff).toContain("procedures, sources, and operating decisions")
    expect(handoff).toContain("automate with create_context")
    expect(handoff).not.toContain("visually inspect")
  })
})
