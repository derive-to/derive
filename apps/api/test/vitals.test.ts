import { describe, expect, it } from "vitest"
import { anonApp, json } from "./helpers"

// The Core Web Vitals collector: the SPA beacons real field metrics here. It's
// anonymous by design (any visitor's browser reports), so these run against the
// no-auth app to prove the anon-write lockdown lets the beacon through.
describe("POST /v1/vitals", () => {
  it("accepts a beacon from an anonymous visitor (204, no body)", async () => {
    const r = await anonApp.request(
      "/v1/vitals",
      json({ name: "LCP", value: 1234.5, rating: "good", id: "v1-abc", path: "/a/xyz" }),
    )
    expect(r.status).toBe(204)
    expect(await r.text()).toBe("")
  })

  it("accepts a CLS metric (a 0–1 float)", async () => {
    const r = await anonApp.request(
      "/v1/vitals",
      json({ name: "CLS", value: 0.04, rating: "good", id: "v1-cls", path: "/" }),
    )
    expect(r.status).toBe(204)
  })

  it("rejects an unknown metric name (400)", async () => {
    const r = await anonApp.request(
      "/v1/vitals",
      json({ name: "BOGUS", value: 1, rating: "good", id: "x", path: "/" }),
    )
    expect(r.status).toBe(400)
  })

  it("rejects a non-finite value (400)", async () => {
    const r = await anonApp.request(
      "/v1/vitals",
      json({ name: "INP", value: "fast", rating: "good", id: "x", path: "/" }),
    )
    expect(r.status).toBe(400)
  })
})
