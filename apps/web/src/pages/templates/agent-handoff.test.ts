import { describe, expect, it } from "vitest"
import { localAgentHandoff, nativeTemplateRequest } from "./agent-handoff"

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
    expect(handoff).toContain("visually inspect")
    expect(handoff).not.toContain("{{")
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

  it("keeps the native prompt conversational because template_start carries the URI", () => {
    const prompt = nativeTemplateRequest(artifact, "  Make the launch story. ")
    expect(prompt).toContain("Make the launch story.")
    expect(prompt).not.toContain(artifact.uri)
  })
})
