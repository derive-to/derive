import { describe, expect, it } from "vitest"
import { asTurns } from "../src/lib/turn-core"

// THE SHAPE EVERY LANE READS ITS HISTORY THROUGH. Worth its own tests because the failure is
// silent: a row wrongly labelled `assistant` makes the model believe it said something it never
// said, and it will then defend it. No error, no failing request, just a confidently wrong
// conversation — which is why this stopped being copied per lane.

describe("a transcript as the model reads it", () => {
  it("maps who spoke onto the role, in order", () => {
    const rows = [
      { agent: false, text: "what changed?" },
      { agent: true, text: "three docs did" },
      { agent: false, text: "which ones?" },
    ]
    expect(asTurns(rows, (r) => ({ fromAgent: r.agent, body: r.text }))).toEqual([
      { role: "user", content: "what changed?" },
      { role: "assistant", content: "three docs did" },
      { role: "user", content: "which ones?" },
    ])
  })

  it("attributes a human turn when a speaker is given, and never the agent's own", () => {
    // A comment thread can hold five people; unattributed, the model reads them as one voice and
    // answers the wrong person. The agent's own turns are never prefixed — it is not addressing
    // itself by name.
    const rows = [
      { agent: false, text: "ship it", who: "Ana" },
      { agent: true, text: "done", who: "Derive" },
    ]
    expect(asTurns(rows, (r) => ({ fromAgent: r.agent, body: r.text, speaker: r.who }))).toEqual([
      { role: "user", content: "Ana: ship it" },
      { role: "assistant", content: "done" },
    ])
  })

  it("leaves a two-party transcript unlabelled", () => {
    // Chat has exactly two participants, and prefixing there is noise the model pays for.
    const rows = [{ agent: false, text: "hello" }]
    expect(asTurns(rows, (r) => ({ fromAgent: r.agent, body: r.text, speaker: null }))).toEqual([
      { role: "user", content: "hello" },
    ])
  })

  it("survives an empty transcript", () => {
    expect(asTurns([], () => ({ fromAgent: false, body: "" }))).toEqual([])
  })
})
