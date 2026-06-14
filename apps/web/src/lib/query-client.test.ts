import { describe, expect, it } from "vitest"
import { isTransient, retryQuery } from "./query-client"

// The resilience seam: transient failures self-heal, client errors fail fast.
const apiErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })

describe("isTransient", () => {
  it("treats 4xx (auth, not-found, conflict) as non-transient", () => {
    for (const s of [400, 401, 403, 404, 409, 429]) expect(isTransient(apiErr(s))).toBe(false)
  })
  it("treats 5xx as transient", () => {
    for (const s of [500, 502, 503]) expect(isTransient(apiErr(s))).toBe(true)
  })
  it("treats a network/unknown error (no status) as transient", () => {
    expect(isTransient(new TypeError("Failed to fetch"))).toBe(true)
    expect(isTransient(undefined)).toBe(true)
  })
})

describe("retryQuery", () => {
  it("retries transient failures up to 3 times then stops", () => {
    expect(retryQuery(0, apiErr(503))).toBe(true)
    expect(retryQuery(2, apiErr(503))).toBe(true)
    expect(retryQuery(3, apiErr(503))).toBe(false)
  })
  it("never retries a 404/403", () => {
    expect(retryQuery(0, apiErr(404))).toBe(false)
    expect(retryQuery(0, apiErr(403))).toBe(false)
  })
})
