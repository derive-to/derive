import { createFileRoute } from "@tanstack/react-router"
import { Library } from "../pages/library"
import type { LibrarySearch } from "../pages/library/types"

export const Route = createFileRoute("/")({
  // Filter + search live in the URL (see LibrarySearch) so the nav rail can drive
  // them from any page and a filtered/searched library is shareable.
  validateSearch: (s: Record<string, unknown>): LibrarySearch => ({
    f: s.f === "favorites" ? "favorites" : undefined,
    scope: s.scope === "following" ? "following" : undefined,
    tag: typeof s.tag === "string" ? s.tag : undefined,
    collection: typeof s.collection === "string" ? s.collection : undefined,
    q: typeof s.q === "string" ? s.q : undefined,
    author: typeof s.author === "string" ? s.author : undefined,
  }),
  component: Library,
})
