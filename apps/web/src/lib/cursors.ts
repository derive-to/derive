// The live-cursor domain — one source of truth shared by the preference store
// (ctx), the picker, and the on-canvas overlay, so the look and the feel are
// tuned in exactly one place.
//
// Nothing here touches React or the DOM: just the vocabulary (a viewer's
// `CursorPref`, the `CursorFrame` peers exchange over the wire), the curated
// palettes a viewer chooses from, and the animation/lifecycle tuning.

export type CursorKind = "arrow" | "emoji"

/** A viewer's chosen cursor look. Persisted per-browser (see `useCursorPref`). */
export interface CursorPref {
  color: string
  kind: CursorKind
  emoji: string
  /** Opt out of the live-cursor layer: don't show peers, don't broadcast yours. */
  hidden: boolean
}

/** A cursor frame as it arrives over the SSE bus (server-shaped, sans `type`). */
export interface CursorFrame {
  id: string
  name?: string
  color?: string
  kind?: CursorKind
  emoji?: string
  /** The viewer blurred / went idle — drop their cursor now, don't wait it out. */
  gone?: boolean
  /** The viewer clicked — pulse a ripple at (x, y). */
  tap?: boolean
  /** Deck artifacts: the slide the peer is on. Peers on other slides aren't shown. */
  slide?: number
  /** The sender's scroll position, 0..1 (how far down the document they are). Rides
   *  every frame so a viewer can FOLLOW this peer — syncing their own scroll to it. */
  sf?: number
  x: number
  y: number
}

// Curated identity palette, tuned to read on both light and dark artifact
// backgrounds (the avatar identity tints' sibling). Raw hex is the point here.
export const CURSOR_COLORS = [
  "#7c6cbd",
  "#3c8f4e",
  "#d2724b",
  "#3aa6a6",
  "#b15fb0",
  "#c79a2a",
  "#5170d8",
  "#cc5d80",
] as const

// A small, friendly set — personal without the weight of a full emoji picker.
export const CURSOR_EMOJI = ["👆", "🐱", "🦊", "🚀", "✨", "🌸", "🔥", "👀", "💜", "🐙"] as const

/** Server's fallback tint when a (stale) client sends a cursor with no color. */
export const CURSOR_FALLBACK = "#655999"

const DEFAULT_EMOJI = CURSOR_EMOJI[0]

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

/** Deterministic default look for a viewer with no saved preference, seeded by
 *  their per-tab id so two strangers usually land on different colors. */
export function defaultPrefFor(seed: string): CursorPref {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return {
    color: CURSOR_COLORS[h % CURSOR_COLORS.length] ?? CURSOR_COLORS[0],
    kind: "arrow",
    emoji: DEFAULT_EMOJI,
    hidden: false,
  }
}

/** Coerce a persisted/garbage value into a valid `CursorPref`. */
export function normalizePref(raw: unknown, fallback: CursorPref): CursorPref {
  if (!raw || typeof raw !== "object") return fallback
  const r = raw as Record<string, unknown>
  return {
    color: typeof r.color === "string" ? r.color : fallback.color,
    kind: r.kind === "emoji" ? "emoji" : "arrow",
    emoji: typeof r.emoji === "string" && r.emoji ? r.emoji : fallback.emoji,
    hidden: r.hidden === true,
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
