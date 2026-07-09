import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { snapshot } from "./use-api-mutation"

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
