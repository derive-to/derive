import { useQueryClient } from "@tanstack/react-query"
import { artifactQuery, commentsQuery, prefetchArtifactRaw } from "./queries"

// Hover/focus prefetch for an artifact link: warm its metadata + comments in the
// query cache and prefetch the rendered HTML the iframe will load, so the click
// opens instantly.
//
// The rendered HTML is fetched through a URL that CONTAINS the artifact's raw
// token (the sandboxed frame is an opaque origin and cannot send our cookie, so
// the token is its proof of access) — which means the token is part of the cache
// key, and the token only exists on the artifact record. So the order matters:
// resolve the record first, then warm the raw URL that record implies. Firing
// them together, as this used to, warmed a tokenless URL the frame never requests
// and left the real fetch cold behind a 500ms record round trip.
//
// Deliberately best-effort and un-awaited: a hover that never becomes a click
// must cost nothing but a warm cache, and a failed prefetch must never surface.
export function usePrefetchArtifact() {
  const qc = useQueryClient()
  return (shortId: string, version?: number) => {
    void qc
      .ensureQueryData(artifactQuery(shortId))
      .then((art) => {
        if (!art || art.removed) return
        // Prefer the record's own version: a list row can be stale by the time the
        // hover happens, and warming the wrong version is another wasted fetch.
        prefetchArtifactRaw(shortId, art.current_version ?? version ?? 0, art.raw_token)
      })
      .catch(() => {})
    qc.prefetchQuery(commentsQuery(shortId))
  }
}
