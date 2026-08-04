import { describe, expect, it } from "vitest"
import { voteCollections } from "../src/lib/collection-suggest"

// The voting math behind the picker's semantic tier: neighbors vote for the
// collections they live in at their similarity score, so one very-close neighbor can
// outrank several distant ones — a straight membership count couldn't.

describe("voteCollections", () => {
  it("sums neighbor scores per collection and ranks heaviest first", () => {
    const out = voteCollections(
      [
        { id: "a1", score: 0.9 }, // in col_x
        { id: "a2", score: 0.6 }, // in col_y
        { id: "a3", score: 0.5 }, // in col_y
      ],
      { a1: ["col_x"], a2: ["col_y"], a3: ["col_y"] },
      5,
    )
    // col_y collects 1.1 from two mid neighbors; col_x's single 0.9 loses.
    expect(out).toEqual([
      { id: "col_y", score: 1.1 },
      { id: "col_x", score: 0.9 },
    ])
  })

  it("a neighbor in several collections votes for each; unfiled neighbors vote for none", () => {
    const out = voteCollections(
      [
        { id: "a1", score: 0.8 },
        { id: "a2", score: 0.7 }, // no membership row at all
      ],
      { a1: ["col_x", "col_y"] },
      5,
    )
    expect(out.map((s) => s.id).sort()).toEqual(["col_x", "col_y"])
    expect(out[0]?.score).toBeCloseTo(0.8)
  })

  it("caps the list and breaks score ties by id so equal votes can't flap", () => {
    const out = voteCollections([{ id: "a1", score: 0.5 }], { a1: ["col_z", "col_a", "col_m"] }, 2)
    expect(out).toEqual([
      { id: "col_a", score: 0.5 },
      { id: "col_m", score: 0.5 },
    ])
  })
})
