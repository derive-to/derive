import { describe, expect, it } from "vitest"
import { LANDMARK_TAGS } from "./doc-text"
import { MARKS_SCRIPT } from "./marks-script"

describe("MARKS_SCRIPT", () => {
  it("wraps exactly one inline <script> tag", () => {
    expect(MARKS_SCRIPT.startsWith("<script>")).toBe(true)
    expect(MARKS_SCRIPT.trim().endsWith("</script>")).toBe(true)
    expect(MARKS_SCRIPT.split("<script>")).toHaveLength(2)
  })

  it("embeds the SAME tag set doc-text.ts's landmarkMap uses — cannot drift apart", () => {
    for (const tag of LANDMARK_TAGS) expect(MARKS_SCRIPT).toContain(tag.toUpperCase())
    // Exactly LANDMARK_TAGS.length quoted tags in the embedded JSON array, no more.
    const start = MARKS_SCRIPT.indexOf("var TAGS = ")
    const end = MARKS_SCRIPT.indexOf(";", start)
    const arrayLiteral = start >= 0 && end > start ? MARKS_SCRIPT.slice(start + 11, end) : null
    expect(arrayLiteral).toBeTruthy()
    const tags = JSON.parse(arrayLiteral as string) as string[]
    expect(tags.sort()).toEqual(LANDMARK_TAGS.map((t) => t.toUpperCase()).sort())
  })

  it("is well-formed JS (balanced braces/parens, no unterminated strings)", () => {
    const inner = MARKS_SCRIPT.slice("<script>".length, -"</script>".length)
    expect(() => new Function(inner)).not.toThrow()
  })
})
