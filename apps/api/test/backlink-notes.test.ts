import { describe, expect, it } from "vitest"
import { backlinkNotes } from "../src/mcp-tools/find"

// The notes on a backlink answer, unit-tested because the two cases that matter most are
// the two hardest to stage end to end: a truncated answer needs five hundred linkers, and
// the empty note's job is to be indistinguishable across three different states.
describe("backlinkNotes", () => {
  it("reports a scan bound, because an omniscient caller would hit the same one", () => {
    // Truncation is caller-INDEPENDENT, so saying it discloses nothing about anyone's
    // access — and an index that silently truncates is the exact failure this surface is a
    // reaction to. The visibility filter is the opposite and is never mentioned; that
    // asymmetry is the whole rule.
    const n = backlinkNotes({ ref: "abc12345", count: 500, truncated: true, stale: 0 })
    expect(n.note).toContain("Capped at 500")
    expect(n.note).toContain("more exist")
    expect(n.note).not.toMatch(/hidden|filtered|visible|permission/i)
  })

  it("says nothing at all when the answer is whole", () => {
    const n = backlinkNotes({ ref: "abc12345", count: 3, truncated: false, stale: 0 })
    expect(n.note).toBeUndefined()
    // The steer composes with grep rather than pretending to do its job: $links records
    // THAT a reference exists, never where or why.
    expect(n.next).toContain('query:"abc12345"')
  })

  it("names both coverage gaps when empty, and confirms nothing about the target", () => {
    const n = backlinkNotes({ ref: "abc12345", count: 0, truncated: false, stale: 0 })
    expect(n.note).toContain("read once") // versions predating derivation
    expect(n.note).toContain("bundles and skills carry no facts") // the permanent gap
    expect(n.note).toContain('find(data:"$*")') // an ALREADY-gated coverage count
    // Never a steer that only makes sense for an artifact that exists: the empty answer has
    // to read identically for a real target, an underived one, and an id nobody has.
    expect(n.next).toBeUndefined()
  })

  it("reports gen skew over the rows already in the answer, and never drops them", () => {
    // An old-generation row UNDER-reports; dropping it under-reports more. So the answer
    // keeps it and says so, computed only over rows the caller can already see.
    const n = backlinkNotes({ ref: "abc12345", count: 4, truncated: false, stale: 2 })
    expect(n.note).toContain("2 of these")
    expect(n.note).toContain("earlier version of the link deriver")
  })

  it("scopes the empty note to the tag the caller narrowed by", () => {
    const n = backlinkNotes({ ref: "abc12345", count: 0, truncated: false, stale: 0, tag: "specs" })
    expect(n.note).toContain('under tag "specs"')
  })
})
