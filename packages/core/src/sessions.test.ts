import { describe, expect, it } from "vitest"
import { DEFAULT_VERSION_WINDOW_MS, groupSessions } from "./sessions"

const BASE = Date.parse("2026-01-01T00:00:00.000Z")
const at = (min: number) => new Date(BASE + min * 60_000).toISOString()
// A version record with just the fields groupSessions reads.
const mk = (n: number, min: number, author = "alice", name: string | null = null) => ({
  n,
  author,
  name,
  created_at: at(min),
})

describe("groupSessions", () => {
  it("collapses a burst of same-author revisions into one session", () => {
    const sessions = groupSessions([mk(1, 0), mk(2, 10), mk(3, 20)])
    expect(sessions).toEqual([
      // n is the latest (view this one), from_n the earliest, created_at the latest.
      { n: 3, from_n: 1, count: 3, author: "alice", name: null, created_at: at(20) },
    ])
  })

  it("starts a new session when the author changes, even within the window", () => {
    const sessions = groupSessions([mk(1, 0, "alice"), mk(2, 1, "bob")])
    // Newest-first: bob's session leads.
    expect(sessions.map((s) => ({ n: s.n, author: s.author, count: s.count }))).toEqual([
      { n: 2, author: "bob", count: 1 },
      { n: 1, author: "alice", count: 1 },
    ])
  })

  it("splits on a gap longer than the window, merges one exactly at the boundary", () => {
    // Default window is 30 min: a 30-min gap merges (<=), a 31-min gap splits.
    expect(groupSessions([mk(1, 0), mk(2, 30)])).toHaveLength(1)
    const split = groupSessions([mk(1, 0), mk(2, 31)])
    expect(split.map((s) => s.n)).toEqual([2, 1])
  })

  it("respects a custom window", () => {
    const windowMs = 5 * 60_000
    expect(groupSessions([mk(1, 0), mk(2, 4)], windowMs)).toHaveLength(1)
    expect(groupSessions([mk(1, 0), mk(2, 6)], windowMs)).toHaveLength(2)
  })

  it("pins a named checkpoint: it neither absorbs neighbors nor is absorbed", () => {
    // Same author, all within the window, but the middle one is named.
    const sessions = groupSessions([mk(1, 0), mk(2, 5, "alice", "Release"), mk(3, 10)])
    expect(sessions.map((s) => ({ n: s.n, name: s.name, count: s.count }))).toEqual([
      { n: 3, name: null, count: 1 },
      { n: 2, name: "Release", count: 1 },
      { n: 1, name: null, count: 1 },
    ])
  })

  it("is robust to unsorted input (groups by revision number, not array order)", () => {
    const shuffled = groupSessions([mk(3, 20), mk(1, 0), mk(2, 10)])
    expect(shuffled).toEqual([
      { n: 3, from_n: 1, count: 3, author: "alice", name: null, created_at: at(20) },
    ])
  })

  it("tracks from_n / count / created_at across several sessions, newest-first", () => {
    const sessions = groupSessions([
      mk(1, 0), // session A: 1..2
      mk(2, 5),
      mk(3, 200), // session B (gap): 3 alone
      mk(4, 205, "bob"), // session C (author change): 4..5
      mk(5, 210, "bob"),
    ])
    expect(sessions).toEqual([
      { n: 5, from_n: 4, count: 2, author: "bob", name: null, created_at: at(210) },
      { n: 3, from_n: 3, count: 1, author: "alice", name: null, created_at: at(200) },
      { n: 2, from_n: 1, count: 2, author: "alice", name: null, created_at: at(5) },
    ])
  })

  it("handles the empty and singleton cases", () => {
    expect(groupSessions([])).toEqual([])
    expect(groupSessions([mk(7, 0)])).toEqual([
      { n: 7, from_n: 7, count: 1, author: "alice", name: null, created_at: at(0) },
    ])
  })

  it("does not mutate the input array", () => {
    const input = [mk(2, 10), mk(1, 0)]
    const snapshot = JSON.parse(JSON.stringify(input))
    groupSessions(input)
    expect(input).toEqual(snapshot)
  })

  it("exposes a 30-minute default window", () => {
    expect(DEFAULT_VERSION_WINDOW_MS).toBe(30 * 60_000)
  })
})
