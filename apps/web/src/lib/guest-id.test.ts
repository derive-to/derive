import { describe, expect, it } from "vitest"
import { guestQuery, namespaceGuest } from "./guest-id"

// `namespaceGuest` MUST reproduce the server's `guestViewerId` transform (apps/api
// context.ts) byte-for-byte, so an anonymous viewer recognises its own presence row. These
// cases mirror the server's own test (apps/api/test/realtime.test.ts "sanitizes + namespaces")
// — if one side's transform changes, one of the two suites goes red.
describe("namespaceGuest (client mirror of server guestViewerId)", () => {
  it("prefixes a clean token unchanged", () => {
    expect(namespaceGuest("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "anon_550e8400-e29b-41d4-a716-446655440000",
    )
  })
  it("strips chars outside [A-Za-z0-9_-]", () => {
    expect(namespaceGuest("usr_boss!! drop")).toBe("anon_usr_bossdrop")
  })
  it("caps the token at 40 chars", () => {
    expect(namespaceGuest("x".repeat(50))).toBe(`anon_${"x".repeat(40)}`)
  })
})

// Off a browser (SSR/prerender) there's no identity and no realtime connection, so the query
// fragment is empty and the server falls back to the view cookie.
describe("guestQuery", () => {
  it("is empty when there's no browser identity", () => {
    expect(guestQuery()).toBe("")
  })
})
