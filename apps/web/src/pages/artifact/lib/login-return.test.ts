import { describe, expect, it } from "vitest"
import { artifactLoginSearch } from "./login-return"

describe("artifactLoginSearch", () => {
  it("returns to the gated workspace artifact after sign-in", () => {
    expect(
      artifactLoginSearch({
        pathname: "/artifacts/quarterly-plan-abc12345",
        search: "",
      }),
    ).toEqual({ return_to: "/artifacts/quarterly-plan-abc12345" })
  })

  it("preserves version and collaboration deep links", () => {
    expect(
      artifactLoginSearch({
        pathname: "/artifacts/quarterly-plan-abc12345@v3",
        search: "?comment=thread_1&review=proposal_2",
      }),
    ).toEqual({
      return_to: "/artifacts/quarterly-plan-abc12345@v3?comment=thread_1&review=proposal_2",
    })
  })
})
