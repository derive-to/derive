import { describe, expect, it } from "vitest"
import { anonApp } from "./helpers"

// The public capability contract the login page renders from. Previously untested; now
// that provider on/off derives from the shared config-manifest (same gate as derive
// doctor), pin that it stays public, keeps its shape, and reflects env through the model.
describe("GET /v1/auth/capabilities", () => {
  it("is public and reports the auth methods + flows this instance has", async () => {
    const res = await anonApp.request("/v1/auth/capabilities")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      password: true,
      google: expect.any(Boolean),
      github: expect.any(Boolean),
      emailVerification: expect.any(Boolean),
      passwordReset: expect.any(Boolean),
      passkey: expect.any(Boolean),
    })
  })

  it("flips a provider on from env via the shared capability model", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-id"
    process.env.GOOGLE_CLIENT_SECRET = "test-secret"
    try {
      const body = (await (await anonApp.request("/v1/auth/capabilities")).json()) as {
        google: boolean
      }
      expect(body.google).toBe(true)
    } finally {
      delete process.env.GOOGLE_CLIENT_ID
      delete process.env.GOOGLE_CLIENT_SECRET
    }
  })
})
