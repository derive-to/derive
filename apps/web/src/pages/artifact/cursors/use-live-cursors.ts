import type { CursorFrame } from "@/lib/cursors"
import { type CursorLayerHandle, type PeerView, useCursorPaint } from "./use-cursor-paint"
import { useCursorSend } from "./use-cursor-send"

// The full live-cursor engine, composed from its two halves so each stays a focused,
// testable unit:
//  - use-cursor-send  — our own pointer → server (throttled) + the focus/idle/leave
//    state machine;
//  - use-cursor-paint — peer frames → a single rAF-driven overlay that eases toward
//    each peer's document position, with off-screen edge indicators.
// They share `selfId` — send stamps it on outgoing frames, paint uses it to ignore our
// own echoed frames. It's the viewer's STABLE presence id (a user id, or the anonymous
// guest id), the same identity the presence facepile shows — so "follow this peer" from
// the facepile lines up with the peer's cursor. Trade-off of a per-browser (not per-tab)
// id: two tabs of the same viewer share one cursor row and each filters the other as
// "self" (no second-tab cursor, no cross-tab ripple) — a fine cost for one identity.
// The page feeds pointer moves in and reads `layer` + the follow controls back out.
export type { CursorLayerHandle, PeerView, Ripple } from "./use-cursor-paint"

export function useLiveCursors(
  shortId: string,
  selfId: string,
): {
  onPointerMove: (x: number, y: number, slide?: number, sf?: number, live?: boolean) => void
  onPointerLeave: () => void
  onTap: (x: number, y: number, slide?: number, sf?: number, live?: boolean) => void
  paintFrame: (f: CursorFrame) => void
  setGeom: (g: { scrollY: number; docH: number; viewH: number }) => void
  setViewSlide: (slide: number | null) => void
  following: string | null
  followingPeer: PeerView | null
  follow: (id: string, name: string) => void
  unfollow: () => void
  setFollowScroll: (fn: ((frac: number) => void) | null) => void
  layer: CursorLayerHandle
} {
  const send = useCursorSend(shortId)
  const paint = useCursorPaint(selfId)

  return { ...send, ...paint }
}
