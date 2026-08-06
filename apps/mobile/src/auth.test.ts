import { describe, expect, it } from "vitest"
import {
  claimScript,
  isAuthCallback,
  isAuthNavigation,
  newAuthState,
  signInUrl,
  tokenFromCallback,
} from "./auth"

const ORIGIN = "https://derive.to"

describe("isAuthNavigation: what leaves for a real browser", () => {
  // Google refuses OAuth from an embedded web view, so these must never load in-frame.
  it("catches the flow starts on our own origin", () => {
    expect(isAuthNavigation(`${ORIGIN}/api/auth/sign-in/social`, true)).toBe(true)
    expect(isAuthNavigation(`${ORIGIN}/api/auth/callback/google`, true)).toBe(true)
    expect(isAuthNavigation(`${ORIGIN}/api/auth/oauth2/authorize?x=1`, true)).toBe(true)
  })

  it("catches a provider host directly, as a safety net", () => {
    expect(isAuthNavigation("https://accounts.google.com/o/oauth2/v2/auth", false)).toBe(true)
    expect(isAuthNavigation("https://github.com/login/oauth/authorize", false)).toBe(true)
    expect(isAuthNavigation("https://appleid.apple.com/auth/authorize", false)).toBe(true)
  })
})

describe("isAuthNavigation: what must stay in the frame", () => {
  it("leaves ordinary pages alone, including /login itself", () => {
    // Hijacking these would send normal navigation out to a browser.
    expect(isAuthNavigation(`${ORIGIN}/artifacts/abc`, true)).toBe(false)
    expect(isAuthNavigation(`${ORIGIN}/settings`, true)).toBe(false)
    expect(isAuthNavigation(`${ORIGIN}/login`, true)).toBe(false)
  })

  it("is not fooled by lookalikes", () => {
    expect(isAuthNavigation("https://accounts.google.com.evil.example/x", false)).toBe(false)
    // The auth PATHS only count on an origin we host; anyone can serve that path.
    expect(isAuthNavigation("https://evil.example/api/auth/sign-in/social", false)).toBe(false)
    // A prefix match would wrongly catch /api/authx.
    expect(isAuthNavigation(`${ORIGIN}/api/authx/sign-in/social`, true)).toBe(false)
  })

  it("treats unparseable input as ordinary", () => {
    expect(isAuthNavigation("not a url", true)).toBe(false)
  })
})

describe("tokenFromCallback: the nonce binding", () => {
  const STATE = "abc123state456xyz"

  it("yields the token when the nonce is the one we sent", () => {
    expect(tokenFromCallback(`derive://auth-callback?token=tok_1&state=${STATE}`, STATE)).toBe(
      "tok_1",
    )
  })

  it("refuses a token whose nonce we did not generate", () => {
    // THE attack this exists to stop: any web page can fire a deep link, so without this
    // a crafted callback would sign the app into whoever minted that token.
    expect(tokenFromCallback("derive://auth-callback?token=attacker&state=other", STATE)).toBeNull()
    expect(tokenFromCallback("derive://auth-callback?token=attacker", STATE)).toBeNull()
  })

  it("refuses anything when no sign-in is in flight", () => {
    expect(tokenFromCallback(`derive://auth-callback?token=t&state=${STATE}`, null)).toBeNull()
  })

  it("refuses a malformed or misaddressed callback", () => {
    expect(tokenFromCallback(`derive://auth-callback?state=${STATE}`, STATE)).toBeNull()
    expect(tokenFromCallback(`derive://artifacts/x?token=t&state=${STATE}`, STATE)).toBeNull()
    expect(
      tokenFromCallback(`https://derive.to/auth-callback?token=t&state=${STATE}`, STATE),
    ).toBeNull()
    expect(tokenFromCallback("not a url", STATE)).toBeNull()
  })
})

describe("newAuthState", () => {
  it("is opaque, long, and different every time", () => {
    const a = newAuthState()
    expect(a).toMatch(/^[0-9a-f]{48}$/)
    // The web side validates the shape it echoes back (STATE_RE in apps/web); keep both
    // in step. Collisions would let one attempt's callback satisfy another.
    expect(new Set(Array.from({ length: 200 }, newAuthState)).size).toBe(200)
  })
})

describe("signInUrl", () => {
  it("carries the nonce to the page that will echo it", () => {
    expect(signInUrl(ORIGIN, "abc")).toBe("https://derive.to/login?native=abc")
  })
})

describe("claimScript", () => {
  it("JSON-encodes the token so a hostile value cannot break out of the literal", () => {
    const s = claimScript('");alert(1);//', ORIGIN)
    expect(s).toContain('\\");alert(1);//')
    expect(s).not.toContain('token: ");alert')
  })

  it("spends the token same-origin, which is the whole point", () => {
    // The request must come from the WEB VIEW, or the Set-Cookie lands in the wrong jar.
    const s = claimScript("tok", ORIGIN)
    expect(s).toContain('"/api/auth/one-time-token/verify"')
    expect(s).toContain('credentials: "include"')
  })

  it("isAuthCallback recognises the callback host", () => {
    expect(isAuthCallback("derive://auth-callback?ok=1")).toBe(true)
    expect(isAuthCallback("derive://artifacts/x")).toBe(false)
  })
})
