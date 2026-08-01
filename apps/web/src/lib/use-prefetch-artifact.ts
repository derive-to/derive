import { useQueryClient } from "@tanstack/react-query"
import { artifactQuery, commentsQuery } from "./queries"

// Hover/focus prefetch for an artifact link: warm its metadata + comments in the query
// cache so the click paints the workbench header and rail immediately.
//
// It deliberately does NOT prefetch the rendered HTML. That was tried and measured: a
// `<link rel=prefetch>` for the viewer's URL downloads the bytes and the iframe then
// downloads them AGAIN (transferSize was identical on both requests, not 0 on the
// second), because a prefetch response is not reused for an iframe navigation. It was
// pure waste — a full copy of every hovered document, discarded. What DOES make the
// re-open cheap is ordinary HTTP caching, now that the raw response is cacheable and its
// URL is stable (see RAW_TOKEN_WINDOW_MS): a real second navigation hits the browser
// cache, measured at 13ms with transferSize 0.
export function usePrefetchArtifact() {
  const qc = useQueryClient()
  return (shortId: string) => {
    void qc.ensureQueryData(artifactQuery(shortId)).catch(() => {})
    qc.prefetchQuery(commentsQuery(shortId))
  }
}
