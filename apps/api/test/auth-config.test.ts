import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { makeAuth, resolvePasskey } from "../src/auth-config"

// makeAuth wires optional identity providers off env: Google when its client
// id/secret are set, and an enterprise OIDC provider (Okta/Entra/…) via the
// generic-OAuth plugin when OIDC_* is set. These cover the provider branches that
// the same-origin test (which runs with neither set) leaves cold.
const PROVIDER_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_PROVIDER_ID",
  "DERIVE_CROSS_SITE",
] as const

const saved = Object.fromEntries(PROVIDER_ENV.map((k) => [k, process.env[k]]))
const db = () => new Database(":memory:")

afterEach(() => {
  for (const k of PROVIDER_ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe("auth-config: optional providers", () => {
  it("enables Google when GOOGLE_CLIENT_ID/SECRET are set", () => {
    process.env.GOOGLE_CLIENT_ID = "gid"
    process.env.GOOGLE_CLIENT_SECRET = "gsecret"
    const auth = makeAuth(db(), "http://derive.test", "test-secret-0123456789abcd")
    expect(auth.options.socialProviders?.google).toMatchObject({
      clientId: "gid",
      clientSecret: "gsecret",
    })
  })

  it("does not enable Google when only one of the pair is set", () => {
    process.env.GOOGLE_CLIENT_ID = "gid" // no secret
    const auth = makeAuth(db(), "http://derive.test", "test-secret-0123456789abcd")
    expect(auth.options.socialProviders?.google).toBeUndefined()
  })

  // The OAuth authorization server (oauth-provider + its jwt dependency) is always
  // on; the enterprise SSO genericOAuth plugin is the one gated on OIDC_*.
  const pluginIds = (auth: ReturnType<typeof makeAuth>) =>
    (auth.options.plugins ?? []).map((p) => p.id)

  it("adds the generic-OAuth SSO plugin alongside the OAuth server when OIDC_* is set", () => {
    process.env.OIDC_ISSUER = "https://issuer.example.com/"
    process.env.OIDC_CLIENT_ID = "oid"
    process.env.OIDC_CLIENT_SECRET = "osecret"
    process.env.OIDC_PROVIDER_ID = "okta"
    const ids = pluginIds(makeAuth(db(), "http://derive.test", "test-secret-0123456789abcd"))
    expect(ids).toContain("oauth-provider")
    // genericOAuth + passkey (same-origin ⇒ enabled) + jwt + oauth-provider
    expect(ids).toHaveLength(4)
  })

  it("omits the SSO plugin when the OIDC_* trio is incomplete (the OAuth server stays)", () => {
    process.env.OIDC_ISSUER = "https://issuer.example.com/"
    // no client id/secret
    const ids = pluginIds(makeAuth(db(), "http://derive.test", "test-secret-0123456789abcd"))
    expect([...ids].sort()).toEqual(["jwt", "oauth-provider", "passkey"])
  })

  it("applies SameSite=None;Secure cookies when DERIVE_CROSS_SITE=true", () => {
    process.env.DERIVE_CROSS_SITE = "true"
    const auth = makeAuth(db(), "http://derive.test", "test-secret-0123456789abcd")
    expect(auth.options.advanced?.defaultCookieAttributes).toMatchObject({
      sameSite: "none",
      secure: true,
    })
  })
})

describe("resolvePasskey — WebAuthn rpID/origin resolution", () => {
  afterEach(() => {
    delete process.env.DERIVE_PASSKEY_RPID
  })

  it("enables passkeys for a single-origin self-host (rpID derived, one allowed origin)", () => {
    const r = resolvePasskey({
      baseUrl: "https://derive.example",
      webOrigins: [],
      crossSite: false,
    })
    expect(r.enabled).toBe(true)
    expect(r.rpID).toBeUndefined() // let SimpleWebAuthn derive it from the origin
    expect(r.origin).toEqual(["https://derive.example"])
  })

  it("treats a different-PORT web origin (localhost dev) as same-origin (rpID=localhost)", () => {
    const r = resolvePasskey({
      baseUrl: "http://localhost:8787",
      webOrigins: ["http://localhost:3090"],
      crossSite: false,
    })
    expect(r.enabled).toBe(true)
    expect(r.rpID).toBeUndefined()
    expect(r.origin).toEqual(["http://localhost:8787", "http://localhost:3090"])
  })

  it("pins rpID to the shared registrable parent on a cross-site split, allowing both origins", () => {
    const r = resolvePasskey({
      baseUrl: "https://api.derive.to",
      webOrigins: ["https://app.derive.to"],
      crossSite: true,
    })
    expect(r.enabled).toBe(true)
    expect(r.rpID).toBe("derive.to")
    expect(r.origin).toEqual(["https://api.derive.to", "https://app.derive.to"])
  })

  it("disables passkeys when SPA + API span two different registrable domains", () => {
    const r = resolvePasskey({
      baseUrl: "https://api.derive.to",
      webOrigins: ["https://app.example.com"],
      crossSite: true,
    })
    expect(r.enabled).toBe(false)
  })

  it("honours an explicit DERIVE_PASSKEY_RPID override", () => {
    process.env.DERIVE_PASSKEY_RPID = "derive.io"
    const r = resolvePasskey({
      baseUrl: "https://api.derive.io",
      webOrigins: ["https://app.derive.io"],
      crossSite: true,
    })
    expect(r.enabled).toBe(true)
    expect(r.rpID).toBe("derive.io")
  })
})
