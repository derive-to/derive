import { describe, expect, it } from "vitest"
import {
  isTransient,
  retryQuery,
  shouldPersistQuery,
  shouldToastError,
  toastMessageFor,
} from "./query-client"

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

describe("shouldToastError", () => {
  it("toasts every mutation error by default", () => {
    expect(shouldToastError(undefined)).toBe(true)
    expect(shouldToastError({})).toBe(true)
    expect(shouldToastError({ errorToast: true })).toBe(true)
  })
  it("stays silent only when a mutation explicitly opts out (errorToast:false)", () => {
    expect(shouldToastError({ errorToast: false })).toBe(false)
  })
})

describe("shouldPersistQuery", () => {
  it("persists a query's data to IndexedDB by default", () => {
    expect(shouldPersistQuery(undefined)).toBe(true)
    expect(shouldPersistQuery({})).toBe(true)
    expect(shouldPersistQuery({ persist: true })).toBe(true)
  })
  it("skips only when a query explicitly opts out (persist:false — session, token-keyed)", () => {
    expect(shouldPersistQuery({ persist: false })).toBe(false)
  })
})

describe("toastMessageFor", () => {
  it("shows the server's message for an ApiError (has a numeric status)", () => {
    expect(toastMessageFor(apiErr(409))).toBe("HTTP 409")
  })
  it("falls back to a friendly line for a network error (no status → raw 'Failed to fetch')", () => {
    expect(toastMessageFor(new TypeError("Failed to fetch"))).toMatch(/check your connection/i)
  })
  it("falls back for a non-Error throw, or an Error with no message (never a blank toast)", () => {
    expect(toastMessageFor("just a string")).toMatch(/something went wrong/i)
    expect(toastMessageFor(Object.assign(new Error(""), { status: 500 }))).toMatch(
      /something went wrong/i,
    )
  })
})
