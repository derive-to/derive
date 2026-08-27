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

describe("export_job queue", () => {
  it("deduplicates immutable inputs, leases atomically, and preserves completed output", async () => {
    const meta = new SqliteMetaStore(":memory:")
    const input = {
      id: "ex1",
      artifact_id: "a1",
      version_n: 7,
      org_id: "org1",
      requested_by: "u1",
      kind: "page_pdf" as const,
      profile: "page-pdf",
      options_json: "{}",
      input_hash: "f".repeat(64),
    }
    const first = await meta.enqueueExportJob(input)
    const replay = await meta.enqueueExportJob({ ...input, id: "ex2" })
    expect(replay.id).toBe(first.id)

    const now = "2999-01-01T00:00:00.000Z"
    const lease = "2999-01-01T00:01:00.000Z"
    const claimed = await meta.claimDueExportJobs(now, 10, lease)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ id: "ex1", version_n: 7, status: "rendering", attempts: 1 })
    expect(await meta.claimDueExportJobs(now, 10, lease)).toHaveLength(0)

    await meta.updateExportJob("ex1", {
      status: "ready",
      output_key: "a".repeat(64),
      output_type: "application/pdf",
      output_bytes: 42,
      updated_at: now,
    })
    expect(await meta.claimDueExportJobs("2999-01-01T00:02:00.000Z", 10, lease)).toHaveLength(0)
    expect(await meta.getExportJob("ex1")).toMatchObject({
      status: "ready",
      output_key: "a".repeat(64),
      output_bytes: 42,
    })
  })
})
