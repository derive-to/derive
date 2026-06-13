import { useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { artifactQuery, commentsQuery, prefetchArtifactRaw } from "./queries"

// Hover/focus prefetch for an artifact link: warm its metadata + comments in the
// query cache and prefetch its rendered HTML, so the click opens instantly. The
// library cards and the ⌘K results already know the current version, so they
// pass it to skip the metadata round trip before the raw prefetch can start.
export function usePrefetchArtifact() {
  const qc = useQueryClient()
  return useCallback(
    (shortId: string, version?: number) => {
      qc.prefetchQuery(artifactQuery(shortId))
      qc.prefetchQuery(commentsQuery(shortId))
      if (version) prefetchArtifactRaw(shortId, version)
    },
    [qc],
  )
}
