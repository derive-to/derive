import { describe, expect, it } from "vitest"
import { takeFromSearch } from "./one-shot-params"

describe("takeFromSearch", () => {
  it("takes only the named params and reports the rest", () => {
    const { taken, rest } = takeFromSearch("?checkout=success&tab=plans", ["checkout"])
    expect(taken).toEqual({ checkout: "success" })
    expect(rest).toBe("tab=plans")
  })

  it("takes several params in one pass (the gh_install + gh_error shape)", () => {
    const { taken, rest } = takeFromSearch("?gh_install=123&gh_error=denied", [
      "gh_install",
      "gh_error",
    ])
    expect(taken).toEqual({ gh_install: "123", gh_error: "denied" })
    expect(rest).toBe("")
  })

  it("reports nothing taken when the param is absent", () => {
    const { taken, rest } = takeFromSearch("?tab=plans", ["checkout"])
    expect(taken).toEqual({})
    expect(rest).toBe("tab=plans")
  })

  it("keeps an empty-but-present value (?new-workspace=) distinct from absent", () => {
    const { taken } = takeFromSearch("?new-workspace=", ["new-workspace"])
    expect(taken).toEqual({ "new-workspace": "" })
  })

  it("takes every occurrence of a repeated param, not just the first", () => {
    const { taken, rest } = takeFromSearch("?connected=1&connected=2&x=y", ["connected"])
    expect(taken).toEqual({ connected: "1" })
    expect(rest).toBe("x=y")
  })

  it("handles a search string without the leading question mark", () => {
    const { taken, rest } = takeFromSearch("connected=1", ["connected"])
    expect(taken).toEqual({ connected: "1" })
    expect(rest).toBe("")
  })
})
