import { describe, expect, it } from "vitest"
import { SqliteMetaStore } from "../src/sqlite"

// WP5 — the freshness contract's safety property: a due living artifact is claimed
// exactly once under a lease, so two executor replicas never maintain it at once.
describe("living_artifact claim/lease", () => {
  const seed = async () => {
    const meta = new SqliteMetaStore(":memory:")
    await meta.setLivingArtifact({
      artifact_id: "art1",
      org_id: "default",
      maintainer_agent_id: "ag1",
      cadence_seconds: 3600,
      freshness_window_seconds: 0,
      route: "auto",
      // Already due (past).
      next_due_at: "2000-01-01T00:00:00.000Z",
    })
    return meta
  }

  it("claims a due row once, then nothing until the lease lapses", async () => {
    const meta = await seed()
    const now = "2100-01-01T00:00:00.000Z"
    const first = await meta.claimDueLivingArtifacts("ag1", now, 5 * 60_000)
    expect(first).toHaveLength(1)
    expect(first[0]?.leased_until).toBe("2100-01-01T00:05:00.000Z")
    // A second claim during the lease gets nothing.
    expect(await meta.claimDueLivingArtifacts("ag1", now, 5 * 60_000)).toHaveLength(0)
    // After the lease lapses, it's claimable again (a crashed run must not strand it).
    const later = "2100-01-01T00:06:00.000Z"
    expect(await meta.claimDueLivingArtifacts("ag1", later, 5 * 60_000)).toHaveLength(1)
  })

  it("only hands work to the maintainer that owns it", async () => {
    const meta = await seed()
    const now = "2100-01-01T00:00:00.000Z"
    expect(await meta.claimDueLivingArtifacts("ag2", now, 60_000)).toHaveLength(0)
    expect(await meta.claimDueLivingArtifacts("ag1", now, 60_000)).toHaveLength(1)
  })

  it("settle rolls next_due forward and clears the lease", async () => {
    const meta = await seed()
    const now = "2100-01-01T00:00:00.000Z"
    await meta.claimDueLivingArtifacts("ag1", now, 60_000)
    const nextDue = "2100-01-01T01:00:00.000Z"
    const settled = await meta.settleLivingArtifact("art1", "ag1", now, nextDue)
    expect(settled?.last_settled_at).toBe(now)
    expect(settled?.next_due_at).toBe(nextDue)
    expect(settled?.leased_until).toBeNull()
    // Not due again until nextDue.
    expect(await meta.claimDueLivingArtifacts("ag1", now, 60_000)).toHaveLength(0)
    expect(await meta.claimDueLivingArtifacts("ag1", nextDue, 60_000)).toHaveLength(1)
  })

  it("a wrong maintainer can't settle", async () => {
    const meta = await seed()
    expect(
      await meta.settleLivingArtifact(
        "art1",
        "ag2",
        "2100-01-01T00:00:00.000Z",
        "2100-01-01T01:00:00.000Z",
      ),
    ).toBeNull()
  })
})
