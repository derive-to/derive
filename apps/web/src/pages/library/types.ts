// Shared shapes for the library surface (page + sidebar + bars).

export type Filter =
  | { kind: "all" }
  | { kind: "favorites" }
  // The activity feed: artifacts in the active workspace whose current author or
  // source-path matches one of your follows.
  | { kind: "following" }
  | { kind: "tag"; tag: string }
  | { kind: "collection"; id: string; title: string }

export type TagCount = { tag: string; count: number }

export type Summary = {
  total: number
  favorites: number
  tags: TagCount[]
  workspace: string
}

// The base library feed, chosen by ROUTE (path), not a query param: "/" = all,
// "/favorites", "/following". Path = the feed you're viewing; query (LibrarySearch)
// = how it's filtered. See routes/favorites.tsx + docs/decisions/0002.
export type LibraryView = "all" | "favorites" | "following"

// The library's URL-encoded filters + search (query params on the home route), so
// the persistent nav rail can drive them from any page and a filtered/searched
// library is shareable and survives reload. These compose ON TOP of the base view
// (a tag within all, a search within favorites). The named feeds themselves are
// routes, not params — see LibraryView.
export type LibrarySearch = {
  tag?: string
  collection?: string
  // Free-text title search; composes with any view.
  query?: string
  // Narrow to artifacts last changed by this GitHub login (synced collections).
  author?: string
}
