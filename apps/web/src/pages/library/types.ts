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

// The library filter, encoded in the URL so the persistent nav rail can navigate
// to a view (Favorites / a tag / a collection) from any page and so a filtered
// library is shareable and survives reload. `q` is the free-text search.
export type LibrarySearch = {
  f?: "favorites"
  // "following" → the activity feed (followed authors + repo path prefixes).
  scope?: "following"
  tag?: string
  collection?: string
  q?: string
  // Narrow to artifacts last changed by this GitHub login (synced collections).
  author?: string
}
