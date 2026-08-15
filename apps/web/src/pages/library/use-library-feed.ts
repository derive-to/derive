import { useInfiniteQuery } from "@tanstack/react-query"
import { type Artifact, api } from "@/api"
import { toast } from "@/components/ui/sonner"
import { type LibraryParams, libraryArtifactsQuery, summaryQuery } from "@/lib/queries"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"
import { removeArtifactsFromFeed } from "./artifact-feed-cache"

// The infinite feed and its row-level mutations share one cache key. Failed optimistic
// writes restore their snapshot and refetch because another mutation may have changed the
// same pages while the request was in flight.
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
      // Reconcile after rollback in case another row mutation changed the same pages.
      return () => {
        rollback()
        void qc.invalidateQueries({ queryKey: listQuery.queryKey })
      }
    },
    invalidate: [summaryQuery().queryKey],
  })

  const remove = useApiMutation({
    mutationFn: (a: Artifact) => api.deleteArtifact(a.short_id),
    optimistic: (a, qc) => {
      const rollback = snapshot(qc, listQuery.queryKey)
      qc.setQueryData(listQuery.queryKey, (old) =>
        removeArtifactsFromFeed(old, new Set([a.short_id])),
      )
      // Reconcile after rollback in case another row mutation changed the same pages.
      return () => {
        rollback()
        void qc.invalidateQueries({ queryKey: listQuery.queryKey })
      }
    },
    // The card vanishing is easy to miss, so confirm the delete out loud.
    success: "Artifact deleted",
    invalidate: [summaryQuery().queryKey],
  })

  const undoArchive = useApiMutation({
    mutationFn: (a: Artifact) => api.archive(a.short_id, false),
    invalidate: [["artifacts"], summaryQuery().queryKey],
  })

  const archive = useApiMutation({
    mutationFn: ({ a, on }: { a: Artifact; on: boolean }) => api.archive(a.short_id, on),
    optimistic: ({ a }, qc) => {
      const rollback = snapshot(qc, listQuery.queryKey)
      // Either direction moves the row to the other shelf, so it leaves the current one
      // immediately. The server reconciliation repopulates a cached destination shelf.
      qc.setQueryData(listQuery.queryKey, (old) =>
        removeArtifactsFromFeed(old, new Set([a.short_id])),
      )
      return rollback
    },
    onSuccess: (_data, vars) => {
      if (!vars.on) {
        toast.success("Restored to library")
        return
      }
      toast("Artifact archived", {
        action: {
          label: "Undo",
          onClick: () => undoArchive.mutate(vars.a),
        },
      })
    },
    invalidate: [["artifacts"], summaryQuery().queryKey],
  })

  return {
    query,
    items,
    listQuery,
    toggleFavorite: (a: Artifact) => favorite.mutate({ a, on: !a.favorite }),
    archiveArtifact: (a: Artifact) => archive.mutate({ a, on: !a.archived }),
    deleteArtifact: (a: Artifact) => remove.mutate(a),
  }
}
