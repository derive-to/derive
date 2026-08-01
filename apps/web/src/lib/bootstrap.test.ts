import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import type { BootstrapPayload } from "@/api"
import { bootstrapQuery, seedFromBootstrap } from "./bootstrap"
import {
  blockedQuery,
  collectionsQuery,
  notificationsQuery,
  summaryQuery,
  workspaceSettingsQuery,
} from "./queries"

// The batch's whole safety argument is that a seeded cache is indistinguishable from
// the individual endpoint having answered, and that a FAILED batch leaves the four
// consumers to fetch for themselves (the pre-batch behavior). Both are asserted here
// against a real QueryClient — no DOM needed, which is why the seeding is a pure
// exported function rather than an inline closure.

const payload = (): BootstrapPayload => ({
  summary: {
    total: 7,
    favorites: 2,
    mine: 3,
    mine_private: 1,
    tags: [{ tag: "perf", count: 4 }],
    workspace: "Test Workspace",
  },
  collections: [{ id: "col_1", title: "One", count: 2 }] as BootstrapPayload["collections"],
  settings: { emailNotifications: true } as BootstrapPayload["settings"],
  notifications: [{ id: "n1", preview: "hi" }] as BootstrapPayload["notifications"],
  unread: 1,
  blocked: { code: "billing_lapsed", message: "Renew to keep Deriving." },
})

describe("seedFromBootstrap", () => {
  it("writes each arm under the key and in the shape its own endpoint uses", () => {
    const qc = new QueryClient()
    const b = payload()
    seedFromBootstrap(qc, b)

    // /v1/tags stores the summary body verbatim.
    expect(qc.getQueryData(summaryQuery().queryKey)).toEqual(b.summary)
    // /v1/collections stores the ARRAY (its queryFn unwraps { collections }).
    expect(qc.getQueryData(collectionsQuery().queryKey)).toEqual(b.collections)
    // /v1/workspace/settings stores the settings object verbatim.
    expect(qc.getQueryData(workspaceSettingsQuery().queryKey)).toEqual(b.settings)
    // The banner's verdict, seeded so the shell never calls the 6-round-trip
    // /v1/billing just to be told it is not blocked.
    expect(qc.getQueryData(blockedQuery().queryKey)).toEqual(b.blocked)
    // /v1/notifications stores the ENVELOPE — the bell reads .notifications and .unread.
    expect(qc.getQueryData(notificationsQuery().queryKey)).toEqual({
      notifications: b.notifications,
      unread: b.unread,
    })
  })
})

describe("bootstrapQuery", () => {
  it("seeds the four caches on success", async () => {
    const qc = new QueryClient()
    const b = payload()
    const api = await import("@/api")
    const spy = vi.spyOn(api.api, "bootstrap").mockResolvedValue(b)

    await qc.fetchQuery(bootstrapQuery(qc))

    expect(spy).toHaveBeenCalledTimes(1)
    expect(qc.getQueryData(summaryQuery().queryKey)).toEqual(b.summary)
    expect(qc.getQueryData(collectionsQuery().queryKey)).toEqual(b.collections)
    spy.mockRestore()
  })

  it("seeds NOTHING when the batch fails, so each consumer falls back to its own query", async () => {
    // The failure contract: the gate opens on settle either way and the four queries
    // run themselves. If a partial or stale seed were left behind, a consumer would
    // render it and never fetch — the one way this optimization could show a user
    // wrong data. retry:false keeps the fallback fast rather than holding boot behind
    // a retry ladder.
    const qc = new QueryClient()
    const api = await import("@/api")
    const spy = vi.spyOn(api.api, "bootstrap").mockRejectedValue(new Error("503"))

    await expect(qc.fetchQuery(bootstrapQuery(qc))).rejects.toThrow()

    expect(qc.getQueryData(summaryQuery().queryKey)).toBeUndefined()
    expect(qc.getQueryData(collectionsQuery().queryKey)).toBeUndefined()
    expect(qc.getQueryData(workspaceSettingsQuery().queryKey)).toBeUndefined()
    expect(qc.getQueryData(notificationsQuery().queryKey)).toBeUndefined()
    // One attempt, not a ladder.
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
