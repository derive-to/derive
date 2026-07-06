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

// An agent the composer is pre-addressed to (the "ask an agent to revise" flow): its
// id + display name, so the request opens with `@Name ` seeded and posts a mention that
// drops into the agent's MCP pull inbox.
export type AgentTarget = { id: string; name: string }

// A pending new-comment composer: the anchor it pins to (null = a general, unanchored
// comment) and its resolved Y in the pinned margin (null until measured). `agent` is set
// when this is a revision REQUEST addressed to an agent, not a plain comment.
export type ComposerState = {
  anchor: Sel | null
  top: number | null
  agent?: AgentTarget
} | null

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

// A thread positioned in the pinned margin beside its highlight.
export type PinItem = { thread: Comment[]; desiredY: number; located: boolean }
