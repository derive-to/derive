import { describe, expect, it, vi } from "vitest"
import { buildInstructions } from "../src/agent"
import type { HostedAgentClient } from "../src/client"
import { RunLatch } from "../src/submit"
import { buildTools, type RunContext } from "../src/tools"

const client: HostedAgentClient = {
  read: vi.fn().mockResolvedValue("# Doc\n\nbody"),
  comment: vi.fn().mockResolvedValue(undefined),
  proposeRevision: vi.fn().mockResolvedValue({ short_id: "a1", version: 2 }),
  publishLive: vi.fn().mockResolvedValue({ short_id: "a1", version: 3 }),
  recordRun: vi.fn().mockResolvedValue(undefined),
  claimRuns: vi.fn().mockResolvedValue([]),
  finishRun: vi.fn().mockResolvedValue(undefined),
}

const runCtx = (): RunContext => ({
  client,
  latch: new RunLatch(),
  autonomy: "suggest",
  flags: { agentKillswitch: false, agentAutoEnabled: false },
})

describe("buildInstructions", () => {
  it("layers the manifest, optional conventions, and the write contract", () => {
    const withConv = buildInstructions({
      manifest: "You are Analytics.",
      conventions: "Use tables.",
    })
    expect(withConv).toContain("You are Analytics.")
    expect(withConv).toContain("Use tables.")
    expect(withConv).toContain("submit_revision exactly once")
    const bare = buildInstructions({ manifest: "M" })
    expect(bare).toContain("M")
    expect(bare).not.toContain("undefined")
  })
})

describe("buildTools", () => {
  it("exposes exactly the public-surface tools plus the terminal submit", () => {
    const tools = buildTools(runCtx())
    expect(Object.keys(tools).sort()).toEqual(["comment", "read_artifact", "submit_revision"])
    expect(tools.submit_revision.id).toBe("submit_revision")
    expect(tools.submit_revision.description).toMatch(/never choose/)
  })

  it("the submit_revision tool routes through the gate (structural → proposal)", async () => {
    const ctx = runCtx()
    const tools = buildTools(ctx)
    const out = (await tools.submit_revision.execute?.(
      {
        shortId: "a1",
        content: "# Doc\n\nbody\n\n## New section",
        filename: "notes.md",
        confidence: 1,
      },
      // biome-ignore lint/suspicious/noExplicitAny: Mastra passes a runtime execution context the tool ignores.
      {} as any,
    )) as { decision: string; changeKind: string }
    expect(out).toMatchObject({ decision: "proposal", changeKind: "structural" })
    expect(client.proposeRevision).toHaveBeenCalledOnce()
  })
})
