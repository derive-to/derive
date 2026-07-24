import type { AutonomyLevel } from "@derive/core"
import { describe, expect, it, vi } from "vitest"
import type { HostedAgentClient } from "../src/client"
import { RunBudget, type SubmitContext, submitRevision } from "../src/submit"

const mockClient = (current: string): HostedAgentClient => ({
  read: vi.fn().mockResolvedValue(current),
  comment: vi.fn().mockResolvedValue(undefined),
  proposeRevision: vi.fn().mockResolvedValue({ short_id: "a1", version: 5 }),
  publishLive: vi.fn().mockResolvedValue({ short_id: "a1", version: 6 }),
  createArtifact: vi.fn().mockResolvedValue({ short_id: "new1", version: 1 }),
  recordRun: vi.fn().mockResolvedValue(undefined),
  claimRuns: vi.fn().mockResolvedValue([]),
  finishRun: vi.fn().mockResolvedValue(undefined),
  executeTool: vi.fn().mockResolvedValue(undefined),
})

const ctxFor = (
  client: HostedAgentClient,
  over: Partial<
    Pick<SubmitContext, "autonomy" | "flags" | "stampTags" | "budget" | "writeModes">
  > = {},
): SubmitContext => ({
  client,
  budget: over.budget ?? new RunBudget(),
  autonomy: (over.autonomy ?? "auto") as AutonomyLevel,
  writeModes: over.writeModes,
  flags: over.flags ?? { agentKillswitch: false, agentAutoEnabled: true },
  stampTags: over.stampTags,
  results: [],
})

const roadmap = "# Roadmap\n\nStatus: in review\nCount: 41"
const freshness = "# Roadmap\n\nStatus: shipped\nCount: 43"
const structural = "# Roadmap\n\nStatus: in review\nCount: 41\n\n## A whole new section"

const revise = (ctx: SubmitContext, content: string) =>
  submitRevision(ctx, { shortId: "a1", content, filename: "index.html", confidence: 1 })

describe("submitRevision", () => {
  it("a confident freshness change on an opted-in workspace publishes live with a review round", async () => {
    const client = mockClient(roadmap)
    const ctx = ctxFor(client)
    const r = await revise(ctx, freshness)
    expect(r).toMatchObject({ decision: "live_publish_with_review", changeKind: "freshness" })
    expect(client.publishLive).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ content: freshness }),
      { requestReview: true },
    )
    expect(client.proposeRevision).not.toHaveBeenCalled()
    expect(ctx.results).toHaveLength(1)
  })

  it("a structural change publishes live when the target's mode says publish — the user decided", async () => {
    const client = mockClient(roadmap)
    const ctx = ctxFor(client, {
      autonomy: "suggest",
      writeModes: { byArtifact: { a1: "publish" }, create: "propose" },
    })
    const r = await revise(ctx, structural)
    expect(r).toMatchObject({ decision: "live_publish_with_review", changeKind: "structural" })
    expect(client.publishLive).toHaveBeenCalledOnce()
  })

  it("no per-target mode → the write proposes (automation default), whatever the blanket says", async () => {
    const client = mockClient(roadmap)
    // The modes map covers a9 only; the write targets a1, which falls back to the
    // blanket autonomy (suggest) and proposes.
    const ctx = ctxFor(client, {
      autonomy: "suggest",
      writeModes: { byArtifact: { a9: "publish" }, create: "propose" },
    })
    const r = await revise(ctx, freshness)
    expect(r.decision).toBe("proposal")
    expect(client.proposeRevision).toHaveBeenCalledOnce()
  })

  it("the killswitch forces a proposal even for a freshness change", async () => {
    const client = mockClient(roadmap)
    const r = await revise(
      ctxFor(client, { flags: { agentKillswitch: true, agentAutoEnabled: true } }),
      freshness,
    )
    expect(r.decision).toBe("proposal")
    expect(client.proposeRevision).toHaveBeenCalledOnce()
  })

  it("shadow files nothing and refunds the budget", async () => {
    const client = mockClient(roadmap)
    const ctx = ctxFor(client, { autonomy: "shadow" })
    const r = await revise(ctx, freshness)
    expect(r.decision).toBe("shadow")
    expect(client.proposeRevision).not.toHaveBeenCalled()
    expect(client.publishLive).not.toHaveBeenCalled()
    expect(ctx.budget.used).toBe(0)
  })

  it("the write budget allows three writes and refuses the fourth", async () => {
    const client = mockClient(roadmap)
    const ctx = ctxFor(client)
    for (let i = 0; i < 3; i += 1) {
      const r = await revise(ctx, freshness)
      expect(r.overBudget).toBeUndefined()
    }
    const fourth = await revise(ctx, freshness)
    expect(fourth.overBudget).toBe(true)
    expect(client.publishLive).toHaveBeenCalledTimes(3)
    expect(ctx.results).toHaveLength(3)
  })

  it("a failed write refunds the budget so the agent can retry", async () => {
    const client = mockClient(roadmap)
    ;(client.proposeRevision as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("529"))
    const ctx = ctxFor(client, { autonomy: "suggest" })
    await expect(revise(ctx, freshness)).rejects.toThrow("529")
    expect(ctx.budget.used).toBe(0)
    const retry = await revise(ctx, freshness)
    expect(retry.decision).toBe("proposal")
    expect(client.proposeRevision).toHaveBeenCalledTimes(2)
    expect(ctx.results).toHaveLength(1)
  })

  it("creation on auto (flags on, confident) publishes live as a NEW artifact with a review round", async () => {
    const client = mockClient(roadmap)
    const ctx = ctxFor(client)
    const r = await submitRevision(ctx, {
      title: "Weekly report",
      content: "# Week 1",
      filename: "notes.md",
      confidence: 1,
    })
    expect(r).toMatchObject({ decision: "live_publish_with_review", changeKind: "creation" })
    expect(r.created).toBe(true)
    expect(r.shortId).toBe("new1")
    expect(client.createArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ content: "# Week 1" }),
      { title: "Weekly report", requestReview: true, privateDraft: false },
    )
    // Creation never touches the read/classify path — there is no before-text.
    expect(client.read).not.toHaveBeenCalled()
  })

  it("creation on the suggest route lands as a PRIVATE draft — the creation analogue of a proposal", async () => {
    const client = mockClient(roadmap)
    const r = await submitRevision(ctxFor(client, { autonomy: "suggest" }), {
      title: "Draft",
      content: "# Draft",
      filename: "notes.md",
      confidence: 1,
    })
    expect(r.decision).toBe("proposal")
    expect(client.createArtifact).toHaveBeenCalledWith(expect.anything(), {
      title: "Draft",
      requestReview: true,
      privateDraft: true,
    })
  })

  it("unstated confidence never auto-publishes a creation", async () => {
    const client = mockClient(roadmap)
    const r = await submitRevision(ctxFor(client), {
      title: "Unsure",
      content: "x",
      filename: "notes.md",
      confidence: null,
    })
    expect(r.decision).toBe("proposal")
    expect(client.createArtifact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ privateDraft: true }),
    )
  })

  it("stamp tags ride every write as addTags", async () => {
    const client = mockClient(roadmap)
    const ctx = ctxFor(client, { stampTags: ["weekly-health", "ai"] })
    await revise(ctx, freshness)
    expect(client.publishLive).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ addTags: ["weekly-health", "ai"] }),
      expect.anything(),
    )
  })
})
