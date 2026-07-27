import { describe, expect, it } from "vitest"
import {
  RUN_LEASE_MS,
  RUN_MAX_ATTEMPTS,
  RUN_TIMEOUT_MS,
  RUN_TOKEN_TTL_MS,
} from "../src/lib/run-lifecycle"

// The run lifecycle clock is a SAFETY invariant, not a tuning preference. These assertions exist
// so a future "let's give runs more time" edit can't silently reopen a double-write window.
describe("run lifecycle clock", () => {
  it("orders timeout < token TTL < lease", () => {
    expect(RUN_TIMEOUT_MS).toBeLessThan(RUN_TOKEN_TTL_MS)
    expect(RUN_TOKEN_TTL_MS).toBeLessThan(RUN_LEASE_MS)
  })

  it("keeps a token alive past the executor's own deadline", () => {
    // If the token died first, a run that used its full budget could not write its own result:
    // it would do the work and then 401 at the finish line.
    expect(RUN_TOKEN_TTL_MS - RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })

  it("only reclaims a run after its previous executor is provably powerless", () => {
    // The load-bearing one. Reclaiming mints a SECOND executor for the same run; the claim is
    // status-guarded but a WRITE is an ordinary agent write and the claim does not gate it. If
    // the first executor's token were still valid at reclaim time, two processes could write the
    // same artifact. The lease must therefore outlast the token, not merely the timeout.
    expect(RUN_LEASE_MS).toBeGreaterThan(RUN_TOKEN_TTL_MS)
  })

  it("bounds retries so a permanently-failing run is given up, not looped forever", () => {
    expect(RUN_MAX_ATTEMPTS).toBeGreaterThanOrEqual(2)
    expect(RUN_MAX_ATTEMPTS).toBeLessThanOrEqual(5)
  })
})
