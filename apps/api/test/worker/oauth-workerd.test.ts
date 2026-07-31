import { startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js"
import { describe, expect, it } from "vitest"
import { signCapabilityToken, verifyCapabilityToken } from "../../src/lib/capability-token"
import { readCredential, serializeCredential } from "../../src/lib/mcp-oauth"

// Signing in, inside workerd. See vitest.worker.config.ts for what this lane does and does not
// prove. Everything here runs in Node already; the question is only whether it also runs where it
// is actually deployed.

const SECRET = "workerd-oauth-secret-at-least-16-chars"

describe("the sign-in path runs in workerd", () => {
  it("is actually workerd, not Node wearing its name", async () => {
    // Without this the lane can silently degrade: a config regression that ran these three tests
    // under Node would leave them all green while proving nothing they claim to prove.
    expect(navigator.userAgent).toBe("Cloudflare-Workers")
  })

  it("startAuthorization produces a PKCE S256 challenge", async () => {
    // The one dependency in this flow with a runtime-conditional build: `pkce-challenge` ships a
    // `node` variant that reaches for `node:crypto` and a browser one on Web Crypto. Which one a
    // worker bundle resolves is a question no Node test can ask.
    const { authorizationUrl, codeVerifier } = await startAuthorization("https://as.example", {
      metadata: {
        issuer: "https://as.example",
        authorization_endpoint: "https://as.example/authorize",
        token_endpoint: "https://as.example/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      } as never,
      clientInformation: { client_id: "client_abc" },
      redirectUrl: "https://derive.test/v1/connections/oauth/callback",
      scope: "read",
      resource: new URL("https://mcp.example/mcp"),
    })

    expect(codeVerifier.length).toBeGreaterThanOrEqual(43)
    const u = new URL(authorizationUrl)
    expect(u.searchParams.get("code_challenge_method")).toBe("S256")
    expect(u.searchParams.get("code_challenge")).toBeTruthy()
    // Not the verifier echoed back: S256 means the challenge is a hash of it, and a runtime where
    // the hash silently failed could otherwise look like success.
    expect(u.searchParams.get("code_challenge")).not.toBe(codeVerifier)
    expect(u.searchParams.get("resource")).toBe("https://mcp.example/mcp")
  })

  it("the signed state survives a round trip", async () => {
    // HMAC via crypto.subtle, and base64url via atob/btoa — all three exist in workerd, and the
    // state is the one thing in this flow that is neither stored nor recoverable if it breaks.
    const payload = JSON.stringify({
      connectionId: "conn_1",
      resource: "https://mcp.stripe.com",
      verifier: "v".repeat(64),
    })
    const bytes = new TextEncoder().encode(payload)
    let bin = ""
    for (const b of bytes) bin += String.fromCharCode(b)
    const packed = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")

    const token = await signCapabilityToken(
      "derive-mcp-oauth-state:",
      SECRET,
      [packed],
      Date.now() + 60_000,
    )
    const ok = await verifyCapabilityToken("derive-mcp-oauth-state:", SECRET, token, Date.now())
    expect(ok?.rest).toBe(packed)

    // A different secret must not verify, in this runtime as in the other.
    expect(
      await verifyCapabilityToken("derive-mcp-oauth-state:", `${SECRET}x`, token, Date.now()),
    ).toBeNull()
  })

  it("a credential encrypts and reads back", async () => {
    // apps/api's crypto helpers are node:crypto based (createCipheriv), which is nodejs_compat
    // territory rather than something workerd offers natively.
    const enc = serializeCredential(
      {
        v: 1,
        access_token: "at_live",
        refresh_token: "rt_live",
        token_endpoint: "https://as.example/token",
        authorization_server: "https://as.example",
        client_id: "client_abc",
      },
      SECRET,
    )
    const back = readCredential(enc, SECRET)
    expect(back.kind).toBe("oauth")
    if (back.kind === "oauth") expect(back.cred.access_token).toBe("at_live")

    // And the wrong key yields UNREADABLE, never the raw envelope — the rule that keeps our
    // ciphertext from being sent to somebody else's server as a bearer token.
    expect(readCredential(enc, "a-different-secret-at-least-16ch").kind).toBe("unreadable")
  })
})
