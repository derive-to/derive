import type { RunExecution } from "@derive/core"
import { describe, expect, it } from "vitest"
import type { Substrate } from "../src/lib/dispatch"
import { providerSubstrate } from "../src/lib/substrate-provider"

const execution = (provider: RunExecution["provider"]): RunExecution => ({
  version: 1,
  provider,
  location: "hosted",
  model: null,
})

const recording = (name: string) => {
  const runs: string[] = []
  const substrate: Substrate = {
    name,
    async start(input) {
      runs.push(input.runId)
    },
  }
  return { substrate, runs }
}

describe("provider substrate", () => {
  it("keeps ordinary work on the fallback and routes Codex to its machine substrate", async () => {
    const loop = recording("loop")
    const machine = recording("machine")
    const router = providerSubstrate({
      fallback: loop.substrate,
      providers: { codex: machine.substrate },
    })
    const base = { token: "dkrun_test", server: "https://derive.test" }

    await router.start({ ...base, runId: "historical" })
    await router.start({ ...base, runId: "claude", execution: execution("claude-code") })
    await router.start({ ...base, runId: "codex", execution: execution("codex") })

    expect(loop.runs).toEqual(["historical", "claude"])
    expect(machine.runs).toEqual(["codex"])
  })

  it("refuses a selected provider with no substrate instead of silently using another agent", async () => {
    const loop = recording("loop")
    const router = providerSubstrate({ fallback: loop.substrate, providers: {} })

    await expect(
      router.start({
        runId: "codex",
        token: "dkrun_test",
        server: "https://derive.test",
        execution: execution("codex"),
      }),
    ).rejects.toThrow(/no hosted substrate is configured for codex/)
    expect(loop.runs).toEqual([])
  })
})
