import { describe, expect, it } from "vitest"
import { staleAwareNumber, staleSchemaNote } from "../src/mcp-util"

// Stale-schema DETECTION. A number arriving as a string is proof the client validated
// against a tool schema cached before that parameter existed — the server coerces it (so
// the call works) and now says so, because until this nothing told an agent it was holding
// an out-of-date surface. Every earlier fix in this area made the server bend further
// around old clients, which works and does not scale.
describe("staleAwareNumber", () => {
  const track = () => {
    const seen: string[] = []
    return { seen, record: (p: string) => seen.push(p) }
  }

  it("records nothing when the client sends a real number", () => {
    const t = track()
    expect(staleAwareNumber(t.record, "wait").parse(10)).toBe(10)
    expect(t.seen).toEqual([])
  })

  it("coerces a stringified number AND records which parameter proved staleness", () => {
    const t = track()
    expect(staleAwareNumber(t.record, "wait").parse("10")).toBe(10)
    expect(t.seen).toEqual(["wait"])
  })

  it("still enforces bounds after coercing", () => {
    const t = track()
    const wait = staleAwareNumber(t.record, "wait", { int: true, min: 1, max: 30 })
    expect(wait.parse("30")).toBe(30)
    expect(() => wait.parse("31")).toThrow()
    expect(() => wait.parse("0")).toThrow()
    expect(() => wait.parse("1.5")).toThrow()
    // A value that fails validation is still a stale-schema proof: it arrived as text.
    expect(t.seen.length).toBeGreaterThan(0)
  })

  it("rejects text that is not a number at all", () => {
    const t = track()
    expect(() => staleAwareNumber(t.record, "wait").parse("soon")).toThrow()
  })
})

describe("staleSchemaNote", () => {
  it("names the parameter and the one action that fixes it", () => {
    const note = staleSchemaNote(["wait"])
    expect(note).toContain("`wait`")
    expect(note).toContain("reconnect")
    // Says the call SUCCEEDED — this is not an error, and reading it as one would be worse
    // than saying nothing.
    expect(note).toContain("It worked")
  })

  it("pluralizes when several parameters proved it", () => {
    expect(staleSchemaNote(["wait", "version"])).toContain("those parameters")
  })
})
