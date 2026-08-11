import { describe, expect, it } from "vitest"
import { isMentionHandle, isMentionQuery, mentionQueryAtEnd, mentionTokens } from "./mention-shared"

describe("mention-shared", () => {
  it("uses one handle grammar for persisted handles and incomplete picker queries", () => {
    expect(isMentionHandle("Ada_1")).toBe(true)
    expect(isMentionHandle("a-")).toBe(false)
    expect(isMentionHandle("a")).toBe(false)
    expect(isMentionQuery("ada-")).toBe(true)
    expect(isMentionQuery("ada!")).toBe(false)
  })

  it("finds prose mentions without turning email addresses or URLs into recipients", () => {
    const text = "Ask @Ada_1. Mail ada@derive.test; route (https://derive.test/users/@nobody)."
    expect(mentionTokens(text)).toEqual([{ handle: "Ada_1", start: 4, end: 10 }])
  })

  it("locates the unfinished token immediately before a caret", () => {
    expect(mentionQueryAtEnd("Please ask @Ada-")).toEqual({ query: "Ada-", start: 11, end: 16 })
    expect(mentionQueryAtEnd("email ada@derive")).toBeNull()
  })
})
