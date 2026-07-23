import { describe, expect, it } from "vitest"
import {
  artifactTargets,
  normalizeSelector,
  normalizeSelectors,
  tagTargets,
  writeModes,
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

describe("write modes", () => {
  it("mode survives normalize only as the explicit publish opt-in", () => {
    expect(normalizeSelector({ kind: "artifact", id: "a1", mode: "publish" })).toEqual({
      kind: "artifact",
      id: "a1",
      mode: "publish",
    })
    // propose is the default — canonical form omits it; junk modes are dropped too.
    expect(normalizeSelector({ kind: "artifact", id: "a1", mode: "propose" })).toEqual({
      kind: "artifact",
      id: "a1",
    })
    expect(normalizeSelector({ kind: "tag", tag: "t", mode: "yolo" })).toEqual({
      kind: "tag",
      tag: "t",
    })
  })

  it("writeModes: per-artifact consent, and create follows any publishing container", () => {
    const m = writeModes(
      normalizeSelectors([
        { kind: "artifact", id: "a1", mode: "publish" },
        "a2",
        { kind: "tag", tag: "weekly" },
      ]),
    )
    expect(m).toEqual({ byArtifact: { a1: "publish", a2: "propose" }, create: "propose" })
    const pub = writeModes(normalizeSelectors([{ kind: "tag", tag: "weekly", mode: "publish" }]))
    expect(pub.create).toBe("publish")
  })
})
