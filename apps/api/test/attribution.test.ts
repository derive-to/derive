import { describe, expect, it } from "vitest"
import { isSignupAttributionWindow, signupAttribution } from "../src/lib/attribution"

describe("cookieless signup attribution", () => {
  it("normalizes a bounded explicit signup-link source", () => {
    expect(
      signupAttribution("usr_1", "src_1", {
        source_kind: "Badge",
        source_artifact: "ab12cd34",
        landing_path: "/artifacts/doc-ab12cd34",
      }),
    ).toEqual({
      id: "src_1",
      user_id: "usr_1",
      source_kind: "badge",
      source_artifact: "ab12cd34",
      landing_path: "/artifacts/doc-ab12cd34",
      referrer: null,
    })
  })

  it("rejects an invalid source and minimizes optional fields", () => {
    expect(signupAttribution("usr_1", "src_1", { source_kind: "<script>" })).toBeNull()
    expect(
      signupAttribution("usr_1", "src_1", {
        source_kind: "docs_home",
        source_artifact: "not an id",
        landing_path: "https://tracker.example/person",
      }),
    ).toMatchObject({ source_artifact: null, landing_path: null, referrer: null })
  })

  it("accepts only the short post-creation window", () => {
    const now = Date.parse("2026-08-14T12:00:00.000Z")
    expect(isSignupAttributionWindow("2026-08-14T11:45:00.000Z", now)).toBe(true)
    expect(isSignupAttributionWindow("2026-08-14T11:29:59.000Z", now)).toBe(false)
    expect(isSignupAttributionWindow("not-a-date", now)).toBe(false)
  })
})
