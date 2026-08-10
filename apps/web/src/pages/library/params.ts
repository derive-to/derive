import type { LibraryParams } from "@/lib/queries"
import { DEFAULT_SORT } from "./sort"
import type { LibrarySearch, LibraryView } from "./types"

// The ONE construction of the library's list params, shared by LibraryBody and by every
// library route's loader.
//
// It has to be one function. A route loader exists so that hovering "Favorites" in the
// rail warms the exact list the click will render — and "exact" means the query KEY, which
// is this whole object. Build it twice and a single field out of step (an untrimmed `q`, a
// missing sort default) makes the loader warm a key the body never reads: the request is
// paid for, the grid still shows a skeleton, and nothing about it looks wrong. The home
// route carried two copies of this and a comment asking the next person to keep them in
// step; this is that comment made structural.

/** A route view's base feed scope. `all` and `favorites` carry none — favorites rides the
 *  `favorite` flag instead, because it narrows by an id set the API already has. */
export const scopeFor = (view: LibraryView): LibraryParams["scope"] =>
  view === "following"
    ? "following"
    : view === "shared"
      ? "shared"
      : view === "feedback"
        ? "needs_feedback"
        : undefined

/** `q` is an override for the body, which keys off the DEBOUNCED input rather than the
 *  URL: the two converge (both settle on the same 280ms), but mid-keystroke the body must
 *  not refetch on a term the URL has not caught up to. Loaders pass nothing and get the
 *  URL's term, which is the settled one by definition. */
export const libraryFeedParams = (
  view: LibraryView,
  search: LibrarySearch,
  q: string | undefined = search.query,
): LibraryParams => ({
  q: q?.trim() || undefined,
  // The named feeds' validateSearch keeps only query + sort, so these are undefined
  // there; passing them unconditionally keeps this the same object the body built.
  collection: search.collection,
  favorite: view === "favorites" || search.filter === "starred" || undefined,
  author: search.author,
  tag: search.tag?.trim() || undefined,
  // The filter narrows the HOME library only, exactly as deriveFilter orders it: a
  // named feed is matched first, so /following?filter=mine is still the following feed.
  // (Their validateSearch drops `filter` anyway — but correctness here must not rest
  // on that.) `starred` rides the `favorite` flag above, not a scope.
  scope:
    view === "all" && search.filter === "needs-you"
      ? "needs_feedback"
      : view === "all" && (search.filter === "mine" || search.filter === "shared")
        ? search.filter
        : scopeFor(view),
  sort: search.sort ?? DEFAULT_SORT,
})
