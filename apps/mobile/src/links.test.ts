import { describe, expect, it } from "vitest"
import { isInternal, webUrlFromDeepLink } from "./links"

// Deep-link resolution is the shell's one piece of security-relevant logic: a deep link is
// UNTRUSTED input that decides what the app frame shows. Any web page can fire one.
const ORIGIN = "https://derive.to"
const ALLOWED = [ORIGIN]
const resolve = (link: string) => webUrlFromDeepLink(link, ORIGIN, ALLOWED)

describe("webUrlFromDeepLink: what it accepts", () => {
  it("unwraps a whole https url handed over by the web side", () => {
    expect(resolve("derive://open?url=https%3A%2F%2Fderive.to%2Fartifacts%2Fabc")).toBe(
      "https://derive.to/artifacts/abc",
    )
  })

  it("keeps the nested query intact, so a comment anchor survives", () => {
    expect(
      resolve("derive://open?url=https%3A%2F%2Fderive.to%2Fartifacts%2Fabc%3Fcomment%3Dc_1"),
    ).toBe("https://derive.to/artifacts/abc?comment=c_1")
  })

  it("accepts the bare hand-written form", () => {
    expect(resolve("derive://artifacts/abc")).toBe("https://derive.to/artifacts/abc")
  })

  it("sends a bare scheme to the home screen", () => {
    expect(resolve("derive://open")).toBe(ORIGIN)
    expect(resolve("derive://")).toBe(ORIGIN)
  })

  it("passes through an https link on an origin we host (a universal link)", () => {
    expect(resolve("https://derive.to/favorites")).toBe("https://derive.to/favorites")
  })
})

describe("webUrlFromDeepLink: what it refuses", () => {
  // Each of these would otherwise point the app frame somewhere we do not host.
  it("refuses an off-origin target smuggled through ?url=", () => {
    expect(resolve("derive://open?url=https%3A%2F%2Fevil.example%2Fx")).toBeNull()
  })

  it("refuses a javascript: payload", () => {
    expect(resolve("derive://open?url=javascript%3Aalert(1)")).toBeNull()
  })

  it("refuses a suffix lookalike, not just a different host", () => {
    // derive.to.evil.example ENDS WITH nothing we trust, but reads like it does. A naive
    // `startsWith`/`includes` check would let this through.
    expect(resolve("derive://open?url=https%3A%2F%2Fderive.to.evil.example%2Fx")).toBeNull()
  })

  it("refuses an off-origin https link outright", () => {
    expect(resolve("https://evil.example/x")).toBeNull()
  })

  it("refuses the auth callback as a navigation", () => {
    // That host means "the auth browser finished", never "show this page".
    expect(resolve("derive://auth-callback?token=abc&state=xyz")).toBeNull()
  })

  it("refuses input that will not parse", () => {
    expect(resolve("not a url")).toBeNull()
    expect(resolve("")).toBeNull()
  })
})

describe("isInternal", () => {
  it("is true only for an exact origin match", () => {
    expect(isInternal("https://derive.to/anything", ALLOWED)).toBe(true)
    expect(isInternal("https://evil.example", ALLOWED)).toBe(false)
    expect(isInternal("https://derive.to.evil.example", ALLOWED)).toBe(false)
    // A different scheme is a different origin, so http is not the https we allow.
    expect(isInternal("http://derive.to", ALLOWED)).toBe(false)
  })

  it("treats unparseable input as external, which is the safe default", () => {
    expect(isInternal("not a url", ALLOWED)).toBe(false)
  })
})
