import { describe, expect, it } from "vitest"
import { applyDelta, EMPTY_DELTA, supersededBy } from "./session-delta"

// These rules used to live inline in two components, written two different ways, and one of
// them was wrong in a way only a second question in a conversation would reveal. That is the
// shape of bug a node-environment unit test catches and a hand-test does not.

const ev = (o: Record<string, unknown>) => JSON.stringify({ type: "session.delta", ...o })
const S = "ses_1"

describe("applying a slice", () => {
  it("appends in order", () => {
    let s = EMPTY_DELTA
    s = applyDelta(s, ev({ session_id: S, seq: 1, text: "Hello", attempt: 1 }), S)
    s = applyDelta(s, ev({ session_id: S, seq: 2, text: ", world", attempt: 1 }), S)
    expect(s.text).toBe("Hello, world")
    expect(s.seq).toBe(2)
  })

  it("ignores a redelivered slice, so a reconnect is not duplicated text", () => {
    const s = applyDelta(EMPTY_DELTA, ev({ session_id: S, seq: 1, text: "once", attempt: 1 }), S)
    const again = applyDelta(s, ev({ session_id: S, seq: 1, text: "once", attempt: 1 }), S)
    expect(again).toBe(s) // same object: nothing to re-render
    expect(again.text).toBe("once")
  })

  it("drops a slice that arrives late rather than inserting it in the wrong place", () => {
    // Publishes go through one Durable Object fetch each and can overtake one another. A gap
    // the settled transcript repairs beats visibly scrambled prose.
    let s = EMPTY_DELTA
    s = applyDelta(s, ev({ session_id: S, seq: 1, text: "a", attempt: 1 }), S)
    s = applyDelta(s, ev({ session_id: S, seq: 3, text: "c", attempt: 1 }), S)
    const late = applyDelta(s, ev({ session_id: S, seq: 2, text: "b", attempt: 1 }), S)
    expect(late).toBe(s)
    expect(late.text).toBe("ac")
  })

  it("a new attempt REPLACES, because the abandoned one never reaches the transcript", () => {
    let s = EMPTY_DELTA
    s = applyDelta(s, ev({ session_id: S, seq: 1, text: "bad attempt", attempt: 1 }), S)
    s = applyDelta(s, ev({ session_id: S, seq: 2, text: "the real answer", attempt: 2 }), S)
    expect(s.text).toBe("the real answer")
    expect(s.text).not.toContain("bad attempt")
  })

  it("ignores another session's slice", () => {
    const s = applyDelta(EMPTY_DELTA, ev({ session_id: "ses_other", seq: 1, text: "x" }), S)
    expect(s).toBe(EMPTY_DELTA)
  })

  it("ignores everything when no session is open", () => {
    expect(applyDelta(EMPTY_DELTA, ev({ session_id: S, seq: 1, text: "x" }), null)).toBe(
      EMPTY_DELTA,
    )
  })
})

describe("when the streamed text is superseded", () => {
  it("clears on a NEW agent message, not on one that was already there", () => {
    // The bug: "does the transcript contain an agent message" is permanently true from the
    // second question onward, so every poll during a follow-up wiped the reply mid-write.
    expect(supersededBy(1, 0)).toBe(true) // the first answer just landed
    expect(supersededBy(1, 1)).toBe(false) // turn 2 streaming, turn 1's answer still sitting there
    expect(supersededBy(2, 1)).toBe(true) // turn 2's answer landed
    expect(supersededBy(0, 0)).toBe(false)
  })
})
