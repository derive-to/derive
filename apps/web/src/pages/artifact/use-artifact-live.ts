import { useEffect, useRef, useState } from "react"
import { API_BASE, api } from "@/api"
import { useLiveCursors } from "./cursors/use-live-cursors"

type Me = { name?: string | null; email?: string | null } | null

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
  me: Me
  onComment: () => void
  onVersion: () => void
}) {
  const { shortId, me, onComment, onVersion } = opts
  const [viewers, setViewers] = useState<string[]>([])
  const cursors = useLiveCursors(shortId)
  const { paintFrame } = cursors

  // The live stream: comment churn + new versions refetch/reload; presence and
  // peer cursors paint directly.
  useEffect(() => {
    const ev = new EventSource(`${API_BASE}/v1/artifacts/${shortId}/events`, {
      withCredentials: true,
    })
    ev.addEventListener("comment.created", onComment)
    ev.addEventListener("comment.resolved", onComment)
    ev.addEventListener("comment.reacted", onComment)
    ev.addEventListener("comment.updated", onComment)
    ev.addEventListener("version.published", onVersion)
    ev.addEventListener("presence", (e) => {
      try {
        setViewers((JSON.parse((e as MessageEvent).data).viewers as string[]) ?? [])
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
  }, [shortId, onComment, onVersion, paintFrame])

  // Announce we're viewing (anon shows up by their server handle — Google-Docs
  // style) and keep the heartbeat alive (TTL 45s).
  useEffect(() => {
    const name = me ? (me.name ?? me.email ?? "Guest") : "Guest"
    const beat = () =>
      api
        .heartbeat(shortId, name ?? "Guest")
        .then((r) => setViewers(r.viewers))
        .catch(() => {})
    beat()
    const t = setInterval(beat, 20_000)
    return () => clearInterval(t)
  }, [shortId, me])

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
    cursor: cursors.layer,
  }
}
