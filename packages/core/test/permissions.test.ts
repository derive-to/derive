import { describe, expect, it } from "vitest"
import { type Actor, can, effectiveRole, roleAllows } from "../src/permissions"

describe("roleAllows", () => {
  it("editors publish + approve but only owners manage", () => {
    expect(roleAllows("editor", "publish")).toBe(true)
    expect(roleAllows("editor", "approve")).toBe(true)
    expect(roleAllows("editor", "manage")).toBe(false)
    expect(roleAllows("owner", "manage")).toBe(true)
  })
  it("commenters comment + read but cannot publish or approve", () => {
    expect(roleAllows("commenter", "comment")).toBe(true)
    expect(roleAllows("commenter", "read")).toBe(true)
    expect(roleAllows("commenter", "publish")).toBe(false)
    expect(roleAllows("commenter", "approve")).toBe(false)
  })
  it("viewers only read", () => {
    expect(roleAllows("viewer", "read")).toBe(true)
    expect(roleAllows("viewer", "comment")).toBe(false)
  })
})

describe("effectiveRole resolution", () => {
  const user = (over: Partial<Actor>): Actor => ({ kind: "user", userId: "u1", ...over })

  it("per-artifact share overrides the workspace role", () => {
    expect(effectiveRole(user({ orgRole: "viewer", artifactRole: "editor" }), "org")).toBe("editor")
    expect(effectiveRole(user({ orgRole: "editor", artifactRole: "viewer" }), "org")).toBe("viewer")
  })
  it("falls back to the workspace role when there's no share", () => {
    expect(effectiveRole(user({ orgRole: "commenter" }), "org")).toBe("commenter")
  })
  it("a non-member gets viewer on public/link, nothing on private", () => {
    expect(effectiveRole(user({}), "link")).toBe("viewer")
    expect(effectiveRole(user({}), "public")).toBe("viewer")
    expect(effectiveRole(user({}), "org")).toBe(null)
    expect(effectiveRole(user({}), "password")).toBe(null)
  })
  it("a static token is owner; anon on a secured instance is read-only", () => {
    expect(effectiveRole({ kind: "token" }, "org")).toBe("owner")
    expect(effectiveRole({ kind: "anon" }, "org")).toBe(null)
    expect(effectiveRole({ kind: "anon" }, "link")).toBe("viewer")
  })
  it("an unsecured (open) instance trusts anonymous callers as owners", () => {
    expect(effectiveRole({ kind: "anon", open: true }, "org")).toBe("owner")
  })
})

describe("can", () => {
  it("an editor publishes, a commenter cannot", () => {
    expect(can({ kind: "user", artifactRole: "editor" }, "publish", "org")).toBe(true)
    expect(can({ kind: "user", artifactRole: "commenter" }, "publish", "org")).toBe(false)
    expect(can({ kind: "user", artifactRole: "commenter" }, "comment", "org")).toBe(true)
  })
  it("a link viewer reads but cannot comment", () => {
    expect(can({ kind: "anon" }, "read", "link")).toBe(true)
    expect(can({ kind: "anon" }, "comment", "link")).toBe(false)
  })
})
