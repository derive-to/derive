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
export type LibrarySearch = {
  collection?: string
  // Anchor a collection view to one of its folders — scroll that section into view on
  // open. Set by the artifact breadcrumb's folder segment; ignored outside a collection.
  folder?: string
  // Free-text title search; composes with any view.
  query?: string
  // Narrow to artifacts last changed by this GitHub login (synced collections).
  author?: string
  // The home library's second tab: everything YOU created, any visibility. A
  // query param, not a route — a view of your own work is a filter on the home
  // library, not a separate feed (docs/decisions/0002).
  tab?: "mine"
  // How the grid is ordered; absent = the default ("Newest"). See ./sort.
  sort?: SortMode
}
