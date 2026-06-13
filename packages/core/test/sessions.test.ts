import { describe, expect, it } from "vitest"
import { groupSessions } from "../src/sessions"

const v = (n: number, mins: number, author = "ava", name: string | null = null) => ({
  n,
  author,
  name,
  created_at: new Date(Date.UTC(2026, 5, 12, 12, mins, 0)).toISOString(),
})
const WINDOW = 30 * 60_000

describe("groupSessions", () => {
  it("collapses a burst by the same author into one session, newest first", () => {
    const s = groupSessions([v(1, 0), v(2, 5), v(3, 9)], WINDOW)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ n: 3, from_n: 1, count: 3, author: "ava" })
  })

  it("splits when the gap exceeds the window", () => {
    const s = groupSessions([v(1, 0), v(2, 5), v(3, 50)], WINDOW)
    expect(s.map((x) => x.n)).toEqual([3, 2]) // newest first; v3 is its own session
    expect(s[1].count).toBe(2)
  })

  it("splits when the author changes", () => {
    const s = groupSessions([v(1, 0), v(2, 3, "bo")], WINDOW)
    expect(s).toHaveLength(2)
    expect(s[0]).toMatchObject({ n: 2, author: "bo", count: 1 })
  })

  it("pins a named checkpoint as its own session and never absorbs neighbors", () => {
    const s = groupSessions([v(1, 0), v(2, 3, "ava", "Final draft"), v(3, 5)], WINDOW)
    expect(s.map((x) => x.n)).toEqual([3, 2, 1])
    expect(s[1]).toMatchObject({ n: 2, name: "Final draft", count: 1 })
  })

  it("uses a rolling window (continuous edits stay one session past 30m total)", () => {
    const s = groupSessions([v(1, 0), v(2, 20), v(3, 45)], WINDOW)
    expect(s).toHaveLength(1) // each gap <= 30m even though span is 45m
    expect(s[0].count).toBe(3)
  })
})
