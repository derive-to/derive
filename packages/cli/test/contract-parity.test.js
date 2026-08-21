import { describe, expect, it } from "vitest"
import { REVISION_CONTRACT as CORE_REVISION_CONTRACT } from "../../core/src/run-contract"
import { parseRevision, REVISION_CONTRACT } from "../src/runner.js"

// CONTRACT PARITY — the CLI's revision contract must match @derive/core's run-contract.ts.
//
// Two executors read this contract: the CLI runner (a coding agent in a container) and the
// in-Worker agent loop. They must ask for the same thing in the same words and read the reply
// the same way, or "runs in a container" and "runs in a Worker" stop being the same product and
// routing between them on cost becomes a behaviour change rather than a routing decision.
//
// The CLI keeps a hand-copy because it is a dependency-free published package and cannot import
// the TS core at RUNTIME. This test can (vitest transforms the sibling package's source), so the
// comparison below is against core's actual string — never a copy pasted in here, because a
// copy-to-copy comparison can be "fixed" on the wrong side and enforce the drift it exists to
// prevent. A relative import, not a workspace dependency: the runner image npm-installs this
// package's manifest verbatim, and npm has no workspace protocol.
//
// The cases below are the ones where a re-implementation actually drifts. Not "does it parse
// valid JSON" — every copy does that — but the forgiving branches, which are easy to write
// slightly differently and impossible to notice: fenced blocks, a filename with no extension,
// an out-of-range confidence, a non-numeric confidence.
describe("revision contract: parity with @derive/core", () => {
  const block = (obj) => `Some preamble.\n<revision>${JSON.stringify(obj)}</revision>`

  it("the contract TEXT is byte-identical to core's", () => {
    expect(REVISION_CONTRACT).toBe(CORE_REVISION_CONTRACT)
  })

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
    // A filename with no extension would publish an artifact the viewer cannot render, so this
    // is corrected rather than rejected — the work itself is fine.
    expect(parseRevision(block({ content: "x", filename: "README" })).revision?.filename).toBe(
      "index.html",
    )
    expect(parseRevision(block({ content: "x" })).revision?.filename).toBe("index.html")
  })

  it("clamps an out-of-range confidence and nulls a non-numeric one", () => {
    // Clamped, not rejected: a model saying 1.5 means "very sure", and failing the run would
    // throw away completed work. A STRING confidence must read as UNSTATED (null) on both
    // substrates alike — the value is shown to people, and a copy that coerced "0.9" while
    // the other read null would display two different answers for one reply.
    expect(parseRevision(block({ content: "x", confidence: 1.5 })).revision?.confidence).toBe(1)
    expect(parseRevision(block({ content: "x", confidence: -2 })).revision?.confidence).toBe(0)
    expect(
      parseRevision(block({ content: "x", confidence: "0.9" })).revision?.confidence,
    ).toBeNull()
    expect(parseRevision(block({ content: "x" })).revision?.confidence).toBeNull()
  })

  it("refuses what it must never guess", () => {
    // content is the one field with no safe fallback: inventing one publishes silence.
    expect(parseRevision("no block here").error).toMatch(/no <revision> block/)
    expect(parseRevision("<revision>not json</revision>").error).toMatch(/parse/)
    expect(parseRevision(block({ content: "   " })).error).toMatch(/non-empty/)
    expect(parseRevision(block({ filename: "a.md" })).error).toMatch(/non-empty/)
    expect(parseRevision(block({ content: "x".repeat(2_000_001) })).error).toMatch(/2MB/)
  })
})
