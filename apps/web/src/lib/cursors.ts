// The live-cursor domain — one source of truth for the on-canvas overlay and the
// one preference (hide). A peer's color is NOT here and NOT on the wire: it's
// derived from their name via `colorForName` (the shared identity palette avatar
// tints draw from), keyed on the SAME server-stamped handle that names them in the
// presence roster — so each peer keeps one stable, distinct tint for the session,
// with the name tag carrying identity. No per-cursor look to pick — the design
// language rations color and forbids emoji.
//
// Nothing here touches React or the DOM: just the wire vocabulary, the one pref,
// and the animation/lifecycle tuning.

/** The one live-cursor preference. Persisted per-browser (see `useCursorPref`). */
export interface CursorPref {
  /** Opt out of the live-cursor layer: don't show peers, don't broadcast yours. */
  hidden: boolean
}

/** A cursor frame as it arrives over the SSE bus (server-shaped, sans `type`). The
 *  color/name are server-derived from identity; position is document-normalized. */
export interface CursorFrame {
  id: string
  name?: string
  /** The viewer blurred / went idle — drop their cursor now, don't wait it out. */
  gone?: boolean
  /** The viewer clicked — pulse a ripple at (x, y). */
  tap?: boolean
  /** Deck artifacts: the slide the peer is on. Peers on other slides aren't shown. */
  slide?: number
  x: number
  y: number
}

// Animation + lifecycle tuning, all in one place so "feel" is a one-file tweak.
export const CURSOR_TUNING = {
  /** Pointer easing per frame, 0..1 — higher is snappier, lower floatier. */
  lerp: 0.22,
  /** Hide the name tag after this much stillness (the cursor stays). */
  labelIdleMs: 1600,
  /** Local pointer idle this long → tell peers we've gone. */
  idleMs: 5000,
  /** Swallow a blur that's really a quick focus hop (devtools, iframe). */
  blurDebounceMs: 180,
  /** Backstop: drop a peer we've heard nothing from at all. */
  staleMs: 4000,
  /** Fade-out duration when a peer leaves / goes idle. */
  leaveFadeMs: 150,
  /** One-shot click-ripple lifetime. */
  rippleMs: 620,
  /** Outgoing cursor-publish throttle. */
  sendThrottleMs: 45,
  /** Re-publish a still (but present) pointer so peers don't time it out. */
  resendMs: 3000,
} as const

/** Coerce a persisted/garbage value into a valid `CursorPref` (only `hidden` matters). */
export function normalizePref(raw: unknown): CursorPref {
  return {
    hidden: !!raw && typeof raw === "object" && (raw as Record<string, unknown>).hidden === true,
  }
}

// ---- document-anchored placement ------------------------------------------
// A peer broadcasts a document-normalized position (x by width, y by the full
// document height). Each viewer maps it against their OWN live scroll, so a peer
// sits where they are in the document and glides as you scroll; peers scrolled
// past an edge become a top/bottom indicator instead of a cursor pinned at the
// edge. The math lives here, pure and unit-tested; the rAF loop just calls it.

/** This viewer's live geometry inside the artifact iframe. */
export interface ViewerGeom {
  scrollY: number
  docH: number
  viewH: number
}

/** Document height to map a peer's normalized y against, falling back to the
 *  visible height until the frame has reported real geometry (so a peer still
 *  shows, viewport-mapped, in the first frames after load). Never 0. */
export const effectiveDocH = (docH: number, layerH: number): number => docH || layerH || 1

export type PeerPlacement =
  | { onScreen: true; x: number; y: number }
  | { onScreen: false; side: "above" | "below"; x: number; y: number }

/** Map an eased peer position (`cx` already in layer pixels, `cyDoc` in document
 *  pixels) to a screen position in this viewer's viewport. Subtracting our scroll
 *  gives the on-screen y; past the top it's "above", past the visible height it's
 *  "below" — an off-screen peer for the edge indicator. The top/bottom edges
 *  (y === 0 and y === viewH) count as on-screen. */
export function placePeer(cx: number, cyDoc: number, geom: ViewerGeom): PeerPlacement {
  const y = cyDoc - geom.scrollY
  if (y < 0) return { onScreen: false, side: "above", x: cx, y }
  if (y > geom.viewH) return { onScreen: false, side: "below", x: cx, y }
  return { onScreen: true, x: cx, y }
}
