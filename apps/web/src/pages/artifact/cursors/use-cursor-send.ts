import { useCallback, useEffect, useRef } from "react"
import { API_BASE } from "@/api"
import { useCursorPref } from "@/ctx"
import { CURSOR_TUNING } from "@/lib/cursors"
import { guestQuery } from "@/lib/guest-id"

// The SENDING half of the live-cursor engine: our own pointer → the server (throttled),
// our chosen look, and explicit leave / tap signals — plus a focus/idle state machine so
// a blurred or idle tab stops showing a cursor at once (no cursors lingering on an
// abandoned tab). The RECEIVING half (peer frames → screen) lives in use-cursor-paint.
// We send no id: the server stamps the authoritative one (our presence identity) on every
// broadcast, so the client id was dead weight. Echo-filtering uses selfId on the paint side.
export function useCursorSend(shortId: string): {
  onPointerMove: (x: number, y: number, slide?: number) => void
  onPointerLeave: () => void
  onTap: (x: number, y: number, slide?: number) => void
} {
  const { pref } = useCursorPref()
  // Always send the latest pick without re-binding the send callbacks.
  const prefRef = useRef(pref)
  prefRef.current = pref

  // Local send + lifecycle state. `mySlide` is the deck slide WE'RE on, tagged onto
  // every frame we send (undefined off a deck, so peers never get filtered out).
  const mySlide = useRef<number | undefined>(undefined)
  const xy = useRef<[number, number] | null>(null)
  const sentAt = useRef(0)
  const live = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const send = useCallback(
    (extra: Record<string, unknown>) => {
      const pt = xy.current ?? [0, 0]
      // `?g=` so the cursor's server-derived handle matches this browser's presence row.
      fetch(`${API_BASE}/v1/artifacts/${shortId}/cursor${guestQuery()}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        keepalive: true, // so a leave fired at unload still flushes
        body: JSON.stringify({
          x: pt[0],
          y: pt[1],
          slide: mySlide.current,
          ...extra,
        }),
      }).catch(() => {})
    },
    [shortId],
  )

  // Our current look as wire fields (reads a ref, so it's stable).
  const look = useCallback(() => {
    const p = prefRef.current
    return { color: p.color, kind: p.kind, emoji: p.kind === "emoji" ? p.emoji : undefined }
  }, [])

  const sendCursor = useCallback(() => {
    if (prefRef.current.hidden) return
    sentAt.current = Date.now()
    send(look())
  }, [send, look])

  const sendLeave = useCallback(() => {
    if (!live.current) return
    live.current = false
    send({ gone: true })
  }, [send])

  const onPointerMove = useCallback(
    (x: number, y: number, slide?: number) => {
      if (prefRef.current.hidden) return
      xy.current = [x, y]
      mySlide.current = slide
      live.current = true
      if (idleTimer.current) clearTimeout(idleTimer.current)
      idleTimer.current = setTimeout(sendLeave, CURSOR_TUNING.idleMs)
      if (Date.now() - sentAt.current >= CURSOR_TUNING.sendThrottleMs) sendCursor()
    },
    [sendCursor, sendLeave],
  )

  const onPointerLeave = useCallback(() => sendLeave(), [sendLeave])

  const onTap = useCallback(
    (x: number, y: number, slide?: number) => {
      if (prefRef.current.hidden) return
      xy.current = [x, y]
      mySlide.current = slide
      live.current = true
      send({ ...look(), tap: true })
    },
    [send, look],
  )

  // Hiding opts the viewer out of the whole layer: retire our own cursor for peers
  // right away (the paint half separately drops everyone else's).
  useEffect(() => {
    if (pref.hidden) sendLeave()
  }, [pref.hidden, sendLeave])

  // Local focus/idle/leave: blur, tab-hide, idle, or unload all retire our cursor
  // for peers immediately; a slow re-send keeps a still-but-present pointer alive.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) sendLeave()
    }
    const onBlur = () => {
      if (blurTimer.current) clearTimeout(blurTimer.current)
      blurTimer.current = setTimeout(sendLeave, CURSOR_TUNING.blurDebounceMs)
    }
    const onFocus = () => {
      if (blurTimer.current) clearTimeout(blurTimer.current)
    }
    document.addEventListener("visibilitychange", onHide)
    window.addEventListener("blur", onBlur)
    window.addEventListener("focus", onFocus)
    window.addEventListener("pagehide", sendLeave)
    const resend = setInterval(() => {
      if (live.current && xy.current) sendCursor()
    }, CURSOR_TUNING.resendMs)
    return () => {
      document.removeEventListener("visibilitychange", onHide)
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("pagehide", sendLeave)
      clearInterval(resend)
      if (idleTimer.current) clearTimeout(idleTimer.current)
      if (blurTimer.current) clearTimeout(blurTimer.current)
    }
  }, [sendLeave, sendCursor])

  return { onPointerMove, onPointerLeave, onTap }
}
