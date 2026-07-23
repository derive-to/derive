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

const mockFetch = (runs: unknown[] = claimBody.runs) => {
  const finishes: Finish[] = []
  // Per-run injected finish failures: the first N finish POSTs for that id 500.
  const finishFails = new Map<string, number>()
  const failFinishTimes = (id: string, times: number) => finishFails.set(id, times)
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes("/v1/agent/runs/claim"))
      return new Response(JSON.stringify({ runs }), { status: 200 })
    const m = u.match(/\/v1\/agent\/runs\/([^/]+)\/finish/)
    if (m) {
      const id = m[1] as string
      const left = finishFails.get(id) ?? 0
      if (left > 0) {
        finishFails.set(id, left - 1)
        return new Response("boom", { status: 500 })
      }
      finishes.push({ id, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ id, status: "ok" }), { status: 200 })
    }
    return new Response("", { status: 404 })
  })
  vi.stubGlobal("fetch", fetchMock)
  return { finishes, fetchMock, failFinishTimes }
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

    expect(res).toEqual({ claimed: 2, finished: 1, failed: 1, finishFailures: 0 })
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

  it("never runs an empty instruction — finishes it failed/cancelled without a model call", async () => {
    const { finishes } = mockFetch([
      {
        id: "r9",
        reason: "manual:u1",
        automation_id: "gone",
        instruction: "   ",
        refs: [],
        autonomy: "suggest",
        flags: { agentKillswitch: false, agentAutoEnabled: false },
      },
    ])
    const runOne = vi.fn<RunOne>(async () => {})
    const res = await drainRuns(deps(runOne))
    expect(runOne).not.toHaveBeenCalled()
    expect(res).toEqual({ claimed: 1, finished: 0, failed: 1, finishFailures: 0 })
    expect(finishes[0]?.body.status).toBe("failed")
    expect(finishes[0]?.body.meta?.outcome).toBe("cancelled")
  })

  it("retries a failed finish once; a double failure is counted, never passed off as finished", async () => {
    const { finishes, failFinishTimes } = mockFetch()
    // r1's finish: fail once then succeed (retry covers it). r2's: fail both attempts.
    failFinishTimes("r1", 1)
    failFinishTimes("r2", 2)
    const res = await drainRuns(deps(async () => {}))
    expect(res.finishFailures).toBe(1)
    // r1 got a successful finish on the retry.
    expect(finishes.some((f) => f.id === "r1")).toBe(true)
  })

  it("a hung run is timed out, finished failed, and the drain moves on", async () => {
    const { finishes } = mockFetch()
    const runOne = vi.fn<RunOne>(async (_ctx, task) => {
      // r1's task hangs well past the ceiling; r2 returns immediately.
      if (task.includes("roadmap")) await new Promise((r) => setTimeout(r, 500))
    })
    const res = await drainRuns({ ...deps(runOne), runTimeoutMs: 50 })
    expect(res).toEqual({ claimed: 2, finished: 1, failed: 1, finishFailures: 0 })
    expect(finishes.find((f) => f.id === "r1")?.body.status).toBe("failed")
    expect(finishes.find((f) => f.id === "r2")?.body.status).toBe("succeeded")
  })
})
