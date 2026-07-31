import { describe, expect, it } from "vitest"
import { libraryFeedParams, scopeFor } from "./params"
import type { LibrarySearch } from "./types"

const NONE: LibrarySearch = {}

// These params ARE the query key. A route loader's whole job is to warm the key the body
// will read, so the pairs below are the contract: get one field wrong and the loader
// warms a key nobody reads — a request paid for, a skeleton still showing, and nothing
// that looks like a bug.
describe("libraryFeedParams", () => {
  it("gives each named feed its own scope, and favorites the flag instead", () => {
    expect(libraryFeedParams("all", NONE).scope).toBeUndefined()
    expect(libraryFeedParams("following", NONE).scope).toBe("following")
    expect(libraryFeedParams("shared", NONE).scope).toBe("shared")
    expect(libraryFeedParams("feedback", NONE).scope).toBe("needs_feedback")
    expect(libraryFeedParams("favorites", NONE)).toMatchObject({
      scope: undefined,
      favorite: true,
    })
  })

  it("defaults the sort, so a loader and the body agree on the key", () => {
    expect(libraryFeedParams("all", NONE).sort).toBe("updated")
    expect(libraryFeedParams("all", { sort: "created" }).sort).toBe("created")
  })

  it("trims the search term and drops an empty one", () => {
    // The URL can carry whitespace; the body trims. Both go through here now, so a
    // ?query=%20%20 cannot key differently from no query at all.
    expect(libraryFeedParams("all", { query: "  " }).q).toBeUndefined()
    expect(libraryFeedParams("all", { query: "  deck  " }).q).toBe("deck")
  })

  it("lets the body override the term with its debounced value", () => {
    // Mid-keystroke the URL has not caught up; the body keys off what it has typed.
    expect(libraryFeedParams("all", { query: "old" }, "new").q).toBe("new")
    expect(libraryFeedParams("all", { query: "old" }, "").q).toBeUndefined()
  })

  it("keeps the home's collection/author narrowing", () => {
    expect(libraryFeedParams("all", { collection: "c1", author: "amy" })).toMatchObject({
      collection: "c1",
      author: "amy",
    })
  })

  it("keeps the Created-by-me tab to the home library", () => {
    // deriveFilter matches the named feeds first; /favorites?tab=mine is still favorites.
    expect(libraryFeedParams("all", { tab: "mine" }).scope).toBe("mine")
    expect(libraryFeedParams("favorites", { tab: "mine" }).scope).toBeUndefined()
    expect(libraryFeedParams("shared", { tab: "mine" }).scope).toBe("shared")
  })

  it("scopeFor stays the single mapping the routes and the body share", () => {
    expect(scopeFor("all")).toBeUndefined()
    expect(scopeFor("favorites")).toBeUndefined()
  })
})
