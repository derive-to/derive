import { afterEach, describe, expect, it, vi } from "vitest"
import { API_BASE, api, artifactsListPath } from "../api"
import { DEFAULT_SORT } from "../pages/library/sort"
import { releaseUnclaimedBootResponses, takeBootResponse } from "./boot-fetch"
import { LIBRARY_PAGE } from "./queries"

// The URLs __root's head script starts. Rebuilt here from the same shared pieces the
// script interpolates, rather than imported from the route module — importing __root
// would pull the whole app tree into a unit test.
const BOOT = {
  bootstrap: `${API_BASE}/v1/bootstrap`,
  homeList: API_BASE + artifactsListPath({ limit: LIBRARY_PAGE, sort: DEFAULT_SORT }),
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

// The suite runs in the node environment (see vitest.config.ts — these are pure-logic
// tests, not component tests), so stand up the one global the head script writes to.
const headStarted = (map: Record<string, Promise<Response>>) =>
  vi.stubGlobal("window", { __deriveBoot: map })

afterEach(() => {
  vi.unstubAllGlobals()
})

// THE POINT OF THE WHOLE MECHANISM. The head script starts a request keyed by URL and
// the api client claims it by URL, so a mismatch is silent: the boot pays for a request
// nobody reads and the app opens a second one anyway. These two assert the pairing on the
// real client method, not on a restated URL.
describe("the head-started boot requests are the ones the api client asks for", () => {
  it("hands the started /v1/bootstrap response to api.bootstrap()", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ from: "network" })))
    vi.stubGlobal("fetch", fetchSpy)
    headStarted({ [BOOT.bootstrap]: Promise.resolve(jsonResponse({ from: "head" })) })

    expect(await api.bootstrap()).toEqual({ from: "head" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("hands the started list response to the home library's listArtifacts() call", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ artifacts: ["network"] })))
    vi.stubGlobal("fetch", fetchSpy)
    headStarted({ [BOOT.homeList]: Promise.resolve(jsonResponse({ artifacts: ["head"] })) })

    // Exactly the params the home route's loader passes for an unfiltered library.
    const got = await api.listArtifacts({ limit: LIBRARY_PAGE, sort: DEFAULT_SORT })
    expect(got).toEqual({ artifacts: ["head"] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("does NOT hand it to a narrowed listing — a different list is a different request", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ artifacts: ["network"] })))
    vi.stubGlobal("fetch", fetchSpy)
    headStarted({ [BOOT.homeList]: Promise.resolve(jsonResponse({ artifacts: ["head"] })) })

    const got = await api.listArtifacts({ limit: LIBRARY_PAGE, sort: DEFAULT_SORT, author: "amy" })
    expect(got).toEqual({ artifacts: ["network"] })
    expect(fetchSpy).toHaveBeenCalledOnce()
  })
})

describe("claiming rules", () => {
  it("serves a started response exactly once — a refetch opens a fresh request", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ from: "network" })))
    vi.stubGlobal("fetch", fetchSpy)
    headStarted({ [BOOT.bootstrap]: Promise.resolve(jsonResponse({ from: "head" })) })

    expect(await api.bootstrap()).toEqual({ from: "head" })
    expect(await api.bootstrap()).toEqual({ from: "network" })
  })

  it("falls back to a real fetch when the started request failed at the network layer", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ from: "network" })))
    vi.stubGlobal("fetch", fetchSpy)
    headStarted({ [BOOT.bootstrap]: Promise.reject(new Error("offline")) })

    expect(await api.bootstrap()).toEqual({ from: "network" })
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it("never claims a write that happens to share the URL", () => {
    headStarted({ [BOOT.bootstrap]: Promise.resolve(jsonResponse({})) })

    expect(takeBootResponse(BOOT.bootstrap, { method: "POST" })).toBeNull()
    expect(takeBootResponse(BOOT.bootstrap, { body: "{}" })).toBeNull()
    // Still there for the GET that the head script actually started.
    expect(takeBootResponse(BOOT.bootstrap)).not.toBeNull()
  })

  it("is inert when the head script never ran", () => {
    headStarted({})
    releaseUnclaimedBootResponses()
    expect(takeBootResponse(BOOT.bootstrap)).toBeNull()
  })
})
