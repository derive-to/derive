import { describe, expect, it } from "vitest"
import { destinationsIn } from "./palette-ask"

// TAKING SOMEBODY WHERE THE ANSWER POINTS.
//
// An answer that says "Settings › Members" has told you where to go and left you to get there.
// These rows close that gap, so what they extract has to be exactly the in-app places the answer
// named — no external links, no half-parsed markdown, and nothing invented.

describe("destinations in an answer", () => {
  it("lifts the in-app links out, in the order they were written", () => {
    const md =
      "Two places: [Pricing v3](/artifacts/ab12cd34) sets the rule and [Support playbook](/artifacts/zz99yy88) has the exception."
    expect(destinationsIn(md)).toEqual([
      { label: "Pricing v3", path: "/artifacts/ab12cd34" },
      { label: "Support playbook", path: "/artifacts/zz99yy88" },
    ])
  })

  it("leaves external links in the prose, where they belong", () => {
    const md = "See [the docs](https://example.com/guide) and [Members](/settings/members)."
    expect(destinationsIn(md)).toEqual([{ label: "Members", path: "/settings/members" }])
  })

  it("offers one row per destination, even when the answer names it twice", () => {
    const md =
      "[Members](/settings/members) is where. Ask an admin on [Members](/settings/members)."
    expect(destinationsIn(md)).toHaveLength(1)
  })

  it("finds nothing in an answer that points nowhere", () => {
    expect(destinationsIn("I could not find anything about refunds you can reach.")).toEqual([])
    // A bare path in prose is not a link: the agent was told to write real markdown links, and a
    // row that guesses at unlinked text would send people to paths that were never offered.
    expect(destinationsIn("Go to /settings/members to invite someone.")).toEqual([])
  })
})
