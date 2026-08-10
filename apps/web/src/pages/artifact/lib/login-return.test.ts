import { describe, expect, it } from "vitest"
import { artifactLoginSearch, artifactUnavailableView } from "./login-return"

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

describe("artifactUnavailableView", () => {
  const loc = {
    pathname: "/artifacts/quarterly-plan-abc12345",
    search: "?comment=thread_1",
  }

  it("signed-out: sign-in CTA with the artifact return path", () => {
    const view = artifactUnavailableView(false, loc)
    expect(view.title).toBe("This page isn’t available")
    expect(view.description).toMatch(/signing in may help/i)
    expect(view.signIn).toEqual({
      label: "Sign in to view",
      search: {
        return_to: "/artifacts/quarterly-plan-abc12345?comment=thread_1",
      },
    })
  })

  it("signed-in: not-available copy with no sign-in CTA", () => {
    const view = artifactUnavailableView(true, loc)
    expect(view.title).toBe("This page isn’t available")
    expect(view.description).toMatch(/ask whoever shared/i)
    expect(view.signIn).toBeNull()
  })
})
