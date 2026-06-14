import { useCallback, useEffect, useRef, useState } from "react"
import { API_BASE, api } from "@/api"

type Me = { name?: string | null; email?: string | null } | null

type CursorMsg = { id: string; name?: string; color?: string; x: number; y: number }

/**
 * Everything realtime on the artifact page, kept out of the page component:
 *  - presence ("who's viewing" — anon shows as a server handle), heartbeated;
 *  - live multiplayer cursors (Google-Docs/Figma style) — the sandboxed iframe
 *    relays pointer moves out via postMessage, we publish ours (throttled) and
 *    paint peers as an overlay over the frame;
 *  - the SSE stream that refetches comments + reloads on a new version;
 *  - one view record per open.
 *
 * The page feeds pointer moves in (`onPointerMove`, from the iframe message
 * bridge) and reads `viewers` + the `cursorLayer` ref back out.
 */
export function useArtifactLive(opts: {
  shortId: string
  me: Me
  onComment: () => void
  onVersion: () => void
}) {
  const { shortId, me, onComment, onVersion } = opts
  const [viewers, setViewers] = useState<string[]>([])

  // Stable per-tab cursor identity: a random id + a hashed hue, so peers can tell
  // cursors apart without any account.
  const cursorLayer = useRef<HTMLDivElement>(null)
  const self = useRef<{ id: string; color: string }>({ id: "", color: "" })
  if (!self.current.id) {
    const id = Math.random().toString(36).slice(2, 9)
    let h = 0
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360
    self.current = { id, color: `hsl(${h} 72% 52%)` } // tokens-ignore: per-peer identity hue (hashed), not a theme color
  }
  const xy = useRef<[number, number] | null>(null)
  const sentAt = useRef(0)
  const peers = useRef(new Map<string, HTMLDivElement>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const sendCursor = useCallback(() => {
    const pt = xy.current
    if (!pt) return
    sentAt.current = Date.now()
    fetch(`${API_BASE}/v1/artifacts/${shortId}/cursor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        id: self.current.id,
        name: me?.name ?? me?.email ?? "Guest",
        color: self.current.color,
        x: pt[0],
        y: pt[1],
      }),
    }).catch(() => {})
  }, [shortId, me])

  // The iframe forwards the local pointer; we throttle outgoing publishes.
  const onPointerMove = useCallback(
    (x: number, y: number) => {
      xy.current = [x, y]
      if (Date.now() - sentAt.current >= 45) sendCursor()
    },
    [sendCursor],
  )

  const showPeer = useCallback((d: CursorMsg) => {
    if (d.id === self.current.id) return
    const layer = cursorLayer.current
    if (!layer) return
    let el = peers.current.get(d.id)
    if (!el) {
      el = document.createElement("div")
      el.className =
        "pointer-events-none absolute left-0 top-0 z-30 transition-[transform,opacity] duration-100"
      // tokens-ignore: #fff is the fixed white cursor outline + label text (contrast on any artifact bg), not a theme color
      el.innerHTML =
        '<svg width="20" height="20" viewBox="0 0 16 20"><path d="M1 1 L1 16 L5 12.5 L8 19 L10.5 18 L7.5 11.5 L13 11.5 Z" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg><b style="position:absolute;left:13px;top:13px;padding:1px 6px;border-radius:5px;color:#fff;font:600 10.5px ui-sans-serif,system-ui;white-space:nowrap"></b>' // tokens-ignore
      layer.appendChild(el)
      peers.current.set(d.id, el)
    }
    const color = d.color || "#655999" // tokens-ignore: lavender fallback only if a peer sends no color
    const svg = el.querySelector("svg")
    if (svg) (svg as SVGElement).style.fill = color
    const tag = el.querySelector("b")
    if (tag) {
      tag.textContent = d.name || "Guest"
      ;(tag as HTMLElement).style.background = color
    }
    const r = layer.getBoundingClientRect()
    el.style.transform = `translate(${(d.x * r.width).toFixed(1)}px, ${(d.y * r.height).toFixed(1)}px)`
    el.style.opacity = "1"
    const prev = timers.current.get(d.id)
    if (prev) clearTimeout(prev)
    timers.current.set(
      d.id,
      setTimeout(() => {
        peers.current.get(d.id)?.remove()
        peers.current.delete(d.id)
        timers.current.delete(d.id)
      }, 8000),
    )
  }, [])

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
        showPeer(JSON.parse((e as MessageEvent).data))
      } catch {
        /* ignore malformed frames */
      }
    })
    return () => ev.close()
  }, [shortId, onComment, onVersion, showPeer])

  // Announce we're viewing (anon shows up by their server handle — Google-Docs
  // style), keep the heartbeat alive (TTL 45s), and re-send our cursor so a still
  // pointer doesn't fade out for peers.
  useEffect(() => {
    const name = me ? (me.name ?? me.email ?? "Guest") : "Guest"
    const beat = () =>
      api
        .heartbeat(shortId, name ?? "Guest")
        .then((r) => setViewers(r.viewers))
        .catch(() => {})
    beat()
    const t = setInterval(beat, 20_000)
    const ct = setInterval(() => {
      if (xy.current) sendCursor()
    }, 3000)
    return () => {
      clearInterval(t)
      clearInterval(ct)
    }
  }, [shortId, me, sendCursor])

  // Record one view per artifact open.
  const recorded = useRef("")
  useEffect(() => {
    if (recorded.current === shortId) return
    recorded.current = shortId
    api.recordView(shortId).catch(() => {})
  }, [shortId])

  return { viewers, cursorLayer, onPointerMove }
}
