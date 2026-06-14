import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { makeAuth } from "../src/auth-config"

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
  "DOCK_CROSS_SITE",
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
    const auth = makeAuth(db(), "http://dock.test", "test-secret-0123456789abcd")
    expect(auth.options.socialProviders?.google).toMatchObject({
      clientId: "gid",
      clientSecret: "gsecret",
    })
  })

  it("does not enable Google when only one of the pair is set", () => {
    process.env.GOOGLE_CLIENT_ID = "gid" // no secret
    const auth = makeAuth(db(), "http://dock.test", "test-secret-0123456789abcd")
    expect(auth.options.socialProviders?.google).toBeUndefined()
  })

  // The oidc-provider plugin (Dock as an OAuth authorization server for agents) is
  // always on; the enterprise SSO genericOAuth plugin is the one gated on OIDC_*.
  const pluginIds = (auth: ReturnType<typeof makeAuth>) =>
    (auth.options.plugins ?? []).map((p) => p.id)

  it("adds the generic-OAuth SSO plugin alongside oidc-provider when OIDC_* is set", () => {
    process.env.OIDC_ISSUER = "https://issuer.example.com/"
    process.env.OIDC_CLIENT_ID = "oid"
    process.env.OIDC_CLIENT_SECRET = "osecret"
    process.env.OIDC_PROVIDER_ID = "okta"
    const ids = pluginIds(makeAuth(db(), "http://dock.test", "test-secret-0123456789abcd"))
    expect(ids).toContain("oidc-provider")
    expect(ids).toHaveLength(2) // genericOAuth + the always-on oidc-provider
  })

  it("omits the SSO plugin when the OIDC_* trio is incomplete (oidc-provider stays)", () => {
    process.env.OIDC_ISSUER = "https://issuer.example.com/"
    // no client id/secret
    const ids = pluginIds(makeAuth(db(), "http://dock.test", "test-secret-0123456789abcd"))
    expect(ids).toEqual(["oidc-provider"])
  })

  it("applies SameSite=None;Secure cookies when DOCK_CROSS_SITE=true", () => {
    process.env.DOCK_CROSS_SITE = "true"
    const auth = makeAuth(db(), "http://dock.test", "test-secret-0123456789abcd")
    expect(auth.options.advanced?.defaultCookieAttributes).toMatchObject({
      sameSite: "none",
      secure: true,
    })
  })
})
