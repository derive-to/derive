import { useRef } from "react"
import type { CursorFrame } from "@/lib/cursors"
import { type CursorLayerHandle, useCursorPaint } from "./use-cursor-paint"
import { useCursorSend } from "./use-cursor-send"

// The full live-cursor engine, composed from its two halves so each stays a focused,
// testable unit:
//  - use-cursor-send  — our own pointer → server (throttled) + the focus/idle/leave
//    state machine;
//  - use-cursor-paint — peer frames → a single rAF-driven overlay that eases toward
//    each peer's document position, with off-screen edge indicators.
// They share only `selfId` (the stable per-tab id) — send stamps it on outgoing frames,
// paint uses it to ignore our own echoed frames. The page feeds pointer moves in and
// reads `layer` + `paintFrame`/`setGeom`/`setViewSlide` back out.
export type { CursorLayerHandle, PeerView, Ripple } from "./use-cursor-paint"

export function useLiveCursors(shortId: string): {
  onPointerMove: (x: number, y: number, slide?: number) => void
  onPointerLeave: () => void
  onTap: (x: number, y: number, slide?: number) => void
  paintFrame: (f: CursorFrame) => void
  setGeom: (g: { scrollY: number; docH: number; viewH: number }) => void
  setViewSlide: (slide: number | null) => void
  layer: CursorLayerHandle
} {
  const selfId = useRef("")
  if (!selfId.current) selfId.current = Math.random().toString(36).slice(2, 9)

  const send = useCursorSend(shortId, selfId.current)
  const paint = useCursorPaint(selfId.current)

  return { ...send, ...paint }
}
