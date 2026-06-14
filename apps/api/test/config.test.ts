import { describe, expect, it } from "vitest"
import { loadConfig } from "../src/config"

// loadConfig should fail fast at boot on a malformed value rather than coercing it
// to a silent default (or failing lazily on the first request that touches it).
describe("config: fail-fast env validation", () => {
  const base = { PORT: "8080", BASE_URL: "http://dock.test" }

  it("accepts a clean environment", () => {
    expect(loadConfig({ ...base }).port).toBe(8080)
  })

  it("rejects a non-numeric PORT", () => {
    expect(() => loadConfig({ ...base, PORT: "nope" })).toThrow(/PORT/)
  })

  it("rejects a malformed BASE_URL", () => {
    expect(() => loadConfig({ ...base, BASE_URL: "not a url" })).toThrow(/BASE_URL/)
  })

  it("rejects a malformed DATABASE_URL instead of failing at first query", () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: "not a url" })).toThrow(/DATABASE_URL/)
  })

  it("rejects a malformed OBJECT_STORE_URL", () => {
    expect(() => loadConfig({ ...base, OBJECT_STORE_URL: "::::" })).toThrow(/OBJECT_STORE_URL/)
  })

  it("rejects a non-numeric retention window", () => {
    expect(() => loadConfig({ ...base, DOCK_ANALYTICS_RETENTION_DAYS: "abc" })).toThrow(/RETENTION/)
  })

  it("ignores an invalid quota knob (no-limit) without throwing", () => {
    // A typo'd cap is "no limit", warned not fatal — it shouldn't take the app down.
    expect(loadConfig({ ...base, DOCK_MAX_ARTIFACTS: "lots" }).maxArtifacts).toBeUndefined()
  })
})
