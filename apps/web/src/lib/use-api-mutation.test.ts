import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { shouldOpenPaywall } from "./query-client"
import { invalidateKeys, snapshot } from "./use-api-mutation"

// The global MutationCache turns a 402 into the upgrade dialog. That is wrong for a write
// whose refusal is somebody else's bill (joining a workspace you don't own), where the
// dialog would sell the joiner a seat on their OWN workspace and swallow the inline panel.
// `meta.paywall: false` is the opt-out; this pins the default-on rule.
describe("shouldOpenPaywall", () => {
  it("opens the dialog by default, and only `paywall:false` suppresses it", () => {
    expect(shouldOpenPaywall(undefined)).toBe(true)
    expect(shouldOpenPaywall({})).toBe(true)
    expect(shouldOpenPaywall({ paywall: false })).toBe(false)
    // Opting out of the toast is a separate axis: it must not suppress the dialog.
    expect(shouldOpenPaywall({ errorToast: false })).toBe(true)
  })
})

// Which queries reconcile on settle. The array form runs on both outcomes; the function
// form runs only on success — keyed off the error, NOT `data`, so a void mutation (whose
// success `data` is undefined) still invalidates. That last case is the regression this locks.
describe("invalidateKeys", () => {
  const K = [["a"], ["b"]]
  it("array form reconciles on success AND failure", () => {
    expect(invalidateKeys(K, { id: 1 }, null, undefined)).toEqual(K)
    expect(invalidateKeys(K, undefined, new Error("x"), undefined)).toEqual(K)
  })
  it("function form runs on success — including a VOID mutation whose data is undefined", () => {
    const fn = (_d: unknown, vars: { id: string }) => [["thread", vars.id]]
    expect(invalidateKeys(fn, { ok: true }, null, { id: "42" })).toEqual([["thread", "42"]])
    // void success: data undefined but it must STILL invalidate (the old `data===undefined` bug).
    expect(invalidateKeys(fn, undefined, null, { id: "42" })).toEqual([["thread", "42"]])
  })
  it("function form is skipped on failure (no result to key off)", () => {
    expect(invalidateKeys(() => [["never"]], undefined, new Error("boom"), undefined)).toEqual([])
  })
})

// `snapshot` is the heart of the optimistic path: it captures a query's data before
// the optimistic edit so the primitive can restore it verbatim if the write fails.
// The hook wiring around it (useApiMutation) is covered by the e2e suite, matching
// the app's convention of unit-testing pure logic and leaving hooks to Playwright.
describe("snapshot", () => {
  it("restores the pre-edit data when the mutation rolls back", () => {
    const qc = new QueryClient()
    const key = ["artifact", "abc123"]
    qc.setQueryData(key, { favorite: false })

    const rollback = snapshot(qc, key)
    qc.setQueryData(key, { favorite: true }) // the optimistic edit
    expect(qc.getQueryData(key)).toEqual({ favorite: true })

    rollback()
    expect(qc.getQueryData(key)).toEqual({ favorite: false })
  })

  it("restores 'no data' when the key was empty before the edit", () => {
    const qc = new QueryClient()
    const key = ["thread", 1]

    const rollback = snapshot(qc, key) // nothing cached yet
    qc.setQueryData(key, { state: "resolved" })
    rollback()

    expect(qc.getQueryData(key)).toBeUndefined()
  })

  it("holds the snapshot by value, so an immutable list edit still rolls back", () => {
    const qc = new QueryClient()
    const key = ["comments"]
    qc.setQueryData(key, [1, 2, 3])

    const rollback = snapshot(qc, key)
    qc.setQueryData<number[]>(key, (old = []) => [...old, 4]) // optimistic append
    expect(qc.getQueryData(key)).toEqual([1, 2, 3, 4])

    rollback()
    expect(qc.getQueryData(key)).toEqual([1, 2, 3])
  })
})
