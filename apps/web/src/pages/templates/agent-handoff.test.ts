import { describe, expect, it } from "vitest"
import { localAgentHandoff } from "./agent-handoff"
import { TEMPLATE_PROTOCOL_INSTRUCTION } from "./template-protocol-instruction.gen"

const artifact = {
  uri: "graph123",
  title: "Research synthesis",
  description: "A reusable research graph.",
  kind: "artifact" as const,
  category: "Bundle",
}

describe("template agent handoff", () => {
  it("uses the canonical fact inventory and protocol-preservation contract", () => {
    const handoff = localAgentHandoff(artifact, "Adapt this for launch readiness.")

    expect(handoff).toContain(TEMPLATE_PROTOCOL_INSTRUCTION)
    expect(handoff).toContain('data:"*"')
    expect(handoff).toContain("workflow-definition")
    expect(handoff).toContain("Arbitrary facts do not imply a matching skill")
  })

  it("keeps the specialized context activation contract", () => {
    const handoff = localAgentHandoff(
      { ...artifact, kind: "context", category: "Context" },
      "Adapt this context.",
    )

    expect(handoff).toContain("automate with create_context")
    expect(handoff).not.toContain(TEMPLATE_PROTOCOL_INSTRUCTION)
  })
})
