import { describe, expect, it } from "vitest"
import { SqliteMetaStore } from "../src/sqlite"

describe("render_job queue", () => {
  it("enqueue → claim leases + counts an attempt → update settles", async () => {
    const meta = new SqliteMetaStore(":memory:")
    await meta.enqueueRenderJob({ id: "rj1", artifact_id: "a1", version_n: 1 })
    // Use far-future timestamps so the sqlite default next_attempt_at (real wall
    // clock) is always ≤ now, regardless of when the test actually runs.
    const now = "2999-01-01T00:00:00.000Z"
    const lease = "2999-01-01T00:01:00.000Z"
    const first = await meta.claimDueRenderJobs(now, 10, lease)
    expect(first).toHaveLength(1)
    expect(first[0]?.attempts).toBe(1)
    expect(await meta.claimDueRenderJobs(now, 10, lease)).toHaveLength(0) // leased
    await meta.updateRenderJob("rj1", {
      status: "done",
      attempts: 1,
      last_error: null,
      next_attempt_at: lease,
    })
    const later = "2999-01-01T00:02:00.000Z"
    expect(await meta.claimDueRenderJobs(later, 10, lease)).toHaveLength(0) // settled
  })
})
