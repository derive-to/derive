import { afterEach, describe, expect, it, vi } from "vitest"
import { drainRuns, type RunOne } from "../src/drain"

// The executor loop: claim due runs → run each through the harness → finish it. We mock the
// HTTP surface (claim + finish) and inject the per-run executor, so the loop's orchestration
// is tested end to end without a live model: right task, best-effort per run, terminal finish.

const claimBody = {
  runs: [
    {
      id: "r1",
      reason: "manual:u1",
      automation_id: "a1",
      instruction: "keep the roadmap current",
      refs: ["road1"],
      autonomy: "suggest",
      flags: { agentKillswitch: false, agentAutoEnabled: false },
    },
    {
      id: "r2",
      reason: "schedule",
      automation_id: "a2",
      instruction: "boom",
      refs: [],
      autonomy: "auto",
      flags: { agentKillswitch: false, agentAutoEnabled: true },
    },
  ],
}

type Finish = { id: string; body: { status: string; meta?: { outcome?: string } } }

const mockFetch = () => {
  const finishes: Finish[] = []
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes("/v1/agent/runs/claim"))
      return new Response(JSON.stringify(claimBody), { status: 200 })
    const m = u.match(/\/v1\/agent\/runs\/([^/]+)\/finish/)
    if (m) {
      finishes.push({ id: m[1] as string, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ id: m[1], status: "ok" }), { status: 200 })
    }
    return new Response("", { status: 404 })
  })
  vi.stubGlobal("fetch", fetchMock)
  return { finishes, fetchMock }
}

const deps = (runOne: RunOne) => ({
  server: "http://api.test",
  agentToken: "tok",
  manifest: "You are an agent.",
  resolveModel: () => ({}) as never,
  runOne,
})

afterEach(() => vi.unstubAllGlobals())

describe("drainRuns", () => {
  it("claims runs, runs each with its task, and finishes them; one failure doesn't stall the drain", async () => {
    const { finishes } = mockFetch()
    // r1 succeeds; r2 ("boom") throws — the executor finishes it failed and keeps going.
    const runOne = vi.fn<RunOne>(async (_ctx, task) => {
      if (task.includes("boom")) throw new Error("model exploded")
    })

    const res = await drainRuns(deps(runOne))

    expect(res).toEqual({ claimed: 2, finished: 1, failed: 1 })
    // The task carries the instruction + refs as context.
    expect(runOne.mock.calls[0]?.[1]).toContain("keep the roadmap current")
    expect(runOne.mock.calls[0]?.[1]).toContain("road1")
    // Both runs reached a terminal finish, with the right status each.
    expect(finishes).toHaveLength(2)
    expect(finishes.find((f) => f.id === "r1")?.body.status).toBe("succeeded")
    expect(finishes.find((f) => f.id === "r2")?.body.status).toBe("failed")
  })

  it("maps a run with no submit to an 'answered' outcome", async () => {
    const { finishes } = mockFetch()
    // A run that does nothing (never calls submit) leaves ctx.lastResult undefined.
    const res = await drainRuns(deps(async () => {}))
    expect(res.finished).toBe(2)
    expect(finishes.every((f) => f.body.meta?.outcome === "answered")).toBe(true)
  })
})
