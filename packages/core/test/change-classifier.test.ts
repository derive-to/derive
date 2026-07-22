import { describe, expect, it } from "vitest"
import { classifyChange } from "../src/change-classifier"

const doc = (...lines: string[]) => lines.join("\n")

describe("classifyChange", () => {
  it("in-place value edits are freshness", () => {
    const before = doc("# Roadmap", "", "Status: in review", "Updated July 18, 2026", "Count: 41")
    const after = doc("# Roadmap", "", "Status: shipped", "Updated July 22, 2026", "Count: 43")
    expect(classifyChange(before, after)).toBe("freshness")
  })

  it("an identical document (or blank churn) is freshness", () => {
    const d = doc("# A", "", "body")
    expect(classifyChange(d, d)).toBe("freshness")
  })

  it("adding or removing a line is structural", () => {
    const before = doc("intro", "body")
    expect(classifyChange(before, doc("intro", "body", "a new paragraph"))).toBe("structural")
    expect(classifyChange(before, doc("intro"))).toBe("structural")
  })

  it("editing a heading is structural", () => {
    expect(classifyChange(doc("# Old title", "body"), doc("# New title", "body"))).toBe(
      "structural",
    )
  })

  it("reshaping a list is structural even at equal line count", () => {
    const before = doc("- alpha", "- beta")
    const after = doc("- alpha", "- gamma") // a list item changed
    expect(classifyChange(before, after)).toBe("structural")
  })

  it("swapping a real line for a blank one (content drop) is structural", () => {
    expect(classifyChange(doc("keep", "important line"), doc("keep", ""))).toBe("structural")
  })

  it("a multi-value freshness refresh across several lines stays freshness", () => {
    const before = doc("Revenue: $1.2M", "Users: 900", "As of: Q2")
    const after = doc("Revenue: $1.5M", "Users: 1,100", "As of: Q3")
    expect(classifyChange(before, after)).toBe("freshness")
  })
})
