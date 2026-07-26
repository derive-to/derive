import { useEffect, useRef, useState } from "react"
import { API_BASE, api, type Viewer } from "@/api"
import { guestQuery } from "@/lib/guest-id"
import { useOnline } from "@/lib/use-online"
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
  /** This viewer's stable presence id (a user id, or the anon guest id) — the cursor engine
   *  keys peers on it (one identity per browser) and ignores our own echoed frames. */
  selfId: string
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
  const { shortId, selfId, onComment, onVersion, onReview, onResync } = opts
  const [viewers, setViewers] = useState<Viewer[]>([])
  // The live-stream "reconnecting" cue: `connected` is false whenever the browser is offline OR
  // the stream isn't confirmed live — so a dropped connection reads as reconnecting instead of a
  // silently-frozen collaborative view. `streamReady` is optimistic on mount (the data was just
  // loaded) and flips on the server's `ready` (up) / the socket's `onerror` (down). `online`
  // covers the browser-offline case instantly AND — being a real dependency of the stream effect
  // below — re-establishes the stream the moment the network returns (which native EventSource is
  // documented not to do reliably), so there's no bespoke reconnect trigger to hand-roll.
  const online = useOnline()
  const [streamReady, setStreamReady] = useState(true)
  const connected = online && streamReady
  // Whether ANY stream for this page has connected before — the first "ready" of
  // the first stream is the mount itself (the loader/query just fetched; nothing
  // to catch up on); every later "ready" means a gap just closed.
  const everConnected = useRef(false)
  const cursors = useLiveCursors(shortId, selfId)
  const { paintFrame } = cursors
  const visible = usePageVisible()

  // The live stream: comment churn + new versions refetch/reload; presence and peer cursors
  // paint directly. Gated on `online` as well as `visible`, so it RE-ESTABLISHES the moment the
  // browser returns online (the idiomatic reconnect — the effect just re-runs when its `online`
  // dep flips; native EventSource is documented not to auto-reconnect reliably across that
  // cycle). Also closed while the tab is hidden (reopened on focus) so a backgrounded tab
  // doesn't keep the artifact's room Durable Object active — and a return-to-tab likewise
  // re-establishes, which recovers the rarer server-error CLOSED case too.
  useEffect(() => {
    if (!visible || !online) return
    // `?g=` carries this browser's stable guest identity to the presence roster, so an
    // anonymous viewer is ONE row here and on the heartbeat below — not a cookie raced
    // across concurrent requests into several phantoms (see lib/guest-id).
    const ev = new EventSource(`${API_BASE}/v1/artifacts/${shortId}/events${guestQuery()}`, {
      withCredentials: true,
    })
    // Connection health for the cue: onerror flips to reconnecting; the server's `ready` hello
    // (below) confirms we're live again — NOT the raw `onopen`, which proved unreliable at
    // confirming a real reconnect.
    ev.onerror = () => setStreamReady(false)
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
    // "ready" is the server's hello on every (re)connect — see onResync. It's also the live
    // signal: reaching it means the stream is up and the server acknowledged us.
    ev.addEventListener("ready", () => {
      setStreamReady(true)
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
  }, [shortId, onComment, onVersion, onReview, onResync, paintFrame, visible, online])

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
    connected,
    onPointerMove: cursors.onPointerMove,
    onPointerLeave: cursors.onPointerLeave,
    onTap: cursors.onTap,
    setGeom: cursors.setGeom,
    setViewSlide: cursors.setViewSlide,
    cursor: cursors.layer,
  }
}
