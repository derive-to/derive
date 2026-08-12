import { describe, expect, it } from "vitest"
import { localAgentHandoff, localAgentLaunchUrl, nativeTemplateRequest } from "./agent-handoff"

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

  it("opens Codex and Claude Code with the complete portable handoff prefilled", () => {
    const brief = "Make the launch story."
    const handoff = localAgentHandoff(artifact, brief)
    const codex = new URL(localAgentLaunchUrl("codex", artifact, brief) as string)
    const claude = new URL(localAgentLaunchUrl("claude-code", artifact, brief) as string)

    expect(codex.protocol).toBe("codex:")
    expect(codex.hostname).toBe("new")
    expect(codex.searchParams.get("prompt")).toBe(handoff)
    expect(claude.protocol).toBe("claude-cli:")
    expect(claude.hostname).toBe("open")
    expect(claude.searchParams.get("q")).toBe(handoff)
  })

  it("refuses to silently truncate a Claude Code deep link", () => {
    expect(localAgentLaunchUrl("claude-code", artifact, "x".repeat(5_000))).toBeNull()
    expect(localAgentLaunchUrl("codex", artifact, "x".repeat(5_000))).toContain("codex://new")
  })
})
