import { describe, expect, it } from "vitest"
import { artifactQuery, rawArtifactUrl } from "./queries"

// The regression this guards: the prefetch and the viewer frame each built the raw
// URL themselves, and they built DIFFERENT ones. The frame loads a tokenized URL
// (its opaque origin cannot send our cookie, so the token is its proof of access)
// while the prefetch warmed the tokenless form — so every signed-in open paid a
// wasted prefetch and still fetched the real bytes cold, and hover prefetching
// bought the document body nothing. One builder now, and these assertions pin the
// shape both callers depend on.
describe("rawArtifactUrl", () => {
  it("puts the token in the path, before index.html", () => {
    expect(rawArtifactUrl("abc123", 4, "tok_xyz")).toBe("/raw/abc123/v/4/t/tok_xyz/index.html")
  })

  it("omits the token segment entirely when there is none (the anon/public view)", () => {
    expect(rawArtifactUrl("abc123", 4)).toBe("/raw/abc123/v/4/index.html")
  })

  it("distinguishes versions, so a version bump is a different cache entry", () => {
    expect(rawArtifactUrl("abc123", 4, "t")).not.toBe(rawArtifactUrl("abc123", 5, "t"))
  })

  it("distinguishes tokened from tokenless — the mismatch that caused the bug", () => {
    expect(rawArtifactUrl("abc123", 4, "tok")).not.toBe(rawArtifactUrl("abc123", 4))
  })
})

describe("artifactQuery", () => {
  it("does not persist the detail record because it contains a short-lived capability", () => {
    expect(artifactQuery("abc123").meta).toEqual({ persist: false })
  })
})
