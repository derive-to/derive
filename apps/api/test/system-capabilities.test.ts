import { describe, expect, it } from "vitest"
import { anonApp, app } from "./helpers"

// The operator-gated config-introspection endpoint behind `derive doctor`. The gate is
// the security-sensitive part: config posture (which features are wired, which vars are
// missing) must not leak to a non-operator.
describe("GET /v1/system/capabilities", () => {
  it("returns the capability report to an operator (static token)", async () => {
    const res = await app.request("/v1/system/capabilities")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      capabilities: { id: string; label: string; status: string; missing: string[] }[]
    }
    expect(Array.isArray(body.capabilities)).toBe(true)
    const email = body.capabilities.find((c) => c.id === "email")
    expect(email).toMatchObject({
      id: "email",
      label: expect.any(String),
      status: expect.any(String),
      missing: expect.any(Array),
    })
  })

  it("forbids a non-operator (anonymous)", async () => {
    const res = await anonApp.request("/v1/system/capabilities")
    expect(res.status).toBe(403)
  })
})
