import { describe, expect, it } from "vitest"
import type { Collection } from "@/api"
import { digestFor } from "./collections-view"

// The digest's ordering is the first thing a reader feels on the Collections page, and
// it shipped wrong once: pure workspace recency, so a teammate's Wednesday revision put
// a shelf the viewer had never touched above the ones they work in every day.
const NOW = Date.parse("2026-08-03T12:00:00.000Z")
const days = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

const col = (over: Partial<Collection>): Collection =>
  ({
    id: `col_${Math.random().toString(36).slice(2, 8)}`,
    title: "Shelf",
    count: 1,
    ...over,
  }) as Collection

describe("digestFor", () => {
  it("your shelves outrank a teammate's fresher activity", () => {
    const theirs = col({ title: "NXT Wash", last_activity: days(1) })
    const starred = col({ title: "Marketing", starred: true, last_activity: days(3) })
    const workedIn = col({ title: "Eng Runbooks", active: true, last_activity: days(5) })
    const { week, cols } = digestFor([theirs, starred, workedIn], NOW)
    expect(week).toBe(true)
    // Involvement first (recency within it), then the rest of the workspace's week.
    expect(cols.map((c) => c.title)).toEqual(["Marketing", "Eng Runbooks", "NXT Wash"])
  })

  it("only the week qualifies, capped at five", () => {
    const inWeek = Array.from({ length: 7 }, (_, i) =>
      col({ title: `W${i}`, last_activity: days(i * 0.5) }),
    )
    const stale = col({ title: "Old", last_activity: days(30) })
    const { cols } = digestFor([stale, ...inWeek], NOW)
    expect(cols).toHaveLength(5)
    expect(cols.map((c) => c.title)).not.toContain("Old")
  })

  it("a quiet week falls back to the three most recently touched", () => {
    const shelves = [
      col({ title: "A", last_activity: days(40) }),
      col({ title: "B", last_activity: days(10) }),
      col({ title: "C", last_activity: days(90) }),
      col({ title: "D" }), // never touched — never in a digest
    ]
    const { week, cols } = digestFor(shelves, NOW)
    expect(week).toBe(false)
    expect(cols.map((c) => c.title)).toEqual(["B", "A", "C"])
  })
})
