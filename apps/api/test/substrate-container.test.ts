import { describe, expect, it, vi } from "vitest"
import { containerSubstrate } from "../src/lib/substrate-container"

describe("Cloudflare container substrate", () => {
  it("starts the run-named instance with the CLI's exact environment contract", async () => {
    const startRun = vi.fn(async () => undefined)
    const getByName = vi.fn(() => ({ startRun }))
    const substrate = containerSubstrate({ binding: { getByName }, timeoutMs: 123_456 })

    await substrate.start({
      runId: "run_cf_1",
      token: "dkrun_capability",
      server: "https://derive.test",
    })

    expect(getByName).toHaveBeenCalledWith("run_cf_1")
    expect(startRun).toHaveBeenCalledWith({
      DERIVE_CONTEXT: "",
      DERIVE_RUN_ID: "run_cf_1",
      DERIVE_RUNNER_ISOLATED: "1",
      DERIVE_SERVER: "https://derive.test",
      DERIVE_TOKEN: "dkrun_capability",
      RUNNER_TIMEOUT_MS: "123456",
    })
  })
})
