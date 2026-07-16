import { describe, expect, it } from "vitest"
import {
  DEFAULT_SORT,
  decodeCursor,
  encodeCursor,
  parseSortMode,
  sortFields,
  sortKeyOf,
} from "../src/sort"

describe("parseSortMode", () => {
  it("accepts every known mode and falls back to the default otherwise", () => {
    expect(parseSortMode("updated")).toBe("updated")
    expect(parseSortMode("az")).toBe("az")
    expect(parseSortMode("created-asc")).toBe("created-asc")
    expect(parseSortMode("bogus")).toBe(DEFAULT_SORT)
    expect(parseSortMode(undefined)).toBe(DEFAULT_SORT)
    expect(parseSortMode(null)).toBe(DEFAULT_SORT)
    expect(DEFAULT_SORT).toBe("updated")
  })
})

describe("sortFields", () => {
  it("maps each mode to its field + direction", () => {
    expect(sortFields("updated")).toEqual({ field: "updated", dir: "desc" })
    expect(sortFields("updated-asc")).toEqual({ field: "updated", dir: "asc" })
    expect(sortFields("created")).toEqual({ field: "created", dir: "desc" })
    expect(sortFields("created-asc")).toEqual({ field: "created", dir: "asc" })
    expect(sortFields("az")).toEqual({ field: "title", dir: "asc" })
    expect(sortFields("za")).toEqual({ field: "title", dir: "desc" })
  })
})

describe("sortKeyOf", () => {
  const row = {
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-02-02T00:00:00.000Z",
    title: "Beta|Gamma",
  }
  it("uses coalesced updated_at, raw created_at, and the raw title per mode", () => {
    expect(sortKeyOf(row, "updated")).toBe("2026-02-02T00:00:00.000Z")
    expect(sortKeyOf({ ...row, updated_at: null }, "updated")).toBe("2026-01-01T00:00:00.000Z")
    expect(sortKeyOf(row, "created")).toBe("2026-01-01T00:00:00.000Z")
    expect(sortKeyOf(row, "az")).toBe("Beta|Gamma")
    expect(sortKeyOf({ ...row, title: null }, "az")).toBe("")
  })
})

describe("cursor codec", () => {
  it("round-trips, splitting on the LAST pipe so a title key may contain a pipe", () => {
    expect(encodeCursor("beta|gamma", "a_1")).toBe("beta|gamma|a_1")
    expect(decodeCursor("beta|gamma|a_1")).toEqual({ key: "beta|gamma", id: "a_1" })
    expect(decodeCursor("2026-01-01T00:00:00.000Z|a_9")).toEqual({
      key: "2026-01-01T00:00:00.000Z",
      id: "a_9",
    })
    // An empty key (a null-title row under az) is valid: leading pipe, non-empty id.
    expect(decodeCursor("|a_2")).toEqual({ key: "", id: "a_2" })
    expect(decodeCursor(undefined)).toBeUndefined()
    expect(decodeCursor("")).toBeUndefined()
    expect(decodeCursor("nopipe")).toBeUndefined()
    expect(decodeCursor("trailing|")).toBeUndefined()
  })
})
