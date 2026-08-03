import { describe, expect, it } from "vitest"
import { collectionsJson } from "../src/lib/boot-shapes"

// The Postgres collections-overview read is a bare UNION ALL — heap order, free to
// shift between requests — while the SQLite store lists newest-first. collectionsJson
// is the one funnel both stores pass through, so the wire order is pinned there:
// newest-first, id as the tiebreak. Every client sorts for display; this guarantees
// they all start from the same deterministic list.

const rec = (id: string, title: string, created_at: string) => ({
  id,
  org_id: "org1",
  title,
  created_by: "u1",
  created_at,
  workspace_access: "member" as const,
  folder_id: null,
  count: 0,
})

describe("collectionsJson", () => {
  it("serves newest-first regardless of the store's row order", () => {
    const scrambled = [
      rec("col_b", "Middle", "2026-07-15T00:00:00.000Z"),
      rec("col_a", "Oldest", "2026-07-01T00:00:00.000Z"),
      rec("col_c", "Newest", "2026-08-01T00:00:00.000Z"),
    ]
    const out = collectionsJson(scrambled, [], {}, "u1", false)
    expect(out.map((c) => c.title)).toEqual(["Newest", "Middle", "Oldest"])
  })

  it("breaks created_at ties by id, so equal timestamps can't flap between requests", () => {
    const t = "2026-08-01T00:00:00.000Z"
    const out = collectionsJson([rec("col_z", "Z", t), rec("col_a", "A", t)], [], {}, "u1", false)
    expect(out.map((c) => c.id)).toEqual(["col_a", "col_z"])
  })
})
