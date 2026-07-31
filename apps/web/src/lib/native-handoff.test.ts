import { describe, expect, it } from "vitest"
import { nativeCallbackUrl, nativeState } from "./native-handoff"

describe("nativeState", () => {
  it("reads the app's nonce", () => {
    expect(nativeState("?native=abc123XYZ_-def")).toBe("abc123XYZ_-def")
  })

  it("is absent for an ordinary web visit", () => {
    expect(nativeState("")).toBeNull()
    expect(nativeState("?return_to=/artifacts/x")).toBeNull()
  })

  it("ignores anything that is not a plain opaque token", () => {
    // The value is echoed into a URL we navigate to, so a nonce carrying a scheme,
    // whitespace or markup is refused outright rather than escaped and trusted.
    expect(nativeState("?native=javascript:alert(1)")).toBeNull()
    expect(nativeState("?native=../../evil")).toBeNull()
    expect(nativeState("?native=<script>")).toBeNull()
    expect(nativeState("?native=has%20space")).toBeNull()
    expect(nativeState("?native=short")).toBeNull()
    expect(nativeState(`?native=${"x".repeat(129)}`)).toBeNull()
  })
})

describe("nativeCallbackUrl", () => {
  it("carries the token and echoes the nonce", () => {
    expect(nativeCallbackUrl("tok_123", "state_abcdefgh")).toBe(
      "derive://auth-callback?token=tok_123&state=state_abcdefgh",
    )
  })

  it("encodes both values so neither can add parameters of its own", () => {
    const url = nativeCallbackUrl("a&b=c", "state_abcdefgh")
    expect(url).toContain("token=a%26b%3Dc")
    // Two parameters, not three: the token's own ampersand must not split the query.
    expect(url.split("&")).toHaveLength(2)
  })
})
