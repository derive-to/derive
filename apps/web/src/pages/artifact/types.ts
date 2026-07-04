import type { Comment } from "@/api"

// What a non-text anchor looked like when the comment was made — shown when the
// live element can no longer be found, so an orphaned comment keeps its referent.
export type ElementSnapshotLite = {
  tag: string
  label: string
  text?: string
  src?: string
  alt?: string
  w?: number
  h?: number
  html?: string
}

// A selection a comment pins to. Two shapes share this type:
//  - text  : a structural quote (`exact` + context). `slide` is set on decks only.
//  - element: a non-text anchor (`type === "ElementSelector"`) carrying the cascade
//             signals + a `snapshot`. `exact` is absent; use `selLabel` for display.
export type Sel = {
  type?: string
  exact?: string
  prefix?: string
  suffix?: string
  slide?: number
  // element-anchor fields (present when type === "ElementSelector")
  role?: string
  fingerprint?: string
  snapshot?: ElementSnapshotLite
}

/** The human label to show for a selection — the quote for text, the snapshot
 *  label (e.g. "Image — chart.png") for an element. */
export const selLabel = (s: Sel | null | undefined): string | null =>
  s?.exact ?? s?.snapshot?.label ?? null

// The active text selection reported by the sandboxed artifact frame — the W3C
// selector plus its viewport geometry, used to place the new-comment composer and its
// pin. Null when the selection clears.
export type Selection = {
  selector: Sel
  top: number
  vTop: number
  vBottom: number
  vLeft: number
  vRight: number
} | null

// A pending new-comment composer: the anchor it pins to (null = a general, unanchored
// comment) and its resolved Y in the pinned margin (null until measured).
export type ComposerState = { anchor: Sel | null; top: number | null } | null

// Per-thread element-anchor resolution quality, keyed by thread id — how surely the
// live element was re-found on this version (drives the quiet "moved" marker).
export type AnchorConf = Record<string, { band: "high" | "medium" | "low"; confidence: number }>

// Comments UI mode: full panel, collapsed rail of dots, or hidden.
export type Panel = "open" | "hidden"

// A thread positioned in the pinned margin beside its highlight.
export type PinItem = { thread: Comment[]; desiredY: number; located: boolean }
