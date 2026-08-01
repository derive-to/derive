// Shared shapes for the library surface (page + sidebar + bars).

import type { SortMode } from "@derive/core"

export type Filter =
  | { kind: "all" }
  | { kind: "favorites" }
  // The activity feed: artifacts in the active workspace whose current author or
  // source-path matches one of your follows.
  | { kind: "following" }
  // "Shared with you": artifacts explicitly shared with the caller (can span
  // workspaces). A durable named feed, not a home strip.
  | { kind: "shared" }
  // "Needs your feedback": artifacts with an open thread you're tagged in or have
  // commented on — the triage feed.
  | { kind: "feedback" }
  // "Created by me": every artifact you own in the active workspace (your owner
  // member row — written at creation, agents' on-behalf publishes included), any
  // visibility.
  | { kind: "mine" }
  | { kind: "collection"; id: string; title: string }

export type Summary = {
  total: number
  favorites: number
  mine: number
  // Owned docs still private — the "waiting to be shared" signal.
  mine_private: number
  workspace: string
}

// The base library feed, chosen by ROUTE (path), not a query param: "/" = all,
// "/favorites", "/following", "/shared", "/feedback". Path = the feed you're viewing;
// query (LibrarySearch) = how it's filtered. See routes/favorites.tsx + docs/decisions/0002.
export type LibraryView = "all" | "favorites" | "following" | "shared" | "feedback"

// The library's URL-encoded filters + search (query params on the home route), so
// the persistent nav rail can drive them from any page and a filtered/searched
// library is shareable and survives reload. These compose ON TOP of the base view
// (a collection within all, a search within favorites). The named feeds themselves
// are routes, not params — see LibraryView.
/** Every query param that narrows or reorders the home library — the keys of
 *  LibrarySearch, as a runtime list.
 *
 *  It exists for __root's head-start script, which starts the DEFAULT home listing
 *  before the router exists and so must know whether this URL is the default one. The
 *  test in this folder asserts the list matches the type, because a key added to
 *  LibrarySearch and forgotten here would have the boot start (and the app ignore) the
 *  wrong list. Anything NOT in this list — a utm_ tag, a cache buster, any tracking
 *  param — does not change which artifacts the home renders, so it must not disable the
 *  head-start. */
export const LIBRARY_SEARCH_PARAMS = [
  "view",
  "collection",
  "folder",
  "query",
  "author",
  "filter",
  "sort",
] as const

export type LibrarySearch = {
  /** Which of the library's two views is showing. Absent = Artifacts. Collections is
   *  a view of the same page rather than its own route: it shares the toolbar, and
   *  opening a shelf from it is just the `collection` filter below. */
  view?: "collections"
  collection?: string
  // Anchor a collection view to one of its folders — scroll that section into view on
  // open. Set by the artifact breadcrumb's folder segment; ignored outside a collection.
  folder?: string
  // Free-text title search; composes with any view.
  query?: string
  // Narrow to artifacts last changed by this GitHub login (synced collections).
  author?: string
  // How the home library is narrowed. Absent = everything you can see. These were
  // three separate places — /favorites and /shared were routes, "Created by me" was
  // a `tab` param — for one list under three names. They are facets of the home
  // library, so they compose with a collection, a search and a sort, which three
  // routes never could. The old paths redirect here.
  filter?: "mine" | "shared" | "starred" | "needs-you"
  // How the grid is ordered; absent = the default ("Newest"). See ./sort.
  sort?: SortMode
}
