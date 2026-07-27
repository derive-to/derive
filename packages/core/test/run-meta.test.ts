import { describe, expect, it } from "vitest"
import { mergeRunMeta, parseRunMeta, runCounter, runMetaString } from "../src/run-meta"

// These rules are load-bearing in two packages (the store adapters' reclaim sweep and the API's
// retry + activity view), which is exactly why they live in one place. The cases below are the
// contract those callers rely on — especially the failure directions.
describe("run meta", () => {
  it("reads absent, empty, malformed, and non-object blobs as empty — never throws", () => {
    // A single corrupt row must not break a claim, a sweep, or the activity list.
    expect(parseRunMeta(null)).toEqual({})
    expect(parseRunMeta("")).toEqual({})
    expect(parseRunMeta("{not json")).toEqual({})
    expect(parseRunMeta("[1,2]")).toEqual({}) // an array is not a meta object
    expect(parseRunMeta('"a string"')).toEqual({})
    expect(parseRunMeta('{"outcome":"published"}')).toEqual({ outcome: "published" })
  })

  it("counts fail TOWARD the cap: anything not a positive number is zero", () => {
    // The direction matters. If corrupt meta read as "many attempts" a run would be abandoned
    // early; if it read as negative or NaN the cap could never be reached and a broken run
    // would retry forever, spending the owner's model plan each time.
    expect(runCounter({ attempts: 2 }, "attempts")).toBe(2)
    expect(runCounter({}, "attempts")).toBe(0)
    expect(runCounter({ attempts: "3" }, "attempts")).toBe(0)
    expect(runCounter({ attempts: -1 }, "attempts")).toBe(0)
    expect(runCounter({ attempts: Number.NaN }, "attempts")).toBe(0)
    expect(runCounter({ attempts: Number.POSITIVE_INFINITY }, "attempts")).toBe(0)
    expect(runCounter({ attempts: 2.7 }, "attempts")).toBe(2)
    expect(runCounter({ retries: 1 }, "retries")).toBe(1)
  })

  it("merges rather than replaces, so a retry never erases the last attempt's record", () => {
    const before = JSON.stringify({ outcome: "failed", writes: [{ short_id: "a1" }], why: "boom" })
    const after = parseRunMeta(mergeRunMeta(before, { attempts: 1 }))
    expect(after.attempts).toBe(1)
    expect(after.outcome).toBe("failed")
    expect(after.writes).toEqual([{ short_id: "a1" }])
    // An explicit field still wins — merging is not the same as being unable to update.
    expect(parseRunMeta(mergeRunMeta(before, { outcome: "lost" })).outcome).toBe("lost")
    // And merging onto a corrupt blob starts clean instead of throwing.
    expect(parseRunMeta(mergeRunMeta("{broken", { attempts: 1 }))).toEqual({ attempts: 1 })
  })

  it("reads a string field, treating empty and non-strings as absent", () => {
    expect(runMetaString({ outcome: "published" }, "outcome")).toBe("published")
    expect(runMetaString({ outcome: "" }, "outcome")).toBeNull()
    expect(runMetaString({ outcome: 7 }, "outcome")).toBeNull()
    expect(runMetaString({}, "outcome")).toBeNull()
  })
})
