import { describe, expect, it } from "vitest"
import { signupSourceSearch } from "./signup-source"

describe("signupSourceSearch", () => {
  it("builds a bounded explicit handoff without browser state", () => {
    expect(signupSourceSearch("Badge", "ab12cd34", "/artifacts/doc-ab12cd34")).toEqual({
      src: "badge",
      art: "ab12cd34",
      landing: "/artifacts/doc-ab12cd34",
    })
  })

  it("drops a malformed artifact and bounds the landing path", () => {
    const source = signupSourceSearch("make_your_own", "not an id", `/${"x".repeat(400)}`)
    expect(source.art).toBeUndefined()
    expect(source.landing).toHaveLength(200)
  })

  it("rejects unbounded or markup-shaped source tokens", () => {
    expect(() => signupSourceSearch("<script>", null, "/")).toThrow("invalid signup source")
  })
})
