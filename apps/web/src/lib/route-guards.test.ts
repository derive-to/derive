import { beforeEach, describe, expect, it, vi } from "vitest"
import { needsOnboarding } from "./route-guards"
import { STORAGE_KEYS } from "./storage-keys"

// The suite runs in the node environment — stub the one browser API the predicate reads.
const store = new Map<string, string>()
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

// The first-run predicate. The critical pin: the localStorage fast-path cache is
// PER-BROWSER, so it must only vouch for the account that wrote it — a brand-new
// second account created in a browser where an earlier account finished onboarding
// must still be routed to /welcome (the prod bug this fixed: the gate silently
// skipped for any account after the first).
describe("needsOnboarding", () => {
  beforeEach(() => localStorage.clear())

  it("gates a fresh account (no flag, no profession, no cache)", () => {
    expect(needsOnboarding({ id: "u_new", onboarded: false, profession: null })).toBe(true)
  })

  it("never gates once the server flag is set", () => {
    expect(needsOnboarding({ id: "u_a", onboarded: true, profession: null })).toBe(false)
  })

  it("legacy fallback: a claimed profession vouches for pre-flag accounts", () => {
    expect(needsOnboarding({ id: "u_pre", onboarded: false, profession: "Engineer" })).toBe(false)
  })

  it("the cache only vouches for the account that wrote it", () => {
    localStorage.setItem(STORAGE_KEYS.onboarded, "u_first")
    expect(needsOnboarding({ id: "u_first", onboarded: false, profession: null })).toBe(false)
    // The prod bug: a SECOND account in the same browser must still be gated.
    expect(needsOnboarding({ id: "u_second", onboarded: false, profession: null })).toBe(true)
  })

  it("a legacy '1' cache value no longer bypasses the gate for anyone", () => {
    localStorage.setItem(STORAGE_KEYS.onboarded, "1")
    expect(needsOnboarding({ id: "u_any", onboarded: false, profession: null })).toBe(true)
  })
})
