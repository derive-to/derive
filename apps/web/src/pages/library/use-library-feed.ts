import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import { type Artifact, api } from "@/api"
import { toast } from "@/components/ui/sonner"
import { type LibraryParams, libraryArtifactsQuery, summaryQuery } from "@/lib/queries"

// The library feed as a hook: the infinite keyset query plus the two optimistic
// mutations that write across every cached page (star + delete). Lifted verbatim from
// the old 660-line library body so the mutation correctness — optimistic write across
// ALL pages, drop-on-unstar in the Favorites view, reconcile-against-server on failure
// — is preserved, just relocated out of the god-component. Keyed by the active filter
// params, so each view caches independently and switching views keeps the current grid
// (keepPreviousData, set on the query factory).
export function useLibraryFeed(params: LibraryParams) {
  const qc = useQueryClient()
  const listQuery = libraryArtifactsQuery(params)
  const query = useInfiniteQuery(listQuery)
  const items = query.data?.pages.flatMap((p) => p.artifacts) ?? []

  // Star toggle is optimistic across every cached page; in the Favorites view an
  // un-star drops the card (params.favorite tells us we're in that view). Reconcile
  // against the server on failure.
  const toggleFavorite = async (a: Artifact) => {
    const on = !a.favorite
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
    try {
      await api.favorite(a.short_id, on)
      qc.invalidateQueries({ queryKey: summaryQuery().queryKey })
    } catch (e) {
      toast.error((e as Error).message)
      qc.invalidateQueries({ queryKey: listQuery.queryKey })
    }
  }

  // Delete is optimistic across every cached page too; reconcile on failure.
  const deleteArtifact = async (a: Artifact) => {
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
    try {
      await api.deleteArtifact(a.short_id)
      qc.invalidateQueries({ queryKey: summaryQuery().queryKey })
      toast.success("Artifact deleted")
    } catch (e) {
      toast.error((e as Error).message)
      qc.invalidateQueries({ queryKey: listQuery.queryKey })
    }
  }

  return { query, items, listQuery, toggleFavorite, deleteArtifact }
}
