import { describe, expect, it } from "vitest"
import type { Collection } from "@/api"
import { digestFor } from "./collections-view"

// The digest's ordering is the first thing a reader feels on the Collections page, and
// it shipped wrong TWICE: first pure workspace recency (a teammate's Wednesday revision
// put a shelf the viewer never touched above the ones they work in daily), then an
// involvement TIER that still ordered by workspace time inside it. The rule, from the
// user, verbatim: the collections I personally touched latest, within the last 30 days,
// at the top — and a heavy reader stars.
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
  it("your shelves lead, ordered by YOUR latest touch — not the workspace's", () => {
    // A teammate revised NXT Wash yesterday; the viewer touched Runbooks after
    // Marketing. The viewer's shelves come first, in the viewer's own order.
    const theirs = col({ title: "NXT Wash", last_activity: days(1) })
    const marketing = col({
      title: "Marketing",
      my_last_activity: days(6),
      last_activity: days(1),
    })
    const runbooks = col({
      title: "Eng Runbooks",
      my_last_activity: days(2),
      last_activity: days(9),
    })
    const { week, cols } = digestFor([theirs, marketing, runbooks], NOW)
    expect(week).toBe(true)
    expect(cols.map((c) => c.title)).toEqual(["Eng Runbooks", "Marketing", "NXT Wash"])
  })

  it("a star is the reader's opt-in: starred rides the top tier without a touch", () => {
    const starred = col({ title: "Reading", starred: true, last_activity: days(4) })
    const touched = col({ title: "Writing", my_last_activity: days(2), last_activity: days(2) })
    const theirs = col({ title: "Theirs", last_activity: days(1) })
    const { cols } = digestFor([theirs, starred, touched], NOW)
    expect(cols.map((c) => c.title)).toEqual(["Writing", "Reading", "Theirs"])
  })

  it("teammate shelves need week-fresh activity; your touches carry the 30-day window", () => {
    // The server only sends my_last_activity inside its own 30-day window, so an old
    // personal touch still leads a fresher teammate shelf.
    const oldMine = col({ title: "Mine", my_last_activity: days(25), last_activity: days(25) })
    const staleTheirs = col({ title: "StaleTheirs", last_activity: days(10) })
    const freshTheirs = col({ title: "FreshTheirs", last_activity: days(2) })
    const { cols } = digestFor([staleTheirs, freshTheirs, oldMine], NOW)
    expect(cols.map((c) => c.title)).toEqual(["Mine", "FreshTheirs"])
  })

  it("caps at five, yours before theirs", () => {
    const mine = Array.from({ length: 4 }, (_, i) =>
      col({ title: `M${i}`, my_last_activity: days(i + 1) }),
    )
    const theirs = Array.from({ length: 3 }, (_, i) =>
      col({ title: `T${i}`, last_activity: days(i + 0.5) }),
    )
    const { cols } = digestFor([...theirs, ...mine], NOW)
    expect(cols).toHaveLength(5)
    expect(cols.map((c) => c.title)).toEqual(["M0", "M1", "M2", "M3", "T0"])
  })

  it("a quiet month falls back to the three most recently touched", () => {
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
