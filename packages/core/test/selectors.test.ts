import { describe, expect, it } from "vitest"
import {
  artifactTargets,
  normalizeSelector,
  normalizeSelectors,
  tagTargets,
} from "../src/selectors"

describe("normalizeSelector", () => {
  it("bare string → artifact shorthand; canonical objects pass through trimmed", () => {
    expect(normalizeSelector("dv1abc")).toEqual({ kind: "artifact", id: "dv1abc" })
    expect(normalizeSelector("  dv1abc  ")).toEqual({ kind: "artifact", id: "dv1abc" })
    expect(normalizeSelector({ kind: "collection", id: "col1" })).toEqual({
      kind: "collection",
      id: "col1",
    })
    expect(normalizeSelector({ kind: "tag", tag: " weekly " })).toEqual({
      kind: "tag",
      tag: "weekly",
    })
  })

  it("malformed values are null, never a throw", () => {
    expect(normalizeSelector("")).toBeNull()
    expect(normalizeSelector("   ")).toBeNull()
    expect(normalizeSelector(null)).toBeNull()
    expect(normalizeSelector(42)).toBeNull()
    expect(normalizeSelector({ kind: "nope", id: "x" })).toBeNull()
    expect(normalizeSelector({ kind: "tag", tag: "" })).toBeNull()
    expect(normalizeSelector({ kind: "artifact" })).toBeNull()
  })
})

describe("normalizeSelectors", () => {
  it("canonicalizes a mixed list, drops junk, dedupes by identity", () => {
    expect(
      normalizeSelectors([
        "a1",
        { kind: "tag", tag: "weekly" },
        "a1",
        { kind: "artifact", id: "a1" },
        null,
        { kind: "collection", id: "c1" },
      ]),
    ).toEqual([
      { kind: "artifact", id: "a1" },
      { kind: "tag", tag: "weekly" },
      { kind: "collection", id: "c1" },
    ])
    expect(normalizeSelectors("not-an-array")).toEqual([])
  })
})

describe("target views", () => {
  const sel = normalizeSelectors([
    "a1",
    { kind: "collection", id: "c1" },
    { kind: "tag", tag: "t" },
  ])
  it("artifactTargets = revision destinations; tagTargets = stamp labels", () => {
    expect(artifactTargets(sel)).toEqual(["a1"])
    expect(tagTargets(sel)).toEqual(["t"])
  })
})
