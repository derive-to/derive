import { describe, expect, it } from "vitest"
import { keyOf, normalizeAuthor, normalizePath } from "./use-follows"

type FollowKey = Parameters<typeof keyOf>[0]
const f = (kind: FollowKey["kind"], target: string, handle: string | null = null): FollowKey => ({
  kind,
  target,
  handle,
})

describe("normalizePath", () => {
  it("appends a trailing slash so a LIKE prefix can't match a sibling", () => {
    expect(normalizePath("docs/plans")).toBe("docs/plans/")
    expect(normalizePath("docs/plans/")).toBe("docs/plans/")
  })
  it("leaves an empty path alone", () => {
    expect(normalizePath("")).toBe("")
  })
})

describe("normalizeAuthor", () => {
  it("lowercases the login (the backend matches on login.toLowerCase())", () => {
    expect(normalizeAuthor("Alice")).toBe("alice")
    expect(normalizeAuthor("OCTOCAT")).toBe("octocat")
  })
})

describe("keyOf", () => {
  it("keys a user follow by lowercased handle, falling back to target", () => {
    expect(keyOf(f("user", "ignored", "Alice"))).toBe("user:alice")
    expect(keyOf(f("user", "Bob"))).toBe("user:bob")
  })
  it("keys an author follow by lowercased login", () => {
    expect(keyOf(f("author", "OctoCat"))).toBe("author:octocat")
  })
  it("keys a path follow by slash-normalized prefix", () => {
    expect(keyOf(f("path", "docs/plans"))).toBe("path:docs/plans/")
    expect(keyOf(f("path", "docs/plans/"))).toBe("path:docs/plans/")
  })
  it("gives the same key for the two shapes of one user follow (handle vs target)", () => {
    expect(keyOf(f("user", "alice", "Alice"))).toBe(keyOf(f("user", "alice")))
  })
})
