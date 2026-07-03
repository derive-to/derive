import { createFileRoute } from "@tanstack/react-router"
import { Library } from "../pages/library"
import type { LibrarySearch } from "../pages/library/types"

export const Route = createFileRoute("/")({
  // The home library. Its filters + free-text search live in the URL (LibrarySearch)
  // so the nav rail can drive them from anywhere and a filtered/searched library is
  // shareable. The named feeds (Favorites, Following) are their OWN routes, not params
  // here — path = the feed you're viewing, query = how it's filtered (docs/decisions/0002).
  validateSearch: (s: Record<string, unknown>): LibrarySearch => ({
    tag: typeof s.tag === "string" ? s.tag : undefined,
    collection: typeof s.collection === "string" ? s.collection : undefined,
    query: typeof s.query === "string" ? s.query : undefined,
    author: typeof s.author === "string" ? s.author : undefined,
  }),
  component: () => <Library view="all" />,
})
