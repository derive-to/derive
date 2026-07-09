import { useInfiniteQuery } from "@tanstack/react-query"
import { type Artifact, api } from "@/api"
import { type LibraryParams, libraryArtifactsQuery, summaryQuery } from "@/lib/queries"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"

// The library feed as a hook: the infinite keyset query plus the two optimistic
// mutations that write across every cached page (star + delete) — now routed through the
// one governed primitive so their feedback can't drift from the rest of the app. The
// mutation correctness is preserved verbatim: optimistic write across ALL pages,
// drop-on-unstar in the Favorites view, rollback + toast on failure, and reconcile the
// sidebar summary counts on settle. Keyed by the active filter params, so each view
// caches independently and switching views keeps the current grid (keepPreviousData).
export function useLibraryFeed(params: LibraryParams) {
  const listQuery = libraryArtifactsQuery(params)
  const query = useInfiniteQuery(listQuery)
  const items = query.data?.pages.flatMap((p) => p.artifacts) ?? []

  const favorite = useApiMutation({
    mutationFn: ({ a, on }: { a: Artifact; on: boolean }) => api.favorite(a.short_id, on),
    optimistic: ({ a, on }, qc) => {
      const rollback = snapshot(qc, listQuery.queryKey)
      // In the Favorites view an un-star drops the card; elsewhere it just flips.
      const drop = !!params.favorite && !on
      qc.setQueryData(listQuery.queryKey, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((pg) => ({
                ...pg,
                artifacts: pg.artifacts.flatMap((x) =>
                  x.short_id !== a.short_id ? [x] : drop ? [] : [{ ...x, favorite: on }],
                ),
              })),
            }
          : old,
      )
      return rollback
    },
    invalidate: [summaryQuery().queryKey],
  })

  const remove = useApiMutation({
    mutationFn: (a: Artifact) => api.deleteArtifact(a.short_id),
    optimistic: (a, qc) => {
      const rollback = snapshot(qc, listQuery.queryKey)
      qc.setQueryData(listQuery.queryKey, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((pg) => ({
                ...pg,
                artifacts: pg.artifacts.filter((x) => x.short_id !== a.short_id),
              })),
            }
          : old,
      )
      return rollback
    },
    // The card vanishing is easy to miss, so confirm the delete out loud.
    success: "Artifact deleted",
    invalidate: [summaryQuery().queryKey],
  })

  return {
    query,
    items,
    listQuery,
    toggleFavorite: (a: Artifact) => favorite.mutate({ a, on: !a.favorite }),
    deleteArtifact: (a: Artifact) => remove.mutate(a),
  }
}
