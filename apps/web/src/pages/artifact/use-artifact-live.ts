import { useEffect, useRef, useState } from "react"
import { API_BASE, api, type Viewer } from "@/api"
import { usePageVisible } from "@/lib/use-page-visible"
import { useLiveCursors } from "./cursors/use-live-cursors"

/**
 * Everything realtime on the artifact page, kept out of the page component:
 *  - presence ("who's viewing" — anon shows as a server handle), heartbeated;
 *  - live multiplayer cursors — delegated to {@link useLiveCursors}, which owns
 *    the overlay, the smooth motion, and the focus/idle/leave behaviour; here we
 *    just feed it the cursor frames off the shared SSE stream;
 *  - the SSE stream that refetches comments + reloads on a new version;
 *  - one view record per open.
 *
 * The page feeds pointer moves/leave/tap in (from the iframe message bridge) and
 * reads `viewers` + the `cursor` overlay handle back out.
 */
export function useArtifactLive(opts: {
  shortId: string
  onComment: () => void
  /** A new version landed live, with its number when the event carried one — the
   *  page refetches AND may cue the user (toast / mid-edit warning). */
  onVersion: (n?: number) => void
  /** A review round changed (requested / sent back / approved) — the review card
   *  refetches, so an agent's re-request appears live instead of on reload. */
  onReview?: () => void
  /** The stream (re)connected after a coverage gap — a hidden tab returning (its
   *  stream was closed) or an EventSource auto-reconnect. Events during the gap
   *  were never replayed, so refetch silently instead of trusting the cache. */
  onResync?: () => void
}) {
  const { shortId, onComment, onVersion, onReview, onResync } = opts
  const [viewers, setViewers] = useState<Viewer[]>([])
  // Whether ANY stream for this page has connected before — the first "ready" of
  // the first stream is the mount itself (the loader/query just fetched; nothing
  // to catch up on); every later "ready" means a gap just closed.
  const everConnected = useRef(false)
  const cursors = useLiveCursors(shortId)
  const { paintFrame } = cursors
  const visible = usePageVisible()

  // The live stream: comment churn + new versions refetch/reload; presence and
  // peer cursors paint directly. Closed while the tab is hidden (and reopened
  // on focus) so a backgrounded tab doesn't keep the artifact's room Durable
  // Object active.
  useEffect(() => {
    if (!visible) return
    const ev = new EventSource(`${API_BASE}/v1/artifacts/${shortId}/events`, {
      withCredentials: true,
    })
    ev.addEventListener("comment.created", onComment)
    ev.addEventListener("comment.resolved", onComment)
    ev.addEventListener("comment.outdated", onComment)
    ev.addEventListener("comment.addressed", onComment)
    ev.addEventListener("comment.reacted", onComment)
    ev.addEventListener("comment.updated", onComment)
    ev.addEventListener("version.published", (e) => {
      let n: number | undefined
      try {
        n = JSON.parse((e as MessageEvent).data).n
      } catch {
        /* the refetch doesn't need the number */
      }
      onVersion(n)
    })
    // "ready" is the server's hello on every (re)connect — see onResync.
    ev.addEventListener("ready", () => {
      if (everConnected.current) onResync?.()
      everConnected.current = true
    })
    if (onReview) {
      ev.addEventListener("review.requested", onReview)
      ev.addEventListener("review.sent_back", onReview)
      ev.addEventListener("review.approved", onReview)
    }
    ev.addEventListener("presence", (e) => {
      try {
        setViewers((JSON.parse((e as MessageEvent).data).viewers as Viewer[]) ?? [])
      } catch {
        /* ignore malformed frames */
      }
    })
    ev.addEventListener("cursor", (e) => {
      try {
        paintFrame(JSON.parse((e as MessageEvent).data))
      } catch {
        /* ignore malformed frames */
      }
    })
    return () => ev.close()
  }, [shortId, onComment, onVersion, onReview, onResync, paintFrame, visible])

  // Announce we're viewing (anon shows up by their server handle — Google-Docs
  // style) and keep the heartbeat alive (TTL 45s). Paused while the tab is
  // hidden, so a backgrounded viewer ages out of presence instead of showing
  // as "currently viewing" forever.
  useEffect(() => {
    if (!visible) return
    const beat = () =>
      api
        .heartbeat(shortId)
        .then((r) => setViewers(r.viewers))
        .catch(() => {})
    beat()
    const t = setInterval(beat, 20_000)
    return () => clearInterval(t)
  }, [shortId, visible])

  // Record one view per artifact open.
  const recorded = useRef("")
  useEffect(() => {
    if (recorded.current === shortId) return
    recorded.current = shortId
    api.recordView(shortId).catch(() => {})
  }, [shortId])

  return {
    viewers,
    onPointerMove: cursors.onPointerMove,
    onPointerLeave: cursors.onPointerLeave,
    onTap: cursors.onTap,
    setGeom: cursors.setGeom,
    setViewSlide: cursors.setViewSlide,
    cursor: cursors.layer,
  }
}
