import { describe, expect, it } from "vitest"
import { MAX_ARTIFACT_CHARS, parseRevision, REVISION_CONTRACT } from "../src/run-contract"

// The run contract, held to the same spec as the CLI's hand-copy.
//
// packages/cli/test/contract-parity.test.js asserts the identical cases against the CLI's
// implementation. Two copies exist because the CLI is a dependency-free published package and
// cannot import this module at runtime; these two test files are what stop them drifting.
//
// The cases are chosen for where a re-implementation actually diverges. Not "does valid JSON
// parse" — every copy manages that — but the forgiving branches, which are easy to write
// slightly differently and impossible to notice in production.
describe("run contract: parseRevision", () => {
  const block = (obj: unknown) => `Some preamble.\n<revision>${JSON.stringify(obj)}</revision>`

  it("accepts a well-formed block", () => {
    const out = parseRevision(
      block({ content: "# Hi", filename: "notes.md", confidence: 0.9, message: "note" }),
    )
    expect(out.revision).toEqual({
      content: "# Hi",
      filename: "notes.md",
      confidence: 0.9,
      message: "note",
    })
  })

  it("strips ``` fences the model wrapped the JSON in", () => {
    const out = parseRevision(
      '<revision>```json\n{"content":"# Hi","filename":"a.md"}\n```</revision>',
    )
    expect(out.revision?.content).toBe("# Hi")
  })

  it("falls back to index.html when the filename sets no content type", () => {
    expect(parseRevision(block({ content: "x", filename: "README" })).revision?.filename).toBe(
      "index.html",
    )
    expect(parseRevision(block({ content: "x" })).revision?.filename).toBe("index.html")
  })

  it("clamps an out-of-range confidence and nulls a non-numeric one", () => {
    // The null case matters because the value is SHOWN to people: a string "0.9" must read
    // as unstated on every substrate alike, or two readers of the same reply display two
    // different answers. Clamping, by contrast, keeps completed work rather than failing
    // a run over a model saying 1.5 when it meant "very sure".
    expect(parseRevision(block({ content: "x", confidence: 1.5 })).revision?.confidence).toBe(1)
    expect(parseRevision(block({ content: "x", confidence: -2 })).revision?.confidence).toBe(0)
    expect(
      parseRevision(block({ content: "x", confidence: "0.9" })).revision?.confidence,
    ).toBeNull()
    expect(parseRevision(block({ content: "x" })).revision?.confidence).toBeNull()
  })

  it("refuses what it must never guess", () => {
    // `content` is the one field with no safe fallback — inventing one publishes silence.
    expect(parseRevision("no block here").error).toMatch(/no <revision> block/)
    expect(parseRevision("<revision>not json</revision>").error).toMatch(/parse/)
    expect(parseRevision(block({ content: "   " })).error).toMatch(/non-empty/)
    expect(parseRevision(block({ filename: "a.md" })).error).toMatch(/non-empty/)
    expect(parseRevision(block({ content: "x".repeat(MAX_ARTIFACT_CHARS + 1) })).error).toMatch(
      /2MB/,
    )
  })

  it("the contract text names the block and forbids trailing output", () => {
    // The two properties the parser depends on. If the contract stopped asking for the block, or
    // stopped saying "NOTHING after it", parseRevision's regex would still compile and every run
    // would quietly start failing to produce one.
    expect(REVISION_CONTRACT).toContain("<revision>")
    expect(REVISION_CONTRACT).toContain("NOTHING after it")
  })
})
