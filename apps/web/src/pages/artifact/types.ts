import type { Comment } from "@/api"

// The artifact comment model, in one place: the element-anchor wire shape, the two
// anchor kinds (text quote vs element) as they arrive live from the frame (`Sel`) and
// as parsed from a stored comment (`ParsedAnchor`), the live `Selection` geometry, the
// pending `ComposerState`, and the small helpers that read a stored anchor. The pure
// margin-placement algorithm lives separately in `lib/layout.ts`.

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

// The element-anchor selector as it crosses to the iframe client (`anchors` msg).
// Mirrors core's ElementSelector; the snapshot rides along (display only — the
// client doesn't need it to resolve).
export type ElementWire = {
  type: "ElementSelector"
  tag: string
  role?: string
  id?: string
  css?: string
  fingerprint: string
  ordinal: number
  docFraction: number
  before?: string
  after?: string
  slide?: number
  snapshot?: ElementSnapshotLite
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

// The frame's live scroll geometry (its scroll offset + document/visible height).
// Delivered imperatively via `subscribeGeom` — never React state, so nothing
// re-renders per scroll frame.
export type FrameGeom = { scrollY: number; docH: number; viewH: number }

// The active text selection reported by the sandboxed artifact frame — the W3C
// selector plus its geometry, used to place the new-comment composer and its
// pin. `top` is frame-viewport-relative AT SELECTION TIME (frozen); `docTop` is
// doc-absolute (stamped at receive), the value anything that must track the
// document through later scrolling should use. Null when the selection clears.
export type Selection = {
  selector: Sel
  top: number
  docTop: number
  vTop: number
  vBottom: number
  vLeft: number
  vRight: number
} | null

// A registered agent a canned request can be handed to (the Rework ⋯ item and the
// Brandprint build request): its id + display name for the mention posted to the
// agent's MCP inbox. (The selection composer no longer pre-addresses agents — you
// @mention them by typing, like any collaborator.)
export type AgentTarget = { id: string; name: string }

// A pending new-comment composer: the anchor it pins to (null = a general, unanchored
// comment) and the DOC-ABSOLUTE Y of that anchor (null for a general comment). Doc
// coordinates, same as every pin, so the composer glides with its highlight when the
// document scrolls — a viewport Y here was the "composer parks while cards glide" bug.
export type ComposerState = {
  anchor: Sel | null
  docTop: number | null
} | null

/**
 * A slide deck's live position, and how it got here.
 *
 * `sniffed` = the artifact never claimed to be a deck; the injected client
 * recognised switched slides in the markup and reports the position on its behalf.
 * That is the majority of decks — the protocol is younger than they are — and it is
 * the difference between the presentation bar existing and not. It also decides who
 * moves the deck: a protocol deck answers the host's `deck` message itself, while a
 * sniffed one is driven by the client (see `deck-drive`).
 */
export type Deck = { i: number; total: number; sniffed: boolean }

/** A first-class HTML video's live scene and clock, reported by its own runtime or
 *  by Derive's injected client for canonical data-derive-video markup. */
export type Video = {
  i: number
  total: number
  id: string
  durationMs: number
  transition: string
  transitionMs: number
  caption: string
  playing: boolean
  elapsedMs: number
  positionMs: number
  totalDurationMs: number
  sniffed: boolean
}

// A parsed anchor — text (a quote) or element (a non-text selector), read back from a
// stored comment's `anchor` JSON (the counterpart to the live `Sel` above). Both may
// carry a `slide` (decks); `label` is the display string; `element` is the full
// selector fed to the iframe client to relocate the element.
export type ParsedAnchor = {
  exact?: string
  prefix?: string
  suffix?: string
  slide?: number
  element?: ElementWire
  label?: string
}

export function parseAnchor(a: string | null): ParsedAnchor | null {
  if (!a) return null
  try {
    const s = JSON.parse(a) as ElementWire & {
      exact?: string
      prefix?: string
      suffix?: string
    }
    if (s.type === "ElementSelector" && s.fingerprint && s.tag) {
      return { element: s, label: s.snapshot?.label ?? "Element", slide: s.slide }
    }
    return s.exact ? { exact: s.exact, prefix: s.prefix, suffix: s.suffix, slide: s.slide } : null
  } catch {
    return null
  }
}

// Per-thread element-anchor resolution quality, keyed by thread id — how surely the
// live element was re-found on this version (drives the quiet "moved" marker).
export type AnchorConf = Record<string, { band: "high" | "medium" | "low"; confidence: number }>

// Comments UI mode: full panel, collapsed rail of dots, or hidden.
export type Panel = "open" | "hidden"

// A thread positioned in the pinned margin beside its highlight. `desiredY` is
// DOC-ABSOLUTE (the highlight's top in the document) — the pin layer, not each
// card, subtracts the live scroll.
export type PinItem = { thread: Comment[]; desiredY: number; located: boolean }
