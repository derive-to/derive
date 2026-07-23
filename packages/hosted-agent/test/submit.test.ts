import type { AutonomyLevel } from "@derive/core"
import { describe, expect, it, vi } from "vitest"
import type { HostedAgentClient } from "../src/client"
import { RunLatch, type SubmitContext, submitRevision } from "../src/submit"

const mockClient = (current: string): HostedAgentClient => ({
  read: vi.fn().mockResolvedValue(current),
  comment: vi.fn().mockResolvedValue(undefined),
  proposeRevision: vi.fn().mockResolvedValue({ short_id: "a1", version: 5 }),
  publishLive: vi.fn().mockResolvedValue({ short_id: "a1", version: 6 }),
  recordRun: vi.fn().mockResolvedValue(undefined),
  claimRuns: vi.fn().mockResolvedValue([]),
  finishRun: vi.fn().mockResolvedValue(undefined),
})

const ctxFor = (
  client: HostedAgentClient,
  over: Partial<Pick<SubmitContext, "autonomy" | "flags">> = {},
): SubmitContext => ({
  client,
  latch: new RunLatch(),
  autonomy: (over.autonomy ?? "auto") as AutonomyLevel,
  flags: over.flags ?? { agentKillswitch: false, agentAutoEnabled: true },
})

const roadmap = "# Roadmap\n\nStatus: in review\nCount: 41"
const freshness = "# Roadmap\n\nStatus: shipped\nCount: 43"
const structural = "# Roadmap\n\nStatus: in review\nCount: 41\n\n## A whole new section"

describe("submitRevision", () => {
  it("a confident freshness change on an opted-in workspace publishes live with a review round", async () => {
    const client = mockClient(roadmap)
    const r = await submitRevision(ctxFor(client), {
      shortId: "a1",
      content: freshness,
      filename: "index.html",
      confidence: 1,
    })
    expect(r).toMatchObject({ decision: "live_publish_with_review", changeKind: "freshness" })
    expect(client.publishLive).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ content: freshness }),
      { requestReview: true },
    )
    expect(client.proposeRevision).not.toHaveBeenCalled()
  })

  it("a structural change is a proposal even at full confidence and auto", async () => {
    const client = mockClient(roadmap)
    const r = await submitRevision(ctxFor(client), {
      shortId: "a1",
      content: structural,
      filename: "index.html",
      confidence: 1,
    })
    expect(r).toMatchObject({ decision: "proposal", changeKind: "structural" })
    expect(client.proposeRevision).toHaveBeenCalledOnce()
    expect(client.publishLive).not.toHaveBeenCalled()
  })

  it("the killswitch forces a proposal even for a freshness change", async () => {
    const client = mockClient(roadmap)
    const r = await submitRevision(
      ctxFor(client, { flags: { agentKillswitch: true, agentAutoEnabled: true } }),
      { shortId: "a1", content: freshness, filename: "index.html", confidence: 1 },
    )
    expect(r.decision).toBe("proposal")
    expect(client.proposeRevision).toHaveBeenCalledOnce()
  })

  it("shadow files nothing — no write of either kind", async () => {
    const client = mockClient(roadmap)
    const r = await submitRevision(ctxFor(client, { autonomy: "shadow" }), {
      shortId: "a1",
      content: freshness,
      filename: "index.html",
      confidence: 1,
    })
    expect(r.decision).toBe("shadow")
    expect(client.proposeRevision).not.toHaveBeenCalled()
    expect(client.publishLive).not.toHaveBeenCalled()
  })

  it("the run latch no-ops a duplicate submit after a clean write", async () => {
    const client = mockClient(roadmap)
    const ctx = ctxFor(client)
    await submitRevision(ctx, {
      shortId: "a1",
      content: freshness,
      filename: "index.html",
      confidence: 1,
    })
    const second = await submitRevision(ctx, {
      shortId: "a1",
      content: freshness,
      filename: "index.html",
      confidence: 1,
    })
    expect(second.duplicate).toBe(true)
    expect(client.publishLive).toHaveBeenCalledOnce()
  })

  it("a failed write leaves the run un-settled so the agent can retry", async () => {
    const client = mockClient(roadmap)
    ;(client.proposeRevision as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("529"))
    const ctx = ctxFor(client, { autonomy: "suggest" })
    await expect(
      submitRevision(ctx, {
        shortId: "a1",
        content: freshness,
        filename: "index.html",
        confidence: 1,
      }),
    ).rejects.toThrow("529")
    expect(ctx.latch.settled).toBe(false)
    // Retry succeeds and writes.
    const retry = await submitRevision(ctx, {
      shortId: "a1",
      content: freshness,
      filename: "index.html",
      confidence: 1,
    })
    expect(retry.decision).toBe("proposal")
    expect(client.proposeRevision).toHaveBeenCalledTimes(2)
  })
})
