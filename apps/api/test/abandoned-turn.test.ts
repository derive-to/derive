import { describe, expect, it } from "vitest"
import { isAbandoned, TURN_DEADLINE_MS } from "../src/lib/abandoned-turn"

// THE JUDGEMENT BEHIND THE REAPER, on its own, because it is the half that must never be wrong
// in the dangerous direction. Reaping a live turn destroys an answer somebody is waiting for and
// has already paid for; leaving a dead one costs a spinner. Every ambiguous case below therefore
// resolves to "leave it alone".

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0)
const agoMs = (ms: number) => new Date(NOW - ms).toISOString()

describe("deciding a turn is gone rather than slow", () => {
  it("reaps a working turn past the deadline", () => {
    expect(isAbandoned("working", agoMs(TURN_DEADLINE_MS + 1), NOW)).toBe(true)
  })

  it("leaves a working turn that is merely slow", () => {
    // The model call alone is capped at 120s and a turn may make several plus tool time, so a
    // turn minutes in is ordinary, not broken.
    expect(isAbandoned("working", agoMs(2 * 60_000), NOW)).toBe(false)
    expect(isAbandoned("working", agoMs(TURN_DEADLINE_MS - 1), NOW)).toBe(false)
  })

  it("never touches a state that is not working", () => {
    // "open" especially: a context ask legitimately sits open waiting on a HUMAN, and reaping
    // those would delete other people's pending work rather than recover anything.
    for (const state of ["open", "answered", "failed", "closed", "escalated"])
      expect(isAbandoned(state, agoMs(TURN_DEADLINE_MS * 10), NOW)).toBe(false)
  })

  it("treats a missing or unparseable timestamp as NOT evidence", () => {
    expect(isAbandoned("working", null, NOW)).toBe(false)
    expect(isAbandoned("working", undefined, NOW)).toBe(false)
    expect(isAbandoned("working", "not a date", NOW)).toBe(false)
  })

  it("does not reap a turn stamped in the future", () => {
    // Clock skew between a writer and a reader is real, and it must not read as age.
    expect(isAbandoned("working", new Date(NOW + 60_000).toISOString(), NOW)).toBe(false)
  })
})
